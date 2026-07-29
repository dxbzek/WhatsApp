import { pd } from "@/lib/chaseList";
import type { DailyReportInput } from "@/lib/leadEmail";

// The end-of-day numbers, read from PIPEDRIVE.
//
// They used to come from this console's own `conversations` / `lead_events` tables. Both
// stopped receiving a single row at 27 Jul 2026 11:08 UTC — the minute Meta disabled the
// WhatsApp portfolio — so on 29 Jul the report read "0 new today, 226 not contacted" while
// Pipedrive took 10+ Bayut / Property Finder / AI Caller leads the same day. Every lead now
// lands in Pipedrive whatever channel it came through, so Pipedrive is the only source that
// can answer "what happened today".
//
// Same v1-vs-v2 trap as lib/chaseList.ts: `api/v2/deals` does NOT return
// done_activities_count, so the "has anyone actually called this" signal only exists on v1.
// v2 is used solely where a pipeline-wide filter is needed, and never for that count.

const PIPELINE_LEADS = 2;
// Stage 63 (Leads Pool) and 64 (Telesales Batch) are deliberately absent: a pooled deal is
// unassigned by design, so counting it as somebody "sitting on a lead" is wrong.
const WAITING_STAGES: Record<number, string> = { 6: "New Lead", 61: "No Answer", 7: "Contact made" };
// Reaching any of these is the lead being progressed, which is what "qualified" means here.
const PROGRESSED_STAGES = new Set([8, 9, 10, 11, 19]);
// How far back a lead still counts as live for this report. Override with REPORT_WINDOW_DAYS.
const MAX_AGE_DAYS = Number(process.env.REPORT_WINDOW_DAYS || 14);

const clean = (v?: string | null) => (v || "").trim();

// The two API versions return DIFFERENT timestamp formats and this must handle both:
// v1 gives "2026-07-29 12:57:19" (UTC, no zone marker — parsed as-is it is read as LOCAL,
// which in Dubai makes every age 4h wrong), v2 gives "2026-07-29T12:57:19Z". Appending a
// blind "Z" to the v2 form yields "…ZZ", which is NaN — that silently reported 0 new leads
// on a day Pipedrive took 10.
function parseUtc(s?: string | null): number {
  const raw = String(s || "").trim();
  if (!raw) return 0;
  const iso = /[Zz]$|[+-]\d{2}:?\d{2}$/.test(raw) ? raw : raw.replace(" ", "T") + "Z";
  const t = Date.parse(iso);
  return Number.isFinite(t) ? t : 0;
}

type Deal = { id: number; add_time: string; stage_id: number; done_activities_count?: number; user_id?: { name?: string } };

// Every open deal in the waiting stages. Paged to exhaustion — stage 61 alone holds 100+,
// and a truncated read would silently under-report the backlog.
async function openWaitingDeals(): Promise<Deal[]> {
  const out: Deal[] = [];
  for (const stageId of Object.keys(WAITING_STAGES).map(Number)) {
    for (let start = 0; start < 2000; start += 100) {
      const d: any = await pd("v1/deals", { stage_id: String(stageId), status: "open", limit: "100", start: String(start) });
      out.push(...((d?.data || []) as Deal[]));
      if (!d?.additional_data?.pagination?.more_items_in_collection) break;
    }
  }
  return out;
}

export async function collectDailyReport(): Promise<DailyReportInput> {
  const dayAgo = Date.now() - 86400_000;

  // Flow: what arrived and what moved forward in the last 24h. v2 because it is the only
  // version that filters by pipeline, and neither number needs done_activities_count.
  let newLeads = 0;
  let qualified = 0;
  for (let page = 0, cursor = ""; page < 10; page++) {
    const params: Record<string, string> = {
      pipeline_id: String(PIPELINE_LEADS), limit: "100", sort_by: "update_time", sort_direction: "desc",
      updated_since: new Date(dayAgo).toISOString().replace(/\.\d+Z$/, "Z"),
    };
    if (cursor) params.cursor = cursor;
    const d: any = await pd("api/v2/deals", params);
    const batch: any[] = d?.data || [];
    for (const deal of batch) {
      if (parseUtc(deal.add_time) >= dayAgo) newLeads++;
      if (PROGRESSED_STAGES.has(Number(deal.stage_id)) && parseUtc(deal.stage_change_time) >= dayAgo) qualified++;
    }
    cursor = d?.additional_data?.next_cursor || "";
    if (!cursor) break;
  }

  // Stock: who is sitting on what, right now. done_activities_count is the honest signal —
  // an agent can drag a card to No Answer without ever dialling, so stage alone lies.
  const deals = await openWaitingDeals();
  const uncalled = deals.filter((d) => (d.done_activities_count || 0) === 0);
  const awaitingOutcome = deals.length - uncalled.length;

  // Age window, same reasoning as the chase list: stage 61 and 7 hold hundreds of legacy
  // telesales rows from months back. Counting those makes the headline 883, which nobody
  // can act on and which barely moves day to day, so the report stops being read. Recent
  // leads drive the numbers; the older backlog gets one honest line of its own rather than
  // being silently dropped.
  const windowStart = Date.now() - MAX_AGE_DAYS * 86400_000;
  const notContacted = uncalled.filter((d) => parseUtc(d.add_time) >= windowStart);
  const olderBacklog = uncalled.length - notContacted.length;

  const byOwner = new Map<string, { waiting: number; oldest: number | null }>();
  for (const d of notContacted) {
    const name = clean(d.user_id?.name) || "Unassigned";
    const cur = byOwner.get(name) || { waiting: 0, oldest: null };
    cur.waiting++;
    const t = parseUtc(d.add_time);
    if (t) {
      const h = (Date.now() - t) / 3600_000;
      if (cur.oldest === null || h > cur.oldest) cur.oldest = h;
    }
    byOwner.set(name, cur);
  }
  const perAgent = [...byOwner].map(([name, v]) => ({ name, waiting: v.waiting, oldestHours: v.oldest }))
    .sort((a, b) => b.waiting - a.waiting);

  const date = new Date().toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "Asia/Dubai" });
  return { date, newLeads, qualified, awaitingFirst: notContacted.length, awaitingOutcome, perAgent, olderBacklog, windowDays: MAX_AGE_DAYS };
}
