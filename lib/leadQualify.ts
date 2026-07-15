import { supabaseAdmin } from "@/lib/supabase";
import { sendWhatsApp } from "@/lib/twilio";
import { crmFlagBroker, crmTagEnquirer } from "@/lib/crmSync";

// The 4 status buttons on the ere_lead_status_alert template drive a lead
// QUALIFICATION workflow (distinct from the sales pipeline in agentReport):
//   Interested     -> qualified (the CPQL numerator)
//   No answer      -> pending; re-arm the 2h follow-up reminder (still potential)
//   Not interested -> CRM "Meta Lead Enquirer" nurture pool, not qualified/not lost
//   Broker         -> flag is_broker in the CRM (blocks all marketing), not qualified
//
// Returns true if the body was one of these status taps (so the webhook skips the
// legacy pipeline handler). Correlates the tap to the exact lead via the alert SID
// the button was replied on (lead_events.alert_sid == OriginalRepliedMessageSid).

type Qual = "qualified" | "no_answer" | "not_interested" | "broker";

const STATUS: Record<string, Qual> = {
  "interested": "qualified",
  "no answer": "no_answer",
  "not interested": "not_interested",
  "broker": "broker",
};

const CONFIRM: Record<Qual, string> = {
  qualified: "marked Interested — qualified lead. Keep working it.",
  no_answer: "marked No answer — we'll remind you to try again shortly.",
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
  await db.from("lead_events").update({
    qualification: qual,
    qualified_by: agent.name,
    qualification_updated_at: now,
    ...(qual === "qualified" ? { qualified_at: now } : {}),
  }).eq("id", le.id);

  // 2) Downstream action + conversation status (only ever set known-safe statuses).
  const convPatch: Record<string, any> = {};
  if (qual === "qualified") {
    convPatch.lead_status = "hot";
  } else if (qual === "no_answer") {
    convPatch.lead_status = "hot";
    convPatch.stale_alerted_at = null; // re-arm the 2h reminder so it nudges a retry
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
