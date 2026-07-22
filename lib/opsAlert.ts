import { supabaseAdmin } from "@/lib/supabase";
import { sendTemplate } from "@/lib/twilio";

// Ops/system alerts to the lead-gen owner. Both templates are UTILITY on the utility
// subaccount (approved 22 Jul 2026), so they are exempt from marketing caps and always
// reach the owner. "Open the ERE console" is a valid CTA here ONLY because these go to
// Zek — every other role has no console access (see agent-alert rules).
//
// ere_ops_alert vars: {{1}} alert type, {{2}} detail, {{3}} record, {{4}} when (Dubai).
const OPS_ALERT_SID = (process.env.OPS_ALERT_SID || "HXd173408bdf7eecf514058e9c85a24dd2").trim();
// ere_lead_daily_digest vars: {{1}} date, {{2}} new leads, {{3}} qualified,
// {{4}} awaiting first contact, {{5}} awaiting outcome.
const LEAD_DAILY_DIGEST_SID = (process.env.LEAD_DAILY_DIGEST_SID || "HX1b171d57dbb172aa8ccf755f8382703d").trim();

// Same monitor list every lead alert is CC'd to (distribution.ts) — the ops owner.
const OPS_ALERT_WA = (process.env.LEAD_TRACKER_WA || "+971524766133")
  .split(",").map((s) => s.trim()).filter(Boolean);

const dubaiStamp = () =>
  new Date().toLocaleString("en-GB", { day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit", timeZone: "Asia/Dubai" });

// Send one ops alert, deduped by (type, key) via the ops_log UNIQUE constraint so a
// 30-minute cron can never re-alert the same record. Claim the key FIRST (losing an
// occasional alert to a race beats spamming every pass); if no recipient accepted the
// send, release the claim so the next pass retries instead of going silent forever.
export async function sendOpsAlertOnce(
  db: ReturnType<typeof supabaseAdmin>,
  type: string, key: string, detail: string, record: string,
): Promise<boolean> {
  try {
    const ins = await db.from("ops_log").insert({ type, key });
    if (ins.error) return false; // already alerted (unique violation) — or DB down, either way skip
    let sent = false;
    for (const wa of OPS_ALERT_WA) {
      try {
        await sendTemplate(wa, OPS_ALERT_SID, { "1": type, "2": detail, "3": record, "4": dubaiStamp() });
        sent = true;
      } catch { /* per-recipient best-effort */ }
    }
    if (!sent) await db.from("ops_log").delete().eq("type", type).eq("key", key);
    return sent;
  } catch {
    return false;
  }
}

// One digest per Dubai day, same claim-then-send-then-release pattern as above.
export async function sendDailyDigestOnce(
  db: ReturnType<typeof supabaseAdmin>,
  dateKey: string,
  counts: { date: string; newLeads: number; qualified: number; awaitingFirst: number; awaitingOutcome: number },
): Promise<boolean> {
  try {
    const ins = await db.from("ops_log").insert({ type: "daily_digest", key: dateKey });
    if (ins.error) return false;
    let sent = false;
    for (const wa of OPS_ALERT_WA) {
      try {
        await sendTemplate(wa, LEAD_DAILY_DIGEST_SID, {
          "1": counts.date,
          "2": String(counts.newLeads),
          "3": String(counts.qualified),
          "4": String(counts.awaitingFirst),
          "5": String(counts.awaitingOutcome),
        });
        sent = true;
      } catch { /* per-recipient best-effort */ }
    }
    if (!sent) await db.from("ops_log").delete().eq("type", "daily_digest").eq("key", dateKey);
    return sent;
  } catch {
    return false;
  }
}
