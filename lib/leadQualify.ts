import { supabaseAdmin } from "@/lib/supabase";
import { sendWhatsApp } from "@/lib/twilio";
import { crmFlagBroker, crmTagEnquirer } from "@/lib/crmSync";

// Template sent TO THE LEAD (not the agent) when an agent taps "No answer": the lead
// enquired, we called, they missed it. ONE variable, {{1}} lead name.
//
// Deliberately no "what they enquired about" variable. The only field we hold is
// lead_events.detail, which is the INTERNAL campaign name ("ERE | Abdul Listings |
// Sale, Rent & Commercial | Leads | 14 Jul 2026"). Interpolating that into a customer
// message would leak our ad naming to the lead. A generic phrase is always correct.
// Env-overridable; while unset the whole no-answer nudge silently no-ops.
const NO_ANSWER_NUDGE_SID = (process.env.NO_ANSWER_NUDGE_SID || "").trim();

// Minutes after the missed call before the lead gets the nudge. Short enough to stay
// contextual ("we just tried you"), long enough that it doesn't collide with an agent
// immediately redialling.
const NUDGE_DELAY_MIN = 30;

// Queue a WhatsApp nudge to the LEAD after a missed call, by inserting a scheduled row
// into `messages`. Deliberately queued rather than sent directly: the dispatch cron is
// the only path that enforces quiet hours (09:00-20:00 Dubai), the send_guard pause on
// a degraded sender, and blocked/invalid suppression. A direct sendTemplate here would
// bypass all three and message customers at 3am on a paused number.
//
// Direct inserts skip the enqueue API's own 7-day per-template cooldown, so we do the
// duplicate check ourselves: one nudge per lead per 7 days, no matter how many times an
// agent taps No answer.
async function queueNoAnswerNudge(db: ReturnType<typeof supabaseAdmin>, opts: {
  conversationId: string | null; leadName: string;
}): Promise<void> {
  if (!NO_ANSWER_NUDGE_SID || !opts.conversationId) return;
  try {
    const since = new Date(Date.now() - 7 * 86400_000).toISOString();
    const { data: recent } = await db
      .from("messages")
      .select("id")
      .eq("conversation", opts.conversationId)
      .eq("content_sid", NO_ANSWER_NUDGE_SID)
      .gt("created_at", since)
      .limit(1);
    if (recent && recent.length > 0) return; // already nudged this week

    const name = opts.leadName && opts.leadName !== "New contact" ? opts.leadName : "there";
    await db.from("messages").insert({
      conversation: opts.conversationId,
      direction: "out",
      status: "scheduled",
      scheduled_at: new Date(Date.now() + NUDGE_DELAY_MIN * 60_000).toISOString(),
      content_sid: NO_ANSWER_NUDGE_SID,
      content_vars: { "1": name },
      body: `Hi ${name}, this is ERE Homes. We just tried to reach you about your property enquiry. When is a good time for a quick call?`,
      twilio_sid: null, // MUST be null or the dispatcher treats it as Twilio-scheduled and never sends
    });
  } catch { /* best-effort: a nudge failure must never break the agent's status tap */ }
}

// The 5 status buttons on the ere_lead_status_alert template drive a lead
// QUALIFICATION workflow (distinct from the sales pipeline in agentReport):
//   Interested     -> qualified (the CPQL numerator)
//   Contacted      -> reached, outcome unknown; arms the 24h outcome follow-up
//   No answer      -> pending; re-arm the 2h follow-up reminder (still potential)
//   Not interested -> CRM "Meta Lead Enquirer" nurture pool, not qualified/not lost
//   Broker         -> flag is_broker in the CRM (blocks all marketing), not qualified
//
// "Contacted" is deliberately NOT an outcome — it is a holding state. The
// lead-watch cron picks those rows up 24h later and re-asks with the 4 outcome
// buttons (ere_lead_outcome_followup), which land back in this same handler. So a
// contacted lead always resolves to qualified / no_answer / not_interested /
// broker in the end; it just does it a day later, once the agent knows.
//
// Returns true if the body was one of these status taps (so the webhook skips the
// legacy pipeline handler). Correlates the tap to the exact lead via the alert SID
// the button was replied on (lead_events.alert_sid == OriginalRepliedMessageSid) —
// which is why the follow-up send REPOINTS alert_sid at the follow-up message.

type Qual = "qualified" | "contacted" | "no_answer" | "not_interested" | "broker";

const STATUS: Record<string, Qual> = {
  "interested": "qualified",
  "contacted": "contacted",
  "no answer": "no_answer",
  "not interested": "not_interested",
  "broker": "broker",
};

