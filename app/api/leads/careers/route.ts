import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase";
import { syncMetaLeadToPipedrive } from "@/lib/metaLeadPipedrive";
import { normalizePhone } from "@/lib/leadIngest";
import { emailLeadAlert } from "@/lib/leadEmail";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// erehomes.ae/careers/ application -> a Pipedrive deal in the Recruitment pipeline, real time.
//
// Sibling of /api/leads/website, for the submissions that route deliberately rejects: a job
// application is not a property lead, must never round-robin to a sales agent, never reach
// the audience CRM, and never fire the property CAPI. It rides the same shared secret and
// the same recruiter round-robin the Meta ad ingest uses (lead_routes ref "Recruitment",
// Fadilah + Rochelle), so a website applicant lands on the pipeline-9 board exactly like a
// Meta one — titled (WEBSITE) instead of (META AD), with the role applied for on the card.
//
// June 2026 is why this exists: 306 applicants reached an inbox and no pipeline, and none
// were ever contacted. The site's lead-alert.php keeps emailing fedila@ + zek@ directly;
// this hop is what puts the applicant where the recruiters actually work.
//   WEBSITE_LEAD_SECRET  shared with the site's gitignored _pipedrive.php

const POOL_REF = "Recruitment";

async function pickRecruiter(): Promise<{ name: string; email: string | null } | null> {
  const db = supabaseAdmin();
  const { data: route } = await db
    .from("lead_routes").select("agent_ids, rr_pointer").eq("ref", POOL_REF).maybeSingle();
  const ids = (route?.agent_ids as string[]) || [];
  if (ids.length === 0) return null;
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
  const role = String(b.role || b.interest || "").trim();
  const message = String(b.message || "").trim();
  const page = String(b.page || b.path || "").trim();

  // Assign first, then alert, then create the deal — same order as the website route.
  // The alert goes out even with no phone: a CV with only an email is still an applicant
  // a recruiter should see, there is just no deal a caller can work from it.
  const owner = await pickRecruiter();
  const mail = await emailLeadAlert({
    channel: "Recruitment",
    recipients: owner ? [{ name: owner.name, email: owner.email }] : [],
    leadName: name || "New applicant",
    leadPhone: phone,
    leadEmail: email || null,
    enquiry: role || "Careers application",
    message: message || null,
    page: page || null,
  });

  if (!phone) return NextResponse.json({ ok: true, skipped: "no_phone", emailed: mail.sent, emailError: mail.error });

  const answers: Record<string, string> = {};
  if (role) answers["Role applied for"] = role;
  if (email) answers["Email"] = email;
  if (page) answers["Page"] = page;
  if (message) answers["Message"] = message.slice(0, 800);

  const r = await syncMetaLeadToPipedrive({
    name, e164: phone, email,
    detail: `Careers application${role ? ` — ${role}` : ""}`,
    assignedAgent: owner?.name ?? null,
    sourceValue: "Website Careers",
    kind: "Careers application",
    titlePrefix: "(WEBSITE)",
    isRecruitment: true,
    recruitmentRole: role,
    answers,
  });
  return NextResponse.json({ ...r, emailed: mail.sent, emailError: mail.error }, { status: r.ok ? 200 : 502 });
}
