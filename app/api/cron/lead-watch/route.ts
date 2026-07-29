import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase";
import { pingAgent, sendOutcomeFollowup, sendEscalation } from "@/lib/distribution";
import { sendOpsAlertOnce, sendDailyDigestOnce } from "@/lib/opsAlert";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

// A lead is "stale" once it's been assigned to an agent for this long with no
// status update logged (stage still null = never actioned/reported). On a phone
// the agent owns we can't see if they actually replied, so this also doubles as
// a nudge to self-report.
const STALE_HOURS = 2;
const CAP = 40; // most we nudge per run, so a backlog can't blow the 60s wall

// The repeat "still no update" reminder is OFF by default. It re-pings whoever a
// hot lead is still assigned to, and when WhatsApp ownership drifts from the real
// owner (e.g. leads redistributed to telesales in Pipedrive but not mirrored on
// conversations.assigned_agent_id) it spams the OLD owner every cycle — exactly
// what hit Keeley + Zek on 23 Jul. The FIRST new-lead alert is unaffected: that
// fires from /api/twilio/inbound, not here. To switch reminders back on once
// ownership is fixed, set STALE_REMINDERS=on in the env — no redeploy of logic.
// 29 Jul 2026: default flipped to ON. The reason it was off — reminders spamming the
// OLD owner when WhatsApp ownership drifted from Pipedrive — was a routing bug, and
// routing has since been fixed (telesales round-robin, Zenon restored to all 7 routes).
// Nudges now also go by EMAIL, which is addressed to the agent's own mailbox rather
// than whatever number a conversation happens to be assigned to, so a drift can no
// longer send a stranger's lead to the wrong phone. Set STALE_REMINDERS=off to disable.
const STALE_REMINDERS_ON = (process.env.STALE_REMINDERS || "on").toLowerCase() !== "off";

// Hours after an agent taps "Contacted" before we ask them for the outcome.
// 24h: long enough that a callback or viewing has actually happened, short enough
// that CPQL reporting isn't lagging days behind. This cron only runs inside Dubai
// waking hours (pg_cron `*/30 5-16`), so the ask never lands at 3am.
const FOLLOWUP_HOURS = 24;

// Second pass: convert "Contacted" holding-state leads into a real outcome by re-asking
// the owning agent with the 4 outcome buttons, then escalating to their manager if they
// keep ignoring it. Best-effort per row — one bad lead must not abort the batch.
//
// How many times we ask the assigned agent for the outcome before handing the lead to
// their manager. Two: the original ask plus one chase. A third would just be noise —
// an agent who has ignored two asks over 48h is not going to answer the third.
const MAX_FOLLOWUP_ASKS = 2;

// Resolve agent rows for lead_events.assigned_agent values.
//
// IMPORTANT: lead_events.assigned_agent holds the agent's NAME as text, not the uuid,
// despite reading like a foreign key. Looking these up with .in("id", …) matches nothing
// (and on a uuid column is an invalid-input error), which silently turned every sweep
// into a no-op. Always join this column on `name`.
async function agentsByName(db: ReturnType<typeof supabaseAdmin>, names: string[]) {
  const { data } = await db
    .from("agents")
    .select("id, name, wa_number, manager_id")
    .in("name", names);
  return new Map((data || []).map((a: any) => [a.name, a]));
}

async function managersById(db: ReturnType<typeof supabaseAdmin>, ids: string[]) {
  if (ids.length === 0) return new Map();
  const { data } = await db.from("agents").select("id, name, wa_number").in("id", ids);
  return new Map((data || []).map((a: any) => [a.id, a]));
}

