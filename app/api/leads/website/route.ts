import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase";
import { syncMetaLeadToPipedrive } from "@/lib/metaLeadPipedrive";
import { normalizePhone } from "@/lib/leadIngest";
import { emailLeadAlert } from "@/lib/leadEmail";
import { classifyEnquiry } from "@/lib/leadSpam";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// erehomes.ae form submissions -> a real Pipedrive deal, in real time.
//
// The website's own Supabase project is unreachable from anywhere but the site, and the
// Pipedrive token must not sit on the web server, so lead-alert.php POSTs here (creds stay
// in Vercel) with a shared secret. Same shape as the GA4/Meta CAPI hops it already makes.
//
// Only GENUINE buyer/seller enquiries become deals (Zek, 23 Jul 2026: "if its genuine buyers
// and sellers then we can cater them"). A career/partnership/vendor enquiry is not a lead;
// neither is a submission with no way to reach the person back.
//   WEBSITE_LEAD_SECRET  shared with the site's gitignored _pipedrive.php

// What counts as "not a property enquiry" now lives in lib/leadSpam.ts, which scores a
// submission instead of matching one flat word list, and records every rejection.

// Round-robin across the same telesales pool the Meta + WhatsApp routes use, so website
// leads are shared out rather than piling on one person. Falls back to the env owner.
const POOL_REF = "Website";

async function pickOwner(): Promise<{ name: string; email: string | null } | null> {
  const db = supabaseAdmin();
  const { data: route } = await db
    .from("lead_routes").select("agent_ids, rr_pointer").eq("ref", POOL_REF).maybeSingle();
  const ids = (route?.agent_ids as string[]) || [];
  if (ids.length === 0) return null;
  // Advance atomically in the DB (same RPC the other routes use) so two simultaneous
  // submissions never land on the same agent.
  const { data: ptr } = await db.rpc("next_route_rr_pointer", { p_ref: POOL_REF });
  const idx = ((((ptr as number) || 1) - 1) % ids.length + ids.length) % ids.length;
  const { data: agent } = await db.from("agents").select("name, email").eq("id", ids[idx]).maybeSingle();
  if (!agent?.name) return null;
  return { name: agent.name as string, email: (agent.email as string) || null };
}

export async function POST(req: NextRequest) {
  const secret = process.env.WEBSITE_LEAD_SECRET;
  if (!secret) return NextResponse.json({ error: "not configured" }, { status: 503 });
  if (req.headers.get("x-lead-secret") !== secret) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const b = await req.json().catch(() => ({} as any));
  const name = String(b.name || "").trim();
  const email = String(b.email || "").trim();
  const phone = normalizePhone(String(b.phone || ""));
  const interest = String(b.interest || "").trim();
  const message = String(b.message || "").trim();
  const page = String(b.page || b.path || "").trim();
  const listing = String(b.listing || "").trim();

  // Not a property enquiry (a vendor pitch, a job application, an SEO offer). No deal, no
  // alert, nobody's time — but it is KEPT in site_lead_spam with the reasons it was judged
  // on, so a wrong call can be seen and rescued rather than vanishing.
  const verdict = classifyEnquiry({ interest, message, email });
  if (verdict.spam) {
    await supabaseAdmin().from("site_lead_spam").insert({
      name: name || null, phone: phone || null, email: email || null,
      interest: interest || null, page: page || null, listing: listing || null,
      message: message || null, reasons: verdict.reasons, score: verdict.score,
    });
    return NextResponse.json({ ok: true, skipped: "not_a_property_enquiry", reasons: verdict.reasons });
  }

  // Assign first, then alert, then create the deal. The alert is sent BEFORE the
  // no-phone gate: a genuine enquiry that left only an email is still a lead a human
  // should see, even though there is no deal to create from it.
  const owner = await pickOwner();
  const mail = await emailLeadAlert({
    channel: "Website",
    recipients: owner ? [{ name: owner.name, email: owner.email }] : [],
    leadName: name || "New enquiry",
    leadPhone: phone,
    leadEmail: email || null,
    enquiry: [interest, listing].filter(Boolean).join(" · ") || null,
    message: message || null,
    page: page || null,
  });

  // No phone = nothing a caller can act on. Say so honestly rather than creating a deal
  // nobody can work. The alert above already went out.
  if (!phone) return NextResponse.json({ ok: true, skipped: "no_phone", emailed: mail.sent, emailError: mail.error });

  const answers: Record<string, string> = {};
  if (interest) answers["They are"] = interest;
  if (listing) answers["Listing"] = listing;
  if (page) answers["Page"] = page;
  if (message) answers["Message"] = message.slice(0, 800);
  if (email) answers["Email"] = email;

  const r = await syncMetaLeadToPipedrive({
    name, e164: phone, email,
    detail: `Website enquiry${page ? ` — ${page}` : ""}`,
    assignedAgent: owner?.name ?? null,
    sourceValue: "Website",
    kind: "Website lead",
    titlePrefix: "Website",
    answers,
  });
  return NextResponse.json({ ...r, emailed: mail.sent, emailError: mail.error }, { status: r.ok ? 200 : 502 });
}
