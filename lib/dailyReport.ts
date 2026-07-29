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
// Reaching any of these means somebody moved the lead forward. Closed Won (19) is in here;
// Closed Lost is counted separately, because a day of 20 losses is not a day of 20 wins.
const PROGRESSED_STAGES = new Set([8, 9, 10, 11, 19]);
const STAGE_CLOSED_LOST = 18;
// Deals CREATED into these are the daily telesales allocation moving records around, not
// somebody enquiring. Counting them as new leads doubled the headline on 29 Jul.
const POOL_STAGES = new Set([63, 64]);
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

type Deal = { id: number; add_time: string; stage_id: number; done_activities_count?: number; user_id?: { id?: number; name?: string } };

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
  // version that filters by pipeline, and none of these need done_activities_count.
  //
  // "New" is split on purpose. On 29 Jul the raw count was 60, but 27 of those were deals
  // created straight into Telesales Batch / Leads Pool by the daily allocation — an internal
  // bulk move, not somebody enquiring. Reporting 60 as new leads overstates inbound by ~2x
  // and makes the day look twice as good as it was.
  let newInbound = 0;
  let newPooled = 0;
  let progressed = 0;
  let lost = 0;
  // Per owner, because a head of sales needs the row, not the total: the same 33 new leads
  // read completely differently split 20/1/1 across the team than shared evenly.
  const ownerFlow = new Map<number, { newToday: number; progressed: number; lost: number }>();
  const bumpFlow = (id: number, k: "newToday" | "progressed" | "lost") => {
    const cur = ownerFlow.get(id) || { newToday: 0, progressed: 0, lost: 0 };
    cur[k]++;
    ownerFlow.set(id, cur);
  };
  for (let page = 0, cursor = ""; page < 10; page++) {
    const params: Record<string, string> = {
      pipeline_id: String(PIPELINE_LEADS), limit: "100", sort_by: "update_time", sort_direction: "desc",
      updated_since: new Date(dayAgo).toISOString().replace(/\.\d+Z$/, "Z"),
    };
    if (cursor) params.cursor = cursor;
    const d: any = await pd("api/v2/deals", params);
    const batch: any[] = d?.data || [];
    for (const deal of batch) {
      const stage = Number(deal.stage_id);
      const owner = Number(deal.owner_id) || 0;
      if (parseUtc(deal.add_time) >= dayAgo) {
        if (POOL_STAGES.has(stage)) newPooled++;
        else { newInbound++; bumpFlow(owner, "newToday"); }
      }
      if (parseUtc(deal.stage_change_time) >= dayAgo) {
        if (PROGRESSED_STAGES.has(stage)) { progressed++; bumpFlow(owner, "progressed"); }
        else if (stage === STAGE_CLOSED_LOST) { lost++; bumpFlow(owner, "lost"); }
      }
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

  // One row per owner, keyed on the Pipedrive user id so the flow pass (v2, which returns
  // owner_id only) and the stock pass (v1, which returns user_id.name) line up. Keying on
  // the NAME would silently split an owner whose name renders differently between versions.
  type Row = {
    id: number; name: string;
    newToday: number; uncalled: number; uncalledToday: number;
    calledOpen: number; progressed: number; lost: number; oldestHours: number | null;
  };
  const rows = new Map<number, Row>();
  const row = (id: number, name?: string): Row => {
    const r = rows.get(id) || { id, name: name || "", newToday: 0, uncalled: 0, uncalledToday: 0, calledOpen: 0, progressed: 0, lost: 0, oldestHours: null };
    if (name && !r.name) r.name = name;
    rows.set(id, r);
    return r;
  };

  for (const d of notContacted) {
    const r = row(Number(d.user_id?.id) || 0, clean(d.user_id?.name));
    r.uncalled++;
    const t = parseUtc(d.add_time);
    if (t) {
      const h = (Date.now() - t) / 3600_000;
      if (r.oldestHours === null || h > r.oldestHours) r.oldestHours = h;
      if (t >= dayAgo) r.uncalledToday++;
    }
  }
  for (const d of deals) {
    if ((d.done_activities_count || 0) === 0) continue;
    if (parseUtc(d.add_time) < windowStart) continue;
    row(Number(d.user_id?.id) || 0, clean(d.user_id?.name)).calledOpen++;
  }
  for (const [id, f] of ownerFlow) {
    const r = row(id);
    r.newToday = f.newToday; r.progressed = f.progressed; r.lost = f.lost;
  }

  // Names only exist on the v1 rows, so anyone who ONLY appears in the flow pass (took a new
  // lead today and has nothing sitting) has no name yet. One /users read fills those in
  // rather than printing a raw id, which no reader can act on.
  const missing = [...rows.values()].filter((r) => !r.name);
  if (missing.length) {
    const u: any = await pd("v1/users");
    const nameById = new Map<number, string>(((u?.data || []) as any[]).map((x) => [Number(x.id), clean(x.name)]));
    for (const r of missing) r.name = nameById.get(r.id) || "Unassigned";
  }

  // Worst first: never-called count is the number a head of sales acts on, then today's
  // volume as the tiebreak.
  const perAgent = [...rows.values()]
    .filter((r) => r.uncalled || r.calledOpen || r.newToday || r.progressed || r.lost)
    .sort((a, b) => b.uncalled - a.uncalled || b.newToday - a.newToday)
    .map((r) => ({
      name: r.name || "Unassigned",
      newToday: r.newToday,
      waiting: r.uncalled,
      uncalledToday: r.uncalledToday,
      calledOpen: r.calledOpen,
      progressed: r.progressed,
      lost: r.lost,
      oldestHours: r.oldestHours,
    }));

  const date = new Date().toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "Asia/Dubai" });
  return {
    date, newLeads: newInbound, newPooled, qualified: progressed, lost,
    awaitingFirst: notContacted.length, awaitingOutcome, perAgent,
    uncalledToday: perAgent.reduce((n, r) => n + r.uncalledToday, 0),
    olderBacklog, windowDays: MAX_AGE_DAYS,
  };
}