async function runFollowups(db: ReturnType<typeof supabaseAdmin>): Promise<{ asked: number; escalated: number }> {
  const due = Date.now() - FOLLOWUP_HOURS * 3600_000;

  // One read of everything still awaiting an outcome, then decide per row whether it is
  // due for a first ask, a chase, or escalation. The contacted-and-unresolved set is
  // small, so filtering in JS is cheaper and far clearer than three near-identical
  // queries with .or() clauses.
  const { data: rows } = await db
    .from("lead_events")
    .select("id, wa_phone, name, ref, assigned_agent, contacted_at, followup_sent_at, followup_attempts")
    .eq("qualification", "contacted")
    .is("escalated_at", null)
    .not("assigned_agent", "is", null)
    .order("contacted_at", { ascending: true })
    .limit(CAP);
  if (!rows || rows.length === 0) return { asked: 0, escalated: 0 };

  const names = Array.from(new Set(rows.map((r: any) => r.assigned_agent))) as string[];
  const byName = await agentsByName(db, names);
  const byId = await managersById(db, Array.from(new Set([...byName.values()].map((a: any) => a.manager_id).filter(Boolean))) as string[]);

  let asked = 0, escalated = 0;
  for (const r of rows as any[]) {
    const agent = byName.get(r.assigned_agent);
    if (!agent?.wa_number) continue;

    // Clock runs from the last thing we sent: contacted_at for the first ask, then the
    // previous ask. So each chase waits a full FOLLOWUP_HOURS rather than firing
    // immediately after the one before it.
    const since = new Date(r.followup_sent_at || r.contacted_at || 0).getTime();
    if (since > due) continue; // not due yet

    const e164 = "+" + String(r.wa_phone || "").replace("+", "");
    const leadName = r.name && r.name !== e164 ? r.name : "New contact";

    if ((r.followup_attempts || 0) < MAX_FOLLOWUP_ASKS) {
      const out = await sendOutcomeFollowup(agent.name, agent.wa_number, r.ref || "", leadName, e164, r.contacted_at);
      // Nothing reached the agent by either channel — leave it claimable next run.
      if (!out.sid && !out.emailed) continue;
      // Repoint alert_sid ONLY on a real Twilio send: taps correlate to a lead purely
      // by the SID they were replied on, and an email has no tap to correlate. Writing
      // a placeholder here would break that lookup for every later reply.
      await db.from("lead_events").update({
        followup_sent_at: new Date().toISOString(),
        followup_attempts: (r.followup_attempts || 0) + 1,
        ...(out.sid ? { alert_sid: out.sid } : {}),
      }).eq("id", r.id);
      asked++;
      continue;
    }

    // Asked twice, still no outcome — hand it to the manager.
    const manager = byId.get(agent.manager_id);
    if (!manager?.wa_number) continue; // no manager mapped: leave claimable, never drop
    const esc = await sendEscalation(manager.name, manager.wa_number, agent.name, r.ref || "", leadName, e164);
    if (!esc.sid && !esc.emailed) continue; // neither channel reached them — retry next run
    await db.from("lead_events").update({
      escalated_at: new Date().toISOString(),
      ...(esc.sid ? { alert_sid: esc.sid } : {}),
    }).eq("id", r.id);
    escalated++;
  }
  return { asked, escalated };
}

// Third pass: a lead the agent never actioned AND never responded to the nudge about.
// Claims conversations that were nudged STALE_HOURS ago and are still sitting with no
// stage, and hands them to the agent's manager. One escalation per lead — escalated_at
// makes it idempotent, so a manager is never pinged twice about the same stuck lead.
async function runEscalations(db: ReturnType<typeof supabaseAdmin>): Promise<number> {
  const due = new Date(Date.now() - STALE_HOURS * 3600_000).toISOString();

  const { data: rows } = await db
    .from("conversations")
    .select("id, name, wa_phone, assigned_agent_id, lead_ref")
    .not("assigned_agent_id", "is", null)
    .is("lead_stage", null)
    .is("escalated_at", null)
    .not("stale_alerted_at", "is", null)
    .eq("is_internal", false)
    .eq("lead_status", "hot")
    .not("status", "in", "(blocked,invalid)")
    .lt("stale_alerted_at", due)
    .order("stale_alerted_at", { ascending: true })
    .limit(CAP);
  if (!rows || rows.length === 0) return 0;

  // conversations.assigned_agent_id IS a real uuid FK (unlike lead_events.assigned_agent,
  // which is a name) — so this one genuinely does look up by id.
  const ids = Array.from(new Set(rows.map((c: any) => c.assigned_agent_id))) as string[];
  const { data: agents } = await db.from("agents").select("id, name, wa_number, manager_id").in("id", ids);
  const byId = new Map((agents || []).map((a: any) => [a.id, a]));
  const managers = await managersById(db, Array.from(new Set((agents || []).map((a: any) => a.manager_id).filter(Boolean))) as string[]);

  let escalated = 0;
  for (const c of rows as any[]) {
    const agent = byId.get(c.assigned_agent_id);
    const manager = agent?.manager_id ? managers.get(agent.manager_id) : null;
    if (!agent || !manager?.wa_number) continue; // unmapped manager: leave claimable, never drop
    const e164 = "+" + String(c.wa_phone || "").replace("+", "");
    const leadName = c.name && c.name !== e164 ? c.name : "New contact";
    const esc = await sendEscalation(manager.name, manager.wa_number, agent.name, c.lead_ref || "", leadName, e164);
    if (!esc.sid && !esc.emailed) continue; // neither channel reached them — retry next run
    await db.from("conversations").update({ escalated_at: new Date().toISOString() }).eq("id", c.id);
    escalated++;
  }
  return escalated;
}

