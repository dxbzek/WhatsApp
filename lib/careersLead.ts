import { supabaseAdmin } from "@/lib/supabase";
import { syncMetaLeadToPipedrive } from "@/lib/metaLeadPipedrive";
import { emailLeadAlert } from "@/lib/leadEmail";

// One place that turns a job application into a Recruitment-pipeline deal, used by BOTH
// the /careers/ form and the general website form (where somebody types "do you have any
// vacancies" into the contact box and would otherwise be binned as not-a-property-lead).
// Zek, 26 Aug 2026: "Job applications should be direct to recruitment".
//
// June 2026 is why this exists at all: 306 applicants reached an inbox and no pipeline, and
// none were ever contacted.

const POOL_REF = "Recruitment";

export async function pickRecruiter(): Promise<{ name: string; email: string | null } | null> {
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

export async function routeCareersApplication(a: {
  name: string;
  email: string;
  phone: string | null;
  role: string;
  message: string;
  page: string;
  sourceValue?: string;
}) {
  // Assign first, then alert, then create the deal — same order as the website route.
  // The alert goes out even with no phone: a CV with only an email is still an applicant a
  // recruiter should see, there is just no deal a caller can work from it.
  const owner = await pickRecruiter();
  const mail = await emailLeadAlert({
    channel: "Recruitment",
    recipients: owner ? [{ name: owner.name, email: owner.email }] : [],
    leadName: a.name || "New applicant",
    leadPhone: a.phone,
    leadEmail: a.email || null,
    enquiry: a.role || "Careers application",
    message: a.message || null,
    page: a.page || null,
  });

  if (!a.phone) {
    return { body: { ok: true, skipped: "no_phone", emailed: mail.sent, emailError: mail.error }, status: 200 };
  }

  const answers: Record<string, string> = {};
  if (a.role) answers["Role applied for"] = a.role;
  if (a.email) answers["Email"] = a.email;
  if (a.page) answers["Page"] = a.page;
  if (a.message) answers["Message"] = a.message.slice(0, 800);

  const r = await syncMetaLeadToPipedrive({
    name: a.name, e164: a.phone, email: a.email,
    detail: `Careers application${a.role ? ` — ${a.role}` : ""}`,
    assignedAgent: owner?.name ?? null,
    sourceValue: a.sourceValue || "Website Careers",
    kind: "Careers application",
    titlePrefix: "(WEBSITE)",
    isRecruitment: true,
    recruitmentRole: a.role,
    answers,
  });
  return { body: { ...r, emailed: mail.sent, emailError: mail.error }, status: r.ok ? 200 : 502 };
}
