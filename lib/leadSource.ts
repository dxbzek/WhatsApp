// ONE definition of "where did this lead come from" and "has anyone touched it".
//
// This file is deliberately the only place these rules live. The qualified-lead
// definition was hardcoded in three separate files once (email report, sheet
// report, CAPI route) and drifted, so Meta's own column sat blank while two
// reports disagreed. Every Command Centre surface imports from here.
//
// WHY TITLES: Pipedrive's custom Source field is blank on 78.5% of deals (probed
// 12 Aug 2026 over 8,043 deals in 30 days) and showed ONE website lead in a
// month. Portal leads created by the Make scenarios carry no Source value at
// all — their only marker is the title prefix the scenario writes. So the field
// is read FIRST where present (it was set deliberately by our own code) and the
// title is the fallback. As Make scenarios get updated to stamp the field, this
// file needs no change: accuracy improves underneath it.
//
// WHITELIST, NEVER BLACKLIST. Every pattern names a source we KNOW is an inbound
// inquiry. Anything unmatched becomes UNCLASSIFIED and is shown on the page with
// its own count — a new lead type can never be silently absorbed into a channel,
// and "0 unclassified" can never look identical to "the classifier never ran".

export type LeadKind = "INBOUND" | "BULK" | "UNCLASSIFIED";

export type LeadClass = { kind: LeadKind; source: string };

// Pipedrive custom field keys (ERE Homes).
export const F_SOURCE = "be1b1fe6b64aad751a7a9649876a671db3f03215"; // Source (varchar)

// Property pipeline. Recruitment (9) is a different funnel with its own
// definition of qualified and must never be blended into property CPL/CPQL.
export const PIPELINE_PROPERTY = 2;
export const PIPELINE_RECRUITMENT = 9;

// Qualified = the deal reached Qualified or beyond. Set by Zek 24 Jul 2026:
// the source of truth is the LIVE PIPEDRIVE STAGE, not any console tag.
export const QUALIFIED_STAGES = new Set([8, 9, 10, 11, 19]);
// Recruitment equivalent: Interview / Offer / Joined.
export const QUALIFIED_STAGES_RECRUITMENT = new Set([67, 68, 69]);

// Checked BEFORE the inbound list, because these titles contain inbound-looking
// words. The AI dialler rings OUR OWN list, so an "AI Caller no answer" row is
// an outbound call that failed, not somebody contacting us. 257 of them were
// created in one batch on 13 Aug 2026 and read as 257 fresh untouched leads —
// the tile said 270 leads / 244 untouched on a day with 14 real inquiries.
const OUTBOUND_PATTERNS: [string, RegExp][] = [
  ["AI caller no answer", /\bai\s*call(er)?\b[^|]*\bno\s*answer\b|\bno\s*answer\b[^|]*\bai\s*call(er)?\b/i],
  ["AI caller voicemail", /\bai\s*call(er)?\b[^|]*\b(voicemail|machine)\b/i],
];

// Ordered; first match wins. Derived from live deal titles on 12 Aug 2026.
const INBOUND_PATTERNS: [string, RegExp][] = [
  ["Bayut", /^\s*bayut\b/i],
  ["Property Finder", /^\s*(pf|property\s*finder)\b/i],
  ["Meta Ad", /^\s*meta\s*ad\b/i],
  ["Website", /^\s*(website|web enquiry|erehomes\.ae)\b/i],
  ["WhatsApp", /^\s*whatsapp\b/i],
  // The markers below sit MID-title: the Make scenarios and ManyChat write
  // "<person name> - <marker>". A prefix-only whitelist missed 1,208 rows on
  // the first probe, including real Instagram and AI-caller inquiries.
  ["AI Caller", /\bai\s*call(er)?\b/i],
  ["Instagram DM", /\b(ig dm|instagram dm|manychat)\b/i],
  // Portal CALL leads and any title carrying a portal listing reference.
  ["Property Finder", /\b(e(h|re)-pf-\d+|pf missed call)\b/i],
  ["Bayut", /\bby-\d{3,}\b/i],
  ["Call", /^\s*call\s*-\s*listing\b|^\s*(call lead|inbound call)\b/i],
];