// Broker taps in one day at/above this = a list/targeting problem, not noise. 4 broker
// flags across ALL history as of 22 Jul 2026, so 3 in a single day is a real anomaly.
const BROKER_SPIKE_24H = 3;

// Fourth pass: surface the failures that used to be silent. alert_delivery/alert_error
// are stamped by the Twilio status webhook but nothing read them, so an agent alert
// that bounced left the lead sitting hot with nobody knowing. Same for a lead whose
// routing found no route/agents. Each row alerts the ops owner exactly once (ops_log).
async function runOpsWatch(db: ReturnType<typeof supabaseAdmin>): Promise<{ undelivered: number; unrouted: number; brokerSpike: boolean }> {
  // 7-day lookback: old rows predate this watcher — alerting on a month-old lead
  // nobody remembers would just be noise on day one.
  const since7d = new Date(Date.now() - 7 * 86400_000).toISOString();
  let undelivered = 0, unrouted = 0;

  const { data: undel } = await db
    .from("lead_events")
    .select("id, ref, name, wa_phone, assigned_agent, alert_delivery, alert_error")
    .in("alert_delivery", ["undelivered", "failed"])
    .gte("created_at", since7d)
    .limit(20);
  for (const r of (undel || []) as any[]) {
    const detail = `Alert to ${r.assigned_agent || "agent"} ${r.alert_delivery}${r.alert_error ? ` (${String(r.alert_error).slice(0, 60)})` : ""}. Re-ping or reassign.`;
    const record = `Lead ${r.ref || r.id} — ${r.name || r.wa_phone}`;
    if (await sendOpsAlertOnce(db, "Lead alert not delivered", String(r.id), detail, record)) undelivered++;
  }

  const { data: unr } = await db
    .from("lead_events")
    .select("id, ref, name, wa_phone, routing_status, detail")
    .in("routing_status", ["no_route", "no_active_agents", "alert_failed", "error"])
    .gte("created_at", since7d)
    .limit(20);
  for (const r of (unr || []) as any[]) {
    const detail = `${r.routing_status}${r.detail ? ` — ${String(r.detail).slice(0, 60)}` : ""}. Assign manually in the console.`;
    const record = `Lead ${r.ref || r.id} — ${r.name || r.wa_phone}`;
    if (await sendOpsAlertOnce(db, "Lead not routed", String(r.id), detail, record)) unrouted++;
  }

  // Broker spike: keyed on the Dubai date, so at most one alert per day.
  const since24 = new Date(Date.now() - 86400_000).toISOString();
  const { count } = await db
    .from("lead_events")
    .select("id", { count: "exact", head: true })
    .eq("qualification", "broker")
    .gte("qualification_updated_at", since24);
  let brokerSpike = false;
  if ((count || 0) >= BROKER_SPIKE_24H) {
    const dayKey = new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Dubai" });
    brokerSpike = await sendOpsAlertOnce(db, "Broker spike", dayKey,
      `${count} leads flagged Broker in 24h. Check which campaign/list is pulling brokers.`,
      "lead_events, last 24h");
  }
  return { undelivered, unrouted, brokerSpike };
}

// Fifth pass: one summary per Dubai day, sent by whatever cron pass lands at/after
// DIGEST_HOUR (the cron stops at 20:xx Dubai, so 18 gives it two hours of passes to
// get through). ops_log keyed on the Dubai date makes it exactly once.
const DIGEST_HOUR_DUBAI = 18;
async function runDailyDigest(db: ReturnType<typeof supabaseAdmin>): Promise<boolean> {
  const hour = Number(new Date().toLocaleString("en-GB", { hour: "2-digit", hour12: false, timeZone: "Asia/Dubai" }));
  if (hour < DIGEST_HOUR_DUBAI) return false;
  const dateKey = new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Dubai" });
  const since = new Date(Date.now() - 86400_000).toISOString();

  const count = async (build: (q: any) => any): Promise<number> => {
    const { count: n } = await build(db.from("lead_events").select("id", { count: "exact", head: true }));
    return n || 0;
  };
  const newLeads = await count((q) => q.gte("created_at", since));
  const qualified = await count((q) => q.eq("qualification", "qualified").gte("qualification_updated_at", since));
  // Stock, not flow: everything CURRENTLY untouched/unresolved, however old — the
  // digest's job is "what is still waiting", not "what arrived today".
  const awaitingFirst = await count((q) => q.eq("qualification", "new"));
  const awaitingOutcome = await count((q) => q.eq("qualification", "contacted"));

  const date = new Date().toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "Asia/Dubai" });
  return sendDailyDigestOnce(db, dateKey, { date, newLeads, qualified, awaitingFirst, awaitingOutcome });
}

