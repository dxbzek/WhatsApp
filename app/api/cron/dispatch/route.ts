import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase";
import { sendTemplate, getMessageStatus } from "@/lib/twilio";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

// Per-run cap + a hard wall-clock budget. Each send is 250ms throttle + Twilio
// latency (~0.5-1.5s), so we claim a modest batch and also stop at DEADLINE_MS,
// releasing anything we didn't reach back to 'scheduled'. With a 5-min cron this
// is ~300+/hour steady — well above any drip pace, and never risks the 60s kill.
const CAP = 25;
const DEADLINE_MS = 45000; // leave headroom under maxDuration=60
const THROTTLE_MS = 250;
const SUPPRESSED = ["blocked", "invalid"];

// Reconcile pass: rows with a twilio_sid that are stuck at 'scheduled' were created
// via Twilio's own scheduler (we never send those). Twilio knows their real fate
// (sent/delivered/failed/canceled) but never tells us unless we ask, so without this
// they freeze at 'scheduled' forever and the UI lies. Sync a small capped batch each
// run, time-boxed so it never starves the send loop.
const RECONCILE_CAP = 40;
const RECONCILE_BUDGET_MS = 12000;
const RECONCILE_THROTTLE_MS = 60;
const INVALID_NUMBER_CODES = ["63024", "63003", "21211", "21614"];

// Send every drip message that has come due. Claims a capped batch of
// status='scheduled' rows whose scheduled_at <= now, marks them 'sending' (so
// overlapping runs can't double-send), pushes each to Twilio immediately, and
// records the real result. Secured by CRON_SECRET (pg_cron passes it as a
// header). GET and POST both work so it's easy to trigger from anywhere.
async function run(req: NextRequest) {
  const secret = process.env.CRON_SECRET;
  if (!secret) return NextResponse.json({ error: "CRON_SECRET not configured" }, { status: 503 });
  const provided = req.headers.get("x-cron-secret") || new URL(req.url).searchParams.get("key") || "";
  if (provided !== secret) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const db = supabaseAdmin();

  // #8: Global single-flight. The per-run CAP + 250ms throttle only pace ONE run;
  // if a slow run overlaps the next cron tick, the global send rate doubles. A
  // session-level pg advisory lock lets only one dispatch run proceed at a time;
  // a second concurrent run bails out immediately. The lock is auto-released when
  // this connection closes, and we also release it explicitly in `finally`.
  const { data: gotLock, error: lockErr } = await db.rpc("try_dispatch_lock");
  if (lockErr) {
    // Lock helper missing/failed — log and continue rather than freeze the drip.
    // eslint-disable-next-line no-console
    console.warn("[dispatch] try_dispatch_lock failed, running without global lock:", lockErr.message);
  } else if (gotLock === false) {
    return NextResponse.json({ skippedRun: "locked" });
  }

  try {
    return await runLocked(db);
  } finally {
    if (gotLock === true) { try { await db.rpc("release_dispatch_lock"); } catch { /* connection close releases it anyway */ } }
  }
}

