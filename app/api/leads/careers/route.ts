import { NextRequest, NextResponse } from "next/server";
import { normalizePhone } from "@/lib/leadIngest";
import { routeCareersApplication } from "@/lib/careersLead";

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

// The recruiter round-robin and the deal creation live in lib/careersLead.ts, so the
// general website form can send an applicant down the identical path.

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

  const res = await routeCareersApplication({ name, email, phone, role, message, page });
  return NextResponse.json(res.body, { status: res.status });
}
