import { supabaseAdmin } from "@/lib/supabase";
import { sendWhatsApp } from "@/lib/twilio";

// Level-3 lead tracking: agents work leads on their own WhatsApp, so we can't
// see those chats. Instead, an agent can text the ERE number a short status and
// we update the lead's stage from it. This is the only visibility we get when
// the conversation itself lives on a phone we don't control.
//
// Recognised statuses (most-advanced wins if several words appear):
//   won      -> "won", "closed", "sold", "signed", "deal done"
//   lost     -> "lost", "dead", "declined", "not interested", "no deal", "cold"
//   viewing  -> "viewing", "booked", "appointment", "meeting", "site visit"
//   contacted-> "contacted", "called", "spoke", "reached", "messaged", "no answer"
//
// The lead is matched by a phone number in the message if present, else the
// agent's most-recently-assigned still-open lead.

type Stage = "contacted" | "viewing" | "won" | "lost";

const STAGE_PATTERNS: { stage: Stage; re: RegExp }[] = [
  { stage: "won", re: /\b(won|closed|sold|signed|deal\s*(done|closed)|client\s*signed)\b/i },
  { stage: "lost", re: /\b(lost|dead|declined|no\s*deal|gone\s*cold|went\s*cold|not\s*interested|unresponsive)\b/i },
  { stage: "viewing", re: /\b(viewing|viewings|booked|appointment|meeting|site\s*visit|visit\s*booked|showing)\b/i },
  { stage: "contacted", re: /\b(contacted|called|calling|spoke|speaking|reached|reaching|messaged|texted|following\s*up|followed\s*up|in\s*touch|no\s*answer|no\s*response)\b/i },
];

const HELP =
  "To update a lead, text its number and a status: contacted, viewing, won or lost.\n\n" +
  "Example: won 0501234567\n\n" +
  "Without a number we update your most recent lead.";

// Normalise a UAE-style phone found in free text to the stored wa_phone form
// (971XXXXXXXXX, no +). Returns null if nothing phone-like is present.
function leadPhoneFrom(body: string): string | null {
  const digits = body.replace(/[^\d]/g, "");
  if (digits.length < 7) return null;
  // Pull the longest plausible run; agents usually paste the whole number.
  let n = digits;
  if (n.startsWith("00")) n = n.slice(2);
  if (n.startsWith("0") && n.length === 10) n = "971" + n.slice(1); // 05XXXXXXXX
  else if (n.length === 9 && n.startsWith("5")) n = "971" + n;       // 5XXXXXXXX
  else if (n.startsWith("971")) { /* already E.164 without + */ }
  return n.length >= 11 ? n : null;
}

function parseStage(body: string): Stage | null {
  for (const p of STAGE_PATTERNS) if (p.re.test(body)) return p.stage;
  return null;
}

// lead_status to set alongside a NON-lost stage. Won marks the temperature won;
// contacted/viewing stay hot (still an active opportunity). Lost is handled
// separately (it releases the lead back to the pool).
function leadStatusFor(stage: Stage): string {
  return stage === "won" ? "won" : "hot";
}

const labelOf = (s: Stage) => ({ contacted: "Contacted", viewing: "Viewing", won: "Won", lost: "Lost" }[s]);

// Returns true if `from` is a known agent and we handled the message as a
// status report (so the webhook should stop and NOT treat it as a lead).
export async function handleAgentReport(from: string, body: string): Promise<boolean> {
  const db = supabaseAdmin();
  const { data: agent } = await db
    .from("agents")
    .select("id, name")
    .eq("wa_number", from)
    .maybeSingle();
  if (!agent) return false; // not an agent — normal inbound handling

  const reply = async (msg: string) => {
    try { await sendWhatsApp(from, msg); } catch { /* window should be open (they just texted us) */ }
  };

  const stage = parseStage(body);
  if (!stage) { await reply(HELP); return true; }

  // Find the lead: explicit phone in the text wins, else their newest open lead.
  const phone = leadPhoneFrom(body);
  let lead: { id: string; name: string | null; wa_phone: string; assigned_agent_id: string | null; first_response_at: string | null } | null = null;
  if (phone) {
    const { data } = await db
      .from("conversations")
      .select("id, name, wa_phone, assigned_agent_id, first_response_at")
      .eq("wa_phone", phone)
      .maybeSingle();
    lead = data || null;
    if (!lead) { await reply(`We could not find a lead with the number ${phone}. Double-check it and try again.`); return true; }
  } else {
    // Open = not yet won or lost. A brand-new lead has a NULL stage, and
    // `NULL NOT IN (...)` is NOT true in SQL, so we must match null explicitly.
    const { data } = await db
      .from("conversations")
      .select("id, name, wa_phone, assigned_agent_id, first_response_at")
      .eq("assigned_agent_id", agent.id)
      .or("lead_stage.is.null,lead_stage.in.(contacted,viewing)")
      .eq("is_internal", false)
      .order("assigned_at", { ascending: false })
      .limit(2);
    const open = data || [];
    if (open.length === 0) { await reply("We could not find an open lead assigned to you. Include the lead's number, e.g. 'contacted 0501234567'."); return true; }
    lead = open[0];
  }

  const now = new Date().toISOString();
  const who = lead.name && lead.name !== ("+" + lead.wa_phone) ? lead.name : "+" + lead.wa_phone;
  const patch: Record<string, any> = { lead_stage: stage, stage_updated_at: now };

  if (stage === "lost") {
    // "Lost" = the agent gives the lead back. Release ownership so it falls into
    // the Lead Pool (un-owned, flagged lost) for someone else to pick up. We do
    // NOT mark it dead — it stays a live lead, just unassigned.
    patch.assigned_agent_id = null;
    patch.assigned_at = null;
    patch.lead_status = "warm";
    await db.from("conversations").update(patch).eq("id", lead.id);
    await reply(`Done. ${who} has been released back to the lead pool for another agent.`);
    return true;
  }

  // Contacted / Viewing / Won move the lead forward. Claim ownership if it had
  // none (so the board reflects who is actually working it). Stamp the first
  // response once, for response-time tracking.
  patch.lead_status = leadStatusFor(stage);
  if (!lead.assigned_agent_id) { patch.assigned_agent_id = agent.id; patch.assigned_at = now; }
  if (!lead.first_response_at) patch.first_response_at = now;
  await db.from("conversations").update(patch).eq("id", lead.id);
  await reply(`Done. ${who} marked as ${labelOf(stage)}.`);
  return true;
}
