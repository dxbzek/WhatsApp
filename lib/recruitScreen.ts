// One place that decides an applicant has ruled THEMSELVES out on the form, so the
// recruiter never spends a call on it. Zek, 12 Aug 2026: "In any case that we are
// receiving no in this field ... I can put them at the rejected column so there will
// be no time waste."
//
// The form question is "This role is commission-only (55-70% split), with no basic
// salary. Is that OK?" with a bare Yes / No (form v6, 07 Aug 2026). A "No" is a door,
// not a preference — there is nothing to negotiate, the role has no basic salary.
//
// `answers` is keyed by the QUESTION LABEL (metaLeads maps Meta's key -> label from the
// form itself), but the label lookup is best-effort and falls back to the raw key
// `commission_ok`, so both shapes are matched.
//
// Deliberately fails OPEN: anything that is not clearly a no leaves the applicant in
// New Applicant for a human. A false reject costs a real agent we paid for; a false
// pass costs one phone call.
export const RECRUITMENT_REJECTED_STAGE_ID = 71;   // pipeline 9 "Rejected"

const isCommissionQuestion = (label: string) =>
  /commission/i.test(label) || /basic\s*salary/i.test(label);

// "No" · "No, I need a basic salary" (form v5) · "no." — but never "None yet", which is
// an answer to a DIFFERENT question (which Dubai market do you know best).
const isNo = (value: string) => /^no\b/i.test(value.trim()) || /^no[.,!]/i.test(value.trim());

/** True when the applicant answered NO to the commission-only question. */
export function commissionDeclined(answers?: Record<string, string> | null): boolean {
  if (!answers) return false;
  return Object.entries(answers).some(
    ([label, value]) => isCommissionQuestion(String(label)) && isNo(String(value ?? "")),
  );
}

/** The line stamped on the Pipedrive note so the recruiter sees WHY it is in Rejected. */
export const AUTO_REJECT_NOTE =
  "<b>Auto-rejected:</b> answered NO to commission-only on the form. No call needed.";