// True when `body` is one of the agent status-button taps (Interested / Contacted /
// No answer / Not interested / Broker). The inbound webhook uses this to SKIP the
// customer-preview auto-reply on a status tap — those buttons are agent actions,
// not customer buttons, so the only response should be the qualification confirm.
// (Without this, "Not interested" also matched the leftover customer auto-reply
// rule of the same name and the agent got TWO messages.)
export function isLeadStatusTap(body: string): boolean {
  const key = body.trim().toLowerCase().replace(/[\s!.?,]+$/, "");
  return Object.prototype.hasOwnProperty.call(STATUS, key);
}

const CONFIRM: Record<Qual, string> = {
  qualified: "marked Interested — qualified lead. Keep working it.",
  contacted: "marked Contacted — we'll check back tomorrow for the outcome.",
  no_answer: "marked No answer — we'll message them shortly and remind you to try again.",
  not_interested: "marked Not interested — saved for future follow-up, not counted as lost.",
  broker: "marked Broker — flagged in the CRM and blocked from our marketing.",
};

export async function handleLeadQualification(from: string, body: string, originalSid?: string | null): Promise<boolean> {
  const key = body.trim().toLowerCase().replace(/[\s!.?,]+$/, "");
  const qual = STATUS[key];
  if (!qual) return false; // not a status-button tap — let the caller fall through to the pipeline handler

  const db = supabaseAdmin();
  const { data: agent } = await db.from("agents").select("id, name").eq("wa_number", from).maybeSingle();
  if (!agent) return false;

  const reply = async (msg: string) => { try { await sendWhatsApp(from, msg); } catch { /* the agent just texted us, window is open */ } };

  // Resolve the EXACT lead. Primary: the alert SID this button was tapped on maps
  // 1:1 to the lead_events row (alert_sid). Fallback: the agent's most recent lead.
  const LE = "id, conversation, wa_phone, name, ref, detail";
  let le: any = null;
  if (originalSid) {
    const { data } = await db.from("lead_events").select(LE).eq("alert_sid", originalSid).order("created_at", { ascending: false }).limit(1).maybeSingle();
    le = data || null;
  }
  if (!le) {
    const { data } = await db.from("lead_events").select(LE).eq("assigned_agent", agent.id).order("created_at", { ascending: false }).limit(1).maybeSingle();
    le = data || null;
  }
  if (!le) { await reply("We could not match that to a lead. Reply to the specific lead alert and tap again."); return true; }

  const now = new Date().toISOString();
  const bare = String(le.wa_phone || "").replace("+", "");
  const e164 = "+" + bare;
  const name: string | undefined = le.name && le.name !== e164 && le.name !== bare ? le.name : undefined;

  // 1) Stamp the qualification on lead_events — the source of truth for CPQL.
  // On Contacted, stamp contacted_at and clear followup_sent_at: together those two
  // columns are what the lead-watch cron claims on to fire the 24h outcome ask.
  // Clearing (not just leaving null) matters for a lead that was contacted, followed
  // up, tapped No answer, then contacted again — it re-arms a fresh follow-up.
  await db.from("lead_events").update({
    qualification: qual,
    qualified_by: agent.name,
    qualification_updated_at: now,
    ...(qual === "qualified" ? { qualified_at: now } : {}),
    ...(qual === "contacted" ? { contacted_at: now, followup_sent_at: null } : {}),
  }).eq("id", le.id);

  // 2) Downstream action + conversation status (only ever set known-safe statuses).
  const convPatch: Record<string, any> = {};
  if (qual === "qualified") {
    convPatch.lead_status = "hot";
  } else if (qual === "contacted") {
    convPatch.lead_status = "hot";
    // Suppress the generic 2h "no update yet" nudge. The agent HAS actioned this
    // lead; nagging them 2h later would be wrong. The 24h outcome follow-up owns
    // this lead from here.
    convPatch.stale_alerted_at = now;
  } else if (qual === "no_answer") {
    convPatch.lead_status = "hot";
    convPatch.stale_alerted_at = null; // re-arm the 2h reminder so it nudges a retry
    // ...and message the LEAD directly, so a missed call isn't a dead end.
    await queueNoAnswerNudge(db, { conversationId: le.conversation, leadName: name || "" });
  } else if (qual === "not_interested") {
    convPatch.lead_status = "warm";
    await crmTagEnquirer(e164, name, le.detail).catch(() => {});
  } else if (qual === "broker") {
    convPatch.lead_status = "warm";
    await crmFlagBroker(e164, name).catch(() => {});
  }
  if (bare) { try { await db.from("conversations").update(convPatch).eq("wa_phone", bare); } catch { /* best-effort */ } }

  const who = (le.ref ? String(le.ref).toUpperCase() + " " : "") + (name || e164);
  await reply(`Done. ${who} ${CONFIRM[qual]}`);
  return true;
}