// Nudge agents sitting on un-actioned leads. Claims assigned-but-unmoved leads
// older than STALE_HOURS that we haven't nudged yet, pings the owning agent's
// WhatsApp, and stamps stale_alerted_at so each lead is nudged once. Secured by
// CRON_SECRET (pg_cron passes it as a header), same as the dispatch cron.
async function run(req: NextRequest) {
  const secret = process.env.CRON_SECRET;
  if (!secret) return NextResponse.json({ error: "CRON_SECRET not configured" }, { status: 503 });
  const provided = req.headers.get("x-cron-secret") || new URL(req.url).searchParams.get("key") || "";
  if (provided !== secret) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const db = supabaseAdmin();
  const cutoff = new Date(Date.now() - STALE_HOURS * 3600_000).toISOString();

  // Outcome follow-ups run FIRST and unconditionally — they are independent of the
  // stale sweep, which returns early when nothing is stale.
  const followedUp = await runFollowups(db).catch(() => ({ asked: 0, escalated: 0 }));
  const escalated = await runEscalations(db).catch(() => 0);
  const ops = await runOpsWatch(db).catch(() => ({ undelivered: 0, unrouted: 0, brokerSpike: false }));
  const digest = await runDailyDigest(db).catch(() => false);

  // Reminder nag is opt-in. Everything above (follow-ups, escalations, ops watch,
  // daily digest) still runs — only the stale re-ping is gated.
  if (!STALE_REMINDERS_ON) return NextResponse.json({ ok: true, nudged: 0, remindersOff: true, followedUp, escalated, ops, digest });

  const { data: stale, error } = await db
    .from("conversations")
    .select("id, name, wa_phone, assigned_agent_id, assigned_at, lead_ref")
    .not("assigned_agent_id", "is", null)
    .is("lead_stage", null)
    .eq("is_internal", false)
    .eq("lead_status", "hot")
    .not("status", "in", "(blocked,invalid)")
    .is("stale_alerted_at", null)
    .lt("assigned_at", cutoff)
    .order("assigned_at", { ascending: true })
    .limit(CAP);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  if (!stale || stale.length === 0) return NextResponse.json({ ok: true, nudged: 0, followedUp, escalated, ops, digest });

  // Resolve the owning agents' WhatsApp numbers in one read.
  const ids = Array.from(new Set(stale.map((c) => c.assigned_agent_id))) as string[];
  const { data: agents } = await db.from("agents").select("id, name, wa_number").in("id", ids);
  const byId = new Map((agents || []).map((a: any) => [a.id, a]));

  let nudged = 0;
  for (const c of stale) {
    const agent = byId.get(c.assigned_agent_id as string);
    if (!agent?.wa_number) continue;
    const hrs = c.assigned_at ? Math.max(1, Math.round((Date.now() - new Date(c.assigned_at).getTime()) / 3600_000)) : STALE_HOURS;
    const leadName = c.name && c.name !== ("+" + c.wa_phone) ? c.name : "New contact";
    const about = `Reminder — assigned to you ~${hrs}h ago, still no update. Reach out now, then tap a status button below.`;
    const ok = await pingAgent(agent.name, agent.wa_number, (c as any).lead_ref || "", leadName, "+" + c.wa_phone, about);
    // Stamp regardless so we don't re-nudge in a tight loop; if the send truly
    // failed the lead still surfaces as stale on the board.
    await db.from("conversations").update({ stale_alerted_at: new Date().toISOString() }).eq("id", c.id);
    if (ok) nudged++;
  }
  return NextResponse.json({ ok: true, nudged, scanned: stale.length, followedUp, escalated, ops, digest });
}

export async function GET(req: NextRequest) { return run(req); }
export async function POST(req: NextRequest) { return run(req); }
