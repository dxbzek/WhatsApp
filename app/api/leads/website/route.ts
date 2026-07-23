import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase";
import { syncMetaLeadToPipedrive } from "@/lib/metaLeadPipedrive";
import { normalizePhone } from "@/lib/leadIngest";

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

// Intents that are NOT a property enquiry. Checked against the intent AND the message, since
// the form's intent select is optional on some pages.
const NOT_A_LEAD = /\b(job|career|vacanc|hiring|recruit|cv|resume|internship|partnership|collaborat|invoice|supplier|vendor|sponsor|seo|marketing services|web design|backlink)\b/i;

// Round-robin across the same telesales pool the Meta + WhatsApp routes use, so website
// leads are shared out rather than piling on one person. Falls back to the env owner.
const POOL_REF = "Website";

async function pickOwner(): Promise<string | null> {
  const db = supabaseAdmin();
  const { data: route } = await db
    .from("lead_routes").select("agent_ids, rr_pointer").eq("ref", POOL_REF).maybeSingle();
  const ids = (route?.agent_ids as string[]) || [];
  if (ids.length === 0) return null;
  // Advance atomically in the DB (same RPC the other routes use) so two simultaneous
  // submissions never land on the same agent.
  const { data: ptr } = await db.rpc("next_route_rr_pointer", { p_ref: POOL_REF });
  const idx = ((((ptr as number) || 1) - 1) % ids.length + ids.length) % ids.length;
  const { data: agent } = await db.from("agents").select("name").eq("id", ids[idx]).maybeSingle();
  return (agent?.name as string) || null;
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

  // No phone = nothing a caller can act on. Say so honestly rather than creating a deal
  // nobody can work; the email alert still went out either way.
  if (!phone) return NextResponse.json({ ok: true, skipped: "no_phone" });
  if (NOT_A_LEAD.test(`${interest} ${message}`)) {
    return NextResponse.json({ ok: true, skipped: "not_a_property_enquiry" });
  }

  const answers: Record<string, string> = {};
  if (interest) answers["They are"] = interest;
  if (listing) answers["Listing"] = listing;
  if (page) answers["Page"] = page;
  if (message) answers["Message"] = message.slice(0, 800);
  if (email) answers["Email"] = email;

  const r = await syncMetaLeadToPipedrive({
    name, e164: phone, email,
    detail: `Website enquiry${page ? ` — ${page}` : ""}`,
    assignedAgent: await pickOwner(),
    sourceValue: "Website",
    kind: "Website lead",
    titlePrefix: "Website",
    answers,
  });
  return NextResponse.json(r, { status: r.ok ? 200 : 502 });
}