// Known BULK loads: owner/telesales list uploads. A person's name plus a project
// name. These are OUTBOUND lists we bought or built, never inquiries — counting
// them as leads would put four figures in a tile that means "people who
// contacted us today" (2,959 of 3,783 deals in 14 days were exactly this).
const BULK_PATTERNS: [string, RegExp][] = [
  ["Telesales batch", /\b(damac|psi|chelsea|zenon)\b/i],
  ["Owner list upload", /\bmudon\b|\(owner\)/i],
];

/** Read the Source custom field off a v1 or v2 deal shape. */
export function sourceField(deal: any): string {
  const v1 = deal?.[F_SOURCE];
  if (typeof v1 === "string" && v1.trim()) return v1.trim();
  const cf = deal?.custom_fields?.[F_SOURCE];
  if (typeof cf === "string" && cf.trim()) return cf.trim();
  if (cf && typeof cf === "object" && typeof cf.value === "string" && cf.value.trim()) {
    return cf.value.trim();
  }
  return "";
}

/** Classify one deal into an inbound source, a bulk load, or unclassified. */
export function classifyDeal(deal: any): LeadClass {
  const title = String(deal?.title || "");
  const src = sourceField(deal);

  // Outbound is tested FIRST and beats even the Source field: a row can carry
  // Source="AI Caller" and still be a call we placed that nobody answered.
  for (const [label, rx] of OUTBOUND_PATTERNS) {
    if (rx.test(title)) return { kind: "BULK", source: label };
  }
  if (src) {
    // "PSI Damac Hills" / "PSI Chelsea Residences" are batch labels, not sources.
    if (/^psi\b/i.test(src)) return { kind: "BULK", source: "Telesales batch" };
    return { kind: "INBOUND", source: src };
  }
  for (const [label, rx] of INBOUND_PATTERNS) {
    if (rx.test(title)) return { kind: "INBOUND", source: label };
  }
  for (const [label, rx] of BULK_PATTERNS) {
    if (rx.test(title)) return { kind: "BULK", source: label };
  }
  return { kind: "UNCLASSIFIED", source: "Unclassified" };
}

// Accounts that are NOT people. Every inbound deal is created by the automation
// with 1-4 notes already attached and often a scheduled activity, so
// `notes_count > 0` and `activities_count > 0` are ALWAYS true at creation —
// measured live 12 Aug 2026 across every deal created that day. Building
// "untouched" on those counts produced a permanently dead tile reading 0, a
// detector measuring intended behaviour rather than agent work.
export const AUTOMATION_USER_IDS = new Set([
  25681536, // ERE Marketing (marketing@) — the integration that writes lead notes
  25143735, // ERE Homes-Admin (admin@) — bulk scripts and integrations
]);

// Stages that mean nobody has acted yet. Anything beyond these is a human
// having moved the card — including No Answer(61), which means someone tried.
export const ENTRY_STAGES = new Set([6, 63, 64]); // New Lead, Leads Pool, Telesales Batch

/**
 * Has a HUMAN worked this deal?
 *
 * "worked = human notes UNION card moves UNION completed activities" — the same
 * shape the telesales daily report uses, so the two surfaces cannot disagree.
 * Keying on notes alone once marked half of Joshua's real work as untouched (72
 * notes against 138 stage moves) and turned a report into an accusation.
 *
 * `humanNotedDealIds` is built once per request from a single windowed
 * /notes call filtered by author, never one call per deal.
 *
 * `stage_change_time` is deliberately NOT used: live rows carry values EARLIER
 * than their own add_time (deal 9537: added 12:28, stage_change 08:35), because
 * a deal converted from an existing lead inherits the older stamp. A signal that
 * can precede creation cannot prove anything happened after it.
 */
export function isTouched(deal: any, humanNotedDealIds?: Set<number>): boolean {
  if (!ENTRY_STAGES.has(Number(deal?.stage_id))) return true;
  // last_activity_date is set only by a COMPLETED activity — an agent marking a
  // call done. A merely scheduled activity (which the automation creates) does
  // not set it, which is exactly why activities_count is unusable here.
  if (deal?.last_activity_date) return true;
  if (humanNotedDealIds?.has(Number(deal?.id))) return true;
  return false;
}

/** Is this deal qualified, by the live stage, in its own pipeline's terms? */
export function isQualified(deal: any): boolean {
  const stage = Number(deal?.stage_id);
  const pipe = Number(deal?.pipeline_id);
  if (pipe === PIPELINE_RECRUITMENT) return QUALIFIED_STAGES_RECRUITMENT.has(stage);
  return QUALIFIED_STAGES.has(stage);
}