// The actual dispatch pass, run while holding the global lock (see run()).
async function runLocked(db: ReturnType<typeof supabaseAdmin>) {
  const now = Date.now();

  // Recover rows orphaned in 'sending' by a crashed/timed-out earlier run.
  // A row that already got a twilio_sid was actually sent (crash happened before
  // we wrote the status) — mark it 'queued' so the status callback finishes it,
  // NOT 'scheduled' (which the SID-null claim would skip forever). Only truly
  // un-sent rows (no SID) go back to 'scheduled' for retry.
  const orphanCutoff = new Date(now - 10 * 60000).toISOString();
  await db.from("messages").update({ status: "queued" })
    .eq("status", "sending").not("twilio_sid", "is", null).lte("scheduled_at", orphanCutoff);
  await db.from("messages").update({ status: "scheduled" })
    .eq("status", "sending").is("twilio_sid", null).lte("scheduled_at", orphanCutoff);

  // Reconcile Twilio-native scheduled rows (have a SID, our cron never sends them)
  // against Twilio's real status, so the UI stops freezing them at 'scheduled'.
  // Time-boxed and capped so a big backlog never starves the send loop below.
  let reconciled = 0;
  const { data: nativePending } = await db.from("messages")
    .select("id, twilio_sid, conversation, body, created_at")
    .eq("status", "scheduled").not("twilio_sid", "is", null).limit(RECONCILE_CAP);
  const reconcileDeadline = now + RECONCILE_BUDGET_MS;
  for (const m of (nativePending || []) as any[]) {
    if (Date.now() > reconcileDeadline) break;
    const real = await getMessageStatus(m.twilio_sid);
    if (real?.status && real.status !== "scheduled") {
      await db.from("messages").update({ status: real.status, error_code: real.errorCode || null }).eq("id", m.id);
      if (m.conversation) {
        // Also denormalize the preview fields the inbox list reads — without
        // these a natively-scheduled send leaves the conversation row blank
        // (no last message, no time) even though the message exists.
        await db.from("conversations").update({ last_status: real.status, last_direction: "out", last_body: m.body || "[template]", last_at: m.created_at }).eq("id", m.conversation);
        const isFail = real.status === "undelivered" || real.status === "failed";
        if (isFail && real.errorCode && INVALID_NUMBER_CODES.includes(real.errorCode)) {
          await db.from("conversations").update({ status: "invalid" }).eq("id", m.conversation).neq("status", "blocked");
        }
      }
      reconciled++;
    }
    await new Promise((r) => setTimeout(r, RECONCILE_THROTTLE_MS));
  }

  // Quiet-hours guard: NEVER send outside 09:00-19:00 Dubai (05:00-15:00 UTC),
  // no matter what scheduled_at says. The enqueue step already schedules into
  // this window, but a backlog whose scheduled_at fell in the past (e.g. rows
  // frozen during an outage/suspension) would otherwise all fire at once the
  // moment the cron next runs — including 3am. Overnight marketing reads as spam
  // to Meta and tanks the quality rating. Reconcile + orphan recovery above are
  // status-only (no outbound sends) so they're safe to run any hour.
  const utcHour = new Date(now).getUTCHours();
  if (utcHour < 5 || utcHour >= 15) {
    return NextResponse.json({ reconciled, claimed: 0, sent: 0, skipped: 0, failed: 0, held: "quiet_hours" });
  }

  // Find due messages, then claim them atomically (the status guard means a
  // concurrent run only gets the rows it actually flipped).
  // CRITICAL: only rows WITHOUT a twilio_sid. Rows that already have one were
  // scheduled through Twilio's own scheduler (the old browser-loop flow) — they
  // will send themselves, so dispatching them here would double-send.
  const { data: due } = await db.from("messages").select("id")
    .eq("status", "scheduled").is("twilio_sid", null).lte("scheduled_at", new Date(now).toISOString())
    .order("scheduled_at", { ascending: true }).limit(CAP);
  const ids = (due || []).map((d: any) => d.id);
  if (ids.length === 0) return NextResponse.json({ reconciled, claimed: 0, sent: 0, skipped: 0, failed: 0 });

  const { data: claimed } = await db.from("messages").update({ status: "sending" })
    .in("id", ids).eq("status", "scheduled").is("twilio_sid", null)
    .select("id, conversation, content_sid, content_vars, body, campaign");
  const rows = claimed || [];
  if (rows.length === 0) return NextResponse.json({ reconciled, claimed: 0, sent: 0, skipped: 0, failed: 0 });

  // Pull the phone/suppression status and the campaign's sender in two queries.
  const convIds = Array.from(new Set(rows.map((m: any) => m.conversation).filter(Boolean)));
  const convMap = new Map<string, { wa_phone: string; status: string }>();
  for (let i = 0; i < convIds.length; i += 500) {
    const { data } = await db.from("conversations").select("id, wa_phone, status").in("id", convIds.slice(i, i + 500));
    for (const c of data || []) convMap.set((c as any).id, { wa_phone: (c as any).wa_phone, status: (c as any).status });
  }
  const campIds = Array.from(new Set(rows.map((m: any) => m.campaign).filter(Boolean)));
  const senderMap = new Map<string, string | null>();
  if (campIds.length) {
    const { data } = await db.from("campaigns").select("id, sender").in("id", campIds);
    for (const c of data || []) senderMap.set((c as any).id, (c as any).sender);
  }

  // Circuit-breaker: senders currently paused by a penalty code (63051 locked / 90010
  // rate limit — see send_guard + /api/twilio/status). Messages on a paused sender are
  // HELD this run (left 'sending' -> released to 'scheduled' at the end) instead of
  // sent, so we STOP feeding a locked number. This is the brake the old number lacked.
  const { data: guards } = await db.from("send_guard").select("sender").gt("paused_until", new Date(now).toISOString());
  const pausedSenders = new Set((guards || []).map((g: any) => String(g.sender).replace(/[^0-9]/g, "")));
  const defaultFrom = String(process.env.TWILIO_WHATSAPP_FROM || "").replace(/^whatsapp:/, "").replace(/[^0-9]/g, "");

  let sent = 0, skipped = 0, failed = 0, held = 0;
  const deadline = now + DEADLINE_MS;
  for (const m of rows as any[]) {
    // Out of time budget — stop and release the rest below for the next run.
    if (Date.now() > deadline) break;
    const conv = convMap.get(m.conversation);
    if (!conv) { await db.from("messages").update({ status: "failed", error_code: "no_conversation" }).eq("id", m.id); failed++; continue; }
    if (SUPPRESSED.includes(conv.status)) { await db.from("messages").update({ status: "skipped" }).eq("id", m.id); skipped++; continue; }

    const e164 = "+" + String(conv.wa_phone).replace(/[^0-9]/g, "");
    const from = senderMap.get(m.campaign) || undefined;
    // Held: this message's sender is paused (hit a penalty). Skip — the end-of-run
    // release resets it to 'scheduled', so it waits until the pause clears.
    const senderBare = String(from || defaultFrom).replace(/^whatsapp:/, "").replace(/[^0-9]/g, "");
    if (pausedSenders.has(senderBare)) { held++; continue; }
    try {
      const tw = await sendTemplate(e164, m.content_sid, m.content_vars || undefined, undefined, from);
      const status = tw.status || "queued";
      await db.from("messages").update({ status, twilio_sid: tw.sid }).eq("id", m.id);
      await db.from("conversations").update({ last_direction: "out", last_status: status, last_body: m.body || "[template]", last_at: new Date().toISOString(), ...(senderBare ? { our_number: "+" + senderBare } : {}) }).eq("id", m.conversation);
      sent++;
    } catch (e: any) {
      // Persist BOTH the numeric Twilio code (now preserved by twilioError) and a
      // short human message, so the campaign log shows WHY a send failed instead of
      // the useless "No error code reported by Twilio".
      await db.from("messages").update({
        status: "failed",
        error_code: e?.code != null ? String(e.code) : null,
        error_detail: e?.message ? String(e.message).slice(0, 300) : null,
      }).eq("id", m.id);
      failed++;
    }
    await new Promise((r) => setTimeout(r, THROTTLE_MS));
  }

  // Release any claimed rows we didn't process (hit the deadline) back to
  // 'scheduled' so the next run picks them up — never leave them stuck 'sending'.
  // #7: only release rows that NEVER got a twilio_sid. A row whose Twilio send
  // succeeded but whose DB status-write failed still has status='sending' AND a
  // sid; resetting it to 'scheduled' would double-send. The `.is(twilio_sid,null)`
  // guard leaves those for the orphan-recovery pass (which re-queues them, not
  // re-schedules) so the status callback can finish them.
  await db.from("messages").update({ status: "scheduled" }).in("id", ids).eq("status", "sending").is("twilio_sid", null);

  // Mark a campaign completed once nothing is left scheduled for it.
  for (const cid of campIds) {
    const { count } = await db.from("messages").select("id", { count: "exact", head: true })
      .eq("campaign", cid).in("status", ["scheduled", "sending"]);
    if (count === 0) await db.from("campaigns").update({ status: "completed" }).eq("id", cid);
  }

  return NextResponse.json({ reconciled, claimed: rows.length, sent, skipped, failed, held });
}

export async function POST(req: NextRequest) {
  try { return await run(req); } catch (e: any) { return NextResponse.json({ error: e.message || "Dispatch failed" }, { status: 500 }); }
}
export async function GET(req: NextRequest) {
  try { return await run(req); } catch (e: any) { return NextResponse.json({ error: e.message || "Dispatch failed" }, { status: 500 }); }
}
