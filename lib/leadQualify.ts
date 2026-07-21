import { supabaseAdmin } from "@/lib/supabase";
import { sendWhatsApp } from "@/lib/twilio";
import { crmFlagBroker, crmTagEnquirer } from "@/lib/crmSync";
import { reassignFromRoute, pingAgent } from "@/lib/distribution";

// Template sent TO THE LEAD (not the agent) when an agent taps "No answer": the lead
// enquired, we called, they missed it. TWO variables, {{1}} lead name and {{2}} a
// customer-facing ref derived from the lead_events uuid (ere_lead_no_answer_nudge_v2).
//
// {{2}} must NOT come from lead_events.ref — despite the name, that column holds the
// internal campaign short name ("Abdul Listings"), not a per-lead reference. It is fine
// in the AGENT alert and would be a leak in a customer message.
//
// Still no "what they enquired about" variable. The only field we hold is
// lead_events.detail, which is the INTERNAL campaign name ("ERE | Abdul Listings |
// Sale, Rent & Commercial | Leads | 14 Jul 2026"). Interpolating that into a customer
// message would leak our ad naming to the lead. The ref gives the message the specific
// anchor it needs without exposing anything internal.
//
// v1 of this template (1 var, "when is a good time for a quick call?") was approved by
// Meta as MARKETING despite being submitted UTILITY with allow_category_change:false —
// the categoriser reads the body, and that wording reads as re-engagement. Do not
// point this env at the v1 SID: MARKETING is suppressed by marketing opt-outs and
// per-user frequency caps, and a missed-call callback has to reach the person who
// asked us to call.
//
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
  conversationId: string | null; leadName: string; leadRef: string;
}): Promise<void> {
  // {{2}} is the lead reference and carries the template's UTILITY category: it is what
  // makes the message a callback on a specific request the lead made, rather than
  // generic re-engagement. Without a ref there is nothing transactional to point at, so
  // skip the nudge instead of sending a stripped version.
  if (!NO_ANSWER_NUDGE_SID || !opts.conversationId || !opts.leadRef) return;
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
    const ref = opts.leadRef.toUpperCase();
    await db.from("messages").insert({
      conversation: opts.conversationId,
      direction: "out",
      status: "scheduled",
      scheduled_at: new Date(Date.now() + NUDGE_DELAY_MIN * 60_000).toISOString(),
      content_sid: NO_ANSWER_NUDGE_SID,
      content_vars: { "1": name, "2": ref },
      // Mirrors the approved v2 template body exactly — this is what the inbox shows.
      body: `Hi ${name}, we tried to call you about the property enquiry you submitted (ref ${ref}) but could not reach you.\n\nReply here with a good time to call and your ERE Homes agent will get back to you.`,
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

// The 3 buttons on ere_lead_escalation, tapped by a MANAGER (not the assigned agent).
// Separate from the qualification buttons above because they act on ASSIGNMENT, not on
// the lead's status: none of them says anything about how the customer responded.
const ESCALATION_TAPS = new Set(["take this lead", "reassign", "already handled"]);

export function isEscalationTap(body: string): boolean {
  return ESCALATION_TAPS.has(body.trim().toLowerCase());
}

// Handle a manager's escalation tap. Correlates to the lead the same way every other
// button does — by the SID the button was replied on, which runEscalations repointed at
// the escalation message precisely so this lookup lands on the right lead.
//
// Returns true if this was an escalation tap (so the webhook skips other handlers).
export async function handleEscalationTap(from: string, body: string, originalSid: string | null): Promise<boolean> {
  if (!isEscalationTap(body)) return false;
  const action = body.trim().toLowerCase();
  const db = supabaseAdmin();
  const managerWa = "+" + String(from).replace(/^whatsapp:/, "").replace("+", "");
  const reply = async (msg: string) => { try { await sendWhatsApp(from, msg); } catch { /* window is open, they just tapped */ } };

  const { data: manager } = await db.from("agents").select("id, name").eq("wa_number", managerWa).maybeSingle();
  if (!manager) { await reply("We could not match your number to an agent record, so that tap was not applied."); return true; }

  // Only ever act on a lead THIS manager was escalated to. Without the escalated_at
  // filter a stray tap could reassign an unrelated lead.
  const { data: le } = await db
    .from("lead_events")
    .select("id, wa_phone, name, ref, assigned_agent, conversation")
    .eq("alert_sid", originalSid || "")
    .not("escalated_at", "is", null)
    .maybeSingle();
  if (!le) { await reply("We could not match that tap to an escalated lead. Open the lead in the console or reply here with the name."); return true; }

  const e164 = "+" + String(le.wa_phone || "").replace("+", "");
  const leadName = le.name && le.name !== e164 ? le.name : "this lead";
  const bare = String(le.wa_phone || "").replace("+", "");

  if (action === "already handled") {
    // No reassignment: the manager is telling us the lead is dealt with offline. Clear
    // the holding state so it stops being chased, but do NOT mark it qualified — we
    // genuinely do not know the outcome, and guessing would corrupt CPQL.
    await db.from("lead_events").update({ qualification: "resolved_offline", qualification_updated_at: new Date().toISOString() }).eq("id", le.id);
    if (bare) { try { await db.from("conversations").update({ lead_stage: "contacted" }).eq("wa_phone", bare); } catch { /* best-effort */ } }
    await reply(`Noted. ${leadName} is marked as handled and will stop being chased.`);
    return true;
  }

  if (action === "take this lead") {
    await db.from("lead_events").update({ assigned_agent: manager.name }).eq("id", le.id);
    if (bare) { try { await db.from("conversations").update({ assigned_agent_id: manager.id, assigned_at: new Date().toISOString(), stale_alerted_at: null, escalated_at: null }).eq("wa_phone", bare); } catch { /* best-effort */ } }
    await reply(`Done. ${leadName} is now assigned to you.`);
    return true;
  }

  // Reassign: back into the route's round-robin, skipping whoever ignored it. Falls back
  // to leaving the lead with the manager if the route has nobody else — an unroutable
  // lead must stay with a human, not vanish.
  const previous = (le as any).assigned_agent as string | null;
  const { data: prevAgent } = previous
    ? await db.from("agents").select("id").eq("name", previous).maybeSingle()
    : { data: null as any };
  const next = await reassignFromRoute(db, String(le.ref || ""), prevAgent?.id || "");
  if (!next) { await reply(`No other agent is on the ${le.ref || "this"} route, so ${leadName} stays with you.`); return true; }

  await db.from("lead_events").update({ assigned_agent: next.name }).eq("id", le.id);
  if (bare) { try { await db.from("conversations").update({ assigned_agent_id: next.id, assigned_at: new Date().toISOString(), stale_alerted_at: null, escalated_at: null }).eq("wa_phone", bare); } catch { /* best-effort */ } }
  // Alert the new owner exactly as if the lead had just landed, so they get the same
  // buttons and the same one-tap opener rather than a bare "you have been assigned".
  await pingAgent(next.name, next.wa_number, String(le.ref || ""), leadName, e164, `Reassigned by ${manager.name} — previously with ${previous || "an agent"}, not actioned.`);
  await reply(`Done. ${leadName} is reassigned to ${next.name}.`);
  return true;
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
    // NOT le.ref — that column holds the internal campaign short name ("Abdul Listings",
    // "Owner Listings"), which must never reach a customer. The customer-facing ref is
    // derived from the lead_events uuid: opaque, stable, and quotable back to us.
    await queueNoAnswerNudge(db, {
      conversationId: le.conversation,
      leadName: name || "",
      leadRef: String(le.id || "").replace(/-/g, "").slice(0, 7),
    });
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
