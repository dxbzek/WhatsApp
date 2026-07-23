import { supabaseAdmin } from "@/lib/supabase";
import { sendWhatsApp, sendTemplate, getContentMedia } from "@/lib/twilio";
import { ensureLeadRef } from "@/lib/leadRef";
import { syncMetaLeadToPipedrive } from "@/lib/metaLeadPipedrive";

// Unified agent lead-alert template on the UTILITY subaccount (category UTILITY,
// so it is exempt from Meta's per-recipient MARKETING throttle that silently drops
// bursts with error 63049). Variables:
//   {{1}} agent name, {{2}} lead ID (lead_ref), {{3}} lead name, {{4}} number,
//   {{5}} source (what the lead responded to + any tappable link).
// Live template = ere_lead_status_alert (approved 16 Jul 2026). Its quick-reply
// buttons Interested / No answer / Not interested / Broker feed
// handleLeadQualification, which stamps the lead's qualification (CPQL numerator),
// re-arms the follow-up on No answer, and flags brokers in the CRM. The old
// parent-account SIDs (ere_meta_lead_alert + the WA-campaign alert) are DEAD after
// the utility repoint — never reintroduce them.
// Env-overridable (AGENT_LEAD_ALERT_SID) so we can point at a new template without a
// code deploy. Rollback ladder if v3 misbehaves, newest first:
//   HX806fe135dda04884c869931f8a1ca4bb  ere_lead_status_alert    (4 buttons, no Contacted)
//   HXe1b69d2c15b5cf888655ce75bba4ec23  ere_agent_lead_alert_v2  (-> handleAgentReport)
// LIVE 21 Jul 2026: ere_lead_status_alert_v3, approved UTILITY, same body and same 5
// vars as HX806f (cloned from it), plus a 5th "Contacted" button.
const AGENT_LEAD_ALERT_SID = (process.env.AGENT_LEAD_ALERT_SID || "HX7409f1f2a6bb4c39d4177239af8c88e2").trim();

// Outcome follow-up template (utility subaccount, quick-reply, 4 buttons:
// Interested / No answer / Not interested / Broker). Sent 24h after an agent taps
// "Contacted" on the main alert, to convert that holding state into a real outcome.
// Vars (v2 ORDER — the date was inserted at {{2}} and everything after shifts):
// {{1}} agent name, {{2}} date contacted ("20 Jul"), {{3}} lead ID (lead_ref),
// {{4}} lead name, {{5}} number.
// Default = ere_lead_outcome_followup_v2, approved UTILITY 22 Jul 2026, which carries
// the real contacted date instead of v1's hardcoded "yesterday" (wrong whenever a send
// slipped past quiet hours or a failed send). v1 rollback = HXe86db093de2c30950ab529526c1da626
// (4 vars — sendOutcomeFollowup must drop the date again if ever pointed back at it).
const LEAD_OUTCOME_FOLLOWUP_SID = (process.env.LEAD_OUTCOME_FOLLOWUP_SID || "HX764024fd875ea6e768fa7d750aef7df4").trim();

// Manager escalation template (utility subaccount, quick-reply, 3 buttons: Take this
// lead / Reassign / Already handled). Sent when the assigned agent has ignored both the
// original alert and the stale nudge, or has left a Contacted lead without an outcome
// through repeated asks.
// Vars: {{1}} manager name, {{2}} agent who ignored it, {{3}} lead ID, {{4}} lead name,
// {{5}} number + one-tap reply link.
// Buttons rather than a console link on purpose: agents and managers have NO ERE console
// access, so an escalation has to be fully actionable from inside WhatsApp.
// Unset until the template clears Meta — sendEscalation no-ops rather than throwing.
const LEAD_ESCALATION_SID = (process.env.LEAD_ESCALATION_SID || "").trim();

// Hand a stuck lead to a manager. Returns the Twilio SID so the caller can repoint
// lead_events.alert_sid at it — button taps correlate to a lead purely by the SID they
// were replied on, so without this the manager's tap resolves against whatever lead the
// MANAGER most recently touched, which is almost never the one being escalated.
export async function sendEscalation(managerName: string, managerWa: string, agentName: string, leadRef: string, leadName: string, contactPhone: string): Promise<string | null> {
  if (!LEAD_ESCALATION_SID) return null; // template not approved yet — no-op, never throw
  try {
    // Same one-tap opener the agent alert uses, so the manager can message the lead
    // directly instead of copying a number out of the message.
    const link = replyLink(managerName, leadName, contactPhone, "", null);
    const numberLine = link ? `${contactPhone} · Reply: ${link}` : contactPhone;
    const r: any = await sendTemplate(managerWa, LEAD_ESCALATION_SID, {
      "1": managerName, "2": agentName, "3": leadRef || "—", "4": leadName, "5": numberLine,
    });
    return r?.sid || null;
  } catch {
    return null;
  }
}

// Put a lead back into its route's round-robin, skipping the agent who ignored it.
// Returns the newly assigned agent, or null if the route has nobody else — in which
// case the caller must leave the lead with the manager rather than silently orphaning
// it. Reuses the same atomic pointer RPC as normal routing so a reassignment can never
// collide with a live lead being distributed at the same moment.
export async function reassignFromRoute(
  db: ReturnType<typeof supabaseAdmin>,
  routeRef: string,
  excludeAgentId: string,
): Promise<{ id: string; name: string; wa_number: string } | null> {
  const { data: route } = await db
    .from("lead_routes")
    .select("ref, agent_ids, distribution")
    .eq("ref", routeRef)
    .eq("active", true)
    .maybeSingle();
  const ids = ((route?.agent_ids as string[]) || []).filter((id) => id !== excludeAgentId);
  if (ids.length === 0) return null;

  const { data: agents } = await db
    .from("agents")
    .select("id, name, wa_number")
    .in("id", ids)
    .eq("active", true)
    .not("wa_number", "is", null);
  // Preserve the route's own agent order so round-robin stays stable across runs
  // instead of following whatever order Postgres happened to return.
  const ordered = ids
    .map((id) => (agents || []).find((a: any) => a.id === id))
    .filter(Boolean) as { id: string; name: string; wa_number: string }[];
  if (ordered.length === 0) return null;

  const pointer = await atomicRrPointer(db, "next_route_rr_pointer", { p_ref: routeRef });
  const idx = (((pointer - 1) % ordered.length) + ordered.length) % ordered.length;
  return ordered[idx];
}

// Ask an agent for the outcome of a lead they already contacted. Returns the
// Twilio SID: the caller MUST repoint lead_events.alert_sid at it, because button
// taps correlate to a lead purely by the SID they were replied on — leave alert_sid
// on the original alert and the tap would resolve, but only via the fallback
// "agent's most recent lead" path, which is wrong whenever they hold several leads.
export async function sendOutcomeFollowup(agentName: string, toWa: string, leadRef: string, leadName: string, contactPhone: string, contactedAt?: string | null): Promise<string | null> {
  if (!LEAD_OUTCOME_FOLLOWUP_SID) return null; // template not provisioned yet — no-op, never throw
  try {
    // "20 Jul" in Dubai time — the template reads "the lead you contacted on {{2}}".
    // No contacted_at on the row (shouldn't happen for a contacted lead) → "recently",
    // which still reads as a sentence rather than a naked variable.
    const dateStr = contactedAt
      ? new Date(contactedAt).toLocaleDateString("en-GB", { day: "numeric", month: "short", timeZone: "Asia/Dubai" })
      : "recently";
    const r: any = await sendTemplate(toWa, LEAD_OUTCOME_FOLLOWUP_SID, {
      "1": agentName, "2": dateStr, "3": leadRef || "—", "4": leadName, "5": contactPhone,
    });
    return r?.sid || null;
  } catch {
    return null;
  }
}

// Dedicated recruitment alert (utility subaccount, text-only, NO status buttons).
// Recruitment leads are candidates applying to JOIN ERE, not property enquiries, so
// they get their own recruiter-facing template instead of the sales-pipeline alert.
// Vars: {{1}} recruiter name, {{2}} candidate name, {{3}} number, {{4}} source.
// Default = ere_recruit_lead_alert_v3, approved UTILITY 22 Jul 2026. The original
// ere_recruit_lead_alert (HXd53adb11d39bab9a6a9f72df5f7a9c02) is MARKETING (Meta
// re-categorised it over one salesy line), so recruiter alerts sent on it inherit
// marketing frequency caps and opt-outs — never point back at it.
const RECRUIT_LEAD_ALERT_SID = (process.env.RECRUIT_LEAD_ALERT_SID || "HXe1c7abe2b8ee3c41667ad76aa62d7ce0").trim();

type AlertOutcome = { ok: boolean; sid: string | null; error: string | null };

// Record that we sent a lead alert to an agent, so a later quick-reply button tap
// (which carries no lead reference) can be correlated back to this exact lead.
// Best-effort: a logging failure must never break distribution.
async function logAgentAlert(db: ReturnType<typeof supabaseAdmin>, opts: {
  agentId: string | null; agentWa: string; conversationId: string; alertSid: string | null;
}): Promise<void> {
  try {
    await db.from("agent_alert_log").insert({
      agent_id: opts.agentId,
      agent_wa: opts.agentWa,
      conversation_id: opts.conversationId,
      alert_message_sid: opts.alertSid,
    });
  } catch { /* logging is best-effort */ }
}

type Agent = { id: string; name: string; wa_number: string; pipedrive_user_id?: string | null; active?: boolean };

// Send one lead-alert to an agent's WhatsApp via the approved UTILITY template.
// Returns the Twilio SID so a later button tap can be correlated back to this lead
// (via agent_alert_log). Records the real error instead of a silent drop.
// Build a one-tap reply link: the agent taps it to open THEIR OWN WhatsApp chat
// with the lead, a Property-Finder-style opener PRE-WRITTEN, and sends it directly
// (1:1 human, so no template / throttle / ban risk). We route through the short
// erehomes.ae/r.php redirect instead of a raw wa.me?text= deep link: the redirect
// builds the long pre-filled message server-side, so the alert body shows only a
// short clean link (a raw pre-filled wa.me link renders as a giant percent-encoded
// URL — ugly). r.php params: p=digits, q=property/campaign, a=agent, n=lead name.
// Returns "" when there is no usable number so callers can append it unconditionally.
// `adUrl` (the IG/FB permalink of the creative) is carried through to r.php so the
// PRE-WRITTEN message the agent sends already contains the ad. Leads routinely forget
// which listing they enquired about; naming it back to them removes a round trip.
function replyLink(agentName: string, leadName: string, contactPhone: string, context?: string | null, adUrl?: string | null): string {
  const digits = (contactPhone || "").replace(/[^0-9]/g, "");
  if (digits.length < 8) return "";
  const qs = new URLSearchParams({ p: digits });
  const ctx = (context || "").trim();
  if (ctx) qs.set("q", ctx.slice(0, 120));
  const nm = leadName && leadName !== "New contact" ? leadName.trim() : "";
  if (nm) qs.set("n", nm.slice(0, 120));
  const ag = (agentName || "").trim();
  if (ag) qs.set("a", ag.slice(0, 120));
  const ad = (adUrl || "").trim();
  if (ad.startsWith("https://")) qs.set("ad", ad.slice(0, 120));
  return `https://erehomes.ae/r.php?${qs.toString()}`;
}

async function sendAgentAlert(agentName: string, toWa: string, leadRef: string, leadName: string, contactPhone: string, source: string, replyContext?: string | null, adUrl?: string | null): Promise<AlertOutcome> {
  try {
    // Append the one-tap reply link ONLY when the caller opts in (passes a context,
    // even ""). Monitor/safety sends (tracker CC, fallback) omit it and stay clean.
    let src = source;
    if (replyContext !== undefined) {
      const link = replyLink(agentName, leadName, contactPhone, replyContext, adUrl);
      if (link) src = `${source} · Reply: ${link}`;
    }
    const r: any = await sendTemplate(toWa, AGENT_LEAD_ALERT_SID, {
      "1": agentName, "2": leadRef || "—", "3": leadName, "4": contactPhone, "5": src,
    });
    return { ok: true, sid: r?.sid || null, error: null };
  } catch (e: any) {
    return { ok: false, sid: null, error: String(e?.message || e).slice(0, 200) };
  }
}

// Ping a single agent's WhatsApp with a lead alert/reminder (used by the stale-lead
// watcher). Reuses the approved UTILITY alert template.
export async function pingAgent(agentName: string, wa_number: string, leadRef: string, leadName: string, contactPhone: string, source: string): Promise<boolean> {
  // Stale-lead reminder to the assigned agent — include the one-tap reply link ("").
  return (await sendAgentAlert(agentName, wa_number, leadRef, leadName, contactPhone, source, "")).ok;
}

// Send one recruitment alert to a recruiter's WhatsApp via the approved recruit
// template (text-only, no status buttons — recruitment has no sales pipeline stage).
async function sendRecruitAlert(recruiterName: string, toWa: string, candidateName: string, contactPhone: string, source: string): Promise<AlertOutcome> {
  try {
    const r: any = await sendTemplate(toWa, RECRUIT_LEAD_ALERT_SID, {
      "1": recruiterName, "2": candidateName, "3": contactPhone, "4": source || "Recruitment",
    });
    return { ok: true, sid: r?.sid || null, error: null };
  } catch (e: any) {
    return { ok: false, sid: null, error: String(e?.message || e).slice(0, 200) };
  }
}

// Ping each recruiter with a candidate, personalised by name. Mirrors alertAgents
// but uses the recruit template (4 vars). Best-effort per target.
async function alertRecruiters(targets: Agent[], candidateName: string, contactPhone: string, source: string): Promise<{ id: string; name: string; wa: string; ok: boolean; sid: string | null; error: string | null }[]> {
  const results: { id: string; name: string; wa: string; ok: boolean; sid: string | null; error: string | null }[] = [];
  for (const a of targets) {
    const r = await sendRecruitAlert(a.name, a.wa_number, candidateName, contactPhone, source);
    results.push({ id: a.id, name: a.name, wa: a.wa_number, ...r });
  }
  return results;
}

// Ping each target agent with the lead, personalised by name. Best-effort: a
// per-agent failure never blocks the rest. Returns per-agent outcome (incl. the
// Twilio SID) so the caller knows whether at least one alert reached an agent.
async function alertAgents(targets: Agent[], leadRef: string, leadName: string, contactPhone: string, source: string, replyContext?: string | null, adUrl?: string | null): Promise<{ id: string; name: string; wa: string; ok: boolean; sid: string | null; error: string | null }[]> {
  const results: { id: string; name: string; wa: string; ok: boolean; sid: string | null; error: string | null }[] = [];
  for (const a of targets) {
    const r = await sendAgentAlert(a.name, a.wa_number, leadRef, leadName, contactPhone, source, replyContext, adUrl);
    results.push({ id: a.id, name: a.name, wa: a.wa_number, ...r });
  }
  return results;
}

// Safety net: when a lead cannot reach its assigned agent (no route, no active
// agents, or every agent alert failed), ping the fallback owner (LEAD_FALLBACK_WA)
// so a lead is NEVER lost silently. Returns true if the fallback was notified.
async function notifyFallback(reason: string, leadRef: string, leadName: string, contactPhone: string, context: string): Promise<boolean> {
  const to = (process.env.LEAD_FALLBACK_WA || "").trim();
  if (!to) return false;
  const source = `UNROUTED (${reason})${context ? ` — ${context}` : ""}. Reassign this lead.`;
  return (await sendAgentAlert("team", to, leadRef, leadName, contactPhone, source)).ok;
}

// Pick the target agent(s) from an ordered pool: "all" notifies everyone (owner =
// first); otherwise round-robin using an ALREADY-INCREMENTED pointer (obtained
// atomically from the DB by the caller, so concurrent leads never collide). The
// pointer is 1-based (the value AFTER incrementing), so index = (pointer-1) mod n.
// Zero-guard (#10): an empty pool returns [] instead of indexing undefined.
function pickTargets(ordered: Agent[], distribution: string | null | undefined, incrementedPointer: number): Agent[] {
  if (ordered.length === 0) return [];
  if (distribution === "all") return ordered;
  // Normalise into range even if the pointer is negative or huge.
  const idx = (((incrementedPointer - 1) % ordered.length) + ordered.length) % ordered.length;
  return [ordered[idx]];
}

// Atomically advance a round-robin pointer via a DB RPC (UPDATE ... RETURNING),
// so two concurrent leads never read the same pointer and pick the same agent
// (the old JS read/increment/write was racy). Returns the incremented pointer.
// On RPC failure we do NOT silently swallow: log it and fall back to pointer 0
// (which pickTargets normalises to the first agent) so a lead still routes.
async function atomicRrPointer(
  db: ReturnType<typeof supabaseAdmin>,
  fn: "next_campaign_rr_pointer" | "next_route_rr_pointer",
  arg: { p_id: string } | { p_ref: string },
): Promise<number> {
  const { data, error } = await db.rpc(fn, arg as any);
  if (error || data == null) {
    // eslint-disable-next-line no-console
    console.warn(`[distribution] ${fn} rpc failed, falling back to pointer 0:`, error?.message || "null result");
    return 0;
  }
  return typeof data === "number" ? data : Number(data);
}

// Global lead-gen tracker(s). Every lead alert is CC'd to these number(s) no
// matter which agent the lead was assigned to and regardless of round-robin, so
// the lead-gen owner monitors 100% of leads without being in each campaign's
// agent list. Override the default via LEAD_TRACKER_WA (comma-separated E.164).
const LEAD_TRACKER_WA = (process.env.LEAD_TRACKER_WA || "+971524766133")
  .split(",").map((s) => s.trim()).filter(Boolean);

// CC every tracker with the same lead alert, skipping any number already alerted
// as an assigned agent (dedupe by digits) so no one is pinged twice. The tracker
// number(s) only ever monitor (never get assigned leads), so no "this is a copy"
// marker is needed — every alert they receive is a monitor copy by definition. We
// just prefix the channel (WhatsApp reply vs Meta form) so the origin is visible.
// Best-effort: never breaks routing.
async function ccTrackers(
  db: ReturnType<typeof supabaseAdmin>,
  alreadyAlertedWa: string[],
  conversationId: string | undefined,
  leadRef: string, leadName: string, contactPhone: string, source: string,
  channel: string,
): Promise<void> {
  try {
    if (LEAD_TRACKER_WA.length === 0) return;
    const digits = (w: string) => w.replace(/[^0-9]/g, "");
    const seen = new Set(alreadyAlertedWa.map(digits));
    const src = `${channel} · ${source}`;
    for (const wa of LEAD_TRACKER_WA) {
      if (seen.has(digits(wa))) continue;
      const r = await sendAgentAlert("Lead tracker", wa, leadRef, leadName, contactPhone, src);
      if (r.ok && conversationId) await logAgentAlert(db, { agentId: null, agentWa: wa, conversationId, alertSid: r.sid });
    }
  } catch { /* tracker CC is best-effort */ }
}

// Load active agents for the given ids, preserving the configured order.
async function loadAgents(db: ReturnType<typeof supabaseAdmin>, ids: string[]): Promise<Agent[]> {
  if (ids.length === 0) return [];
  const { data } = await db
    .from("agents")
    .select("id, name, wa_number, pipedrive_user_id, active")
    .in("id", ids)
    .eq("active", true);
  const byId = new Map((data || []).map((a: any) => [a.id, a]));
  return ids.map((id) => byId.get(id)).filter(Boolean) as Agent[];
}

// Auto-distribute an interested lead to one of the agents assigned to the
// campaign it came from. Resolves the campaign from the contact's most recent
// outbound template send, picks an agent (round-robin across the campaign's
// agent_ids, or "all" = notify every assigned agent), and WhatsApp-pings the
// agent(s) the lead's number + campaign heads-up. Best-effort end to end: any
// failure is swallowed so it can never break the inbound webhook.
//
// Returns the assigned agent name(s), or null when the campaign has no agents
// (in which case the lead stays unassigned, exactly like before this feature).
export async function distributeLead(opts: {
  conversationId: string;
  contactPhone: string; // +E.164
  contactName?: string;
  replyBody?: string;   // what the lead actually said — goes on the Pipedrive note
}): Promise<{ assigned: string[] } | null> {
  try {
    const db = supabaseAdmin();

    // Which campaign did this contact's interest come from? Their latest
    // outbound message that is linked to a campaign.
    const { data: lastOut } = await db
      .from("messages")
      .select("campaign")
      .eq("conversation", opts.conversationId)
      .eq("direction", "out")
      .not("campaign", "is", null)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (!lastOut?.campaign) return null;

    const { data: camp } = await db
      .from("campaigns")
      .select("id, name, blurb, agent_ids, distribution, rr_pointer, template_sid")
      .eq("id", lastOut.campaign)
      .maybeSingle();
    const ids: string[] = (camp?.agent_ids as string[]) || [];
    if (!camp || ids.length === 0) return null;

    const ordered = await loadAgents(db, ids);
    if (ordered.length === 0) return null;

    // "all" pings every assigned agent (owner = first). Otherwise round-robin:
    // advance the pointer ATOMICALLY in the DB first (no JS read/increment/write
    // race), then map that incremented value to an agent. Only advance for the
    // round-robin path; "all" needs no pointer.
    let pointer = 0;
    if (camp.distribution !== "all") {
      pointer = await atomicRrPointer(db, "next_campaign_rr_pointer", { p_id: camp.id });
    }
    const targets = pickTargets(ordered, camp.distribution, pointer);
    if (targets.length === 0) return null;

    // Persist the owner + source campaign on the conversation so the lead is
    // trackable (after transfer) and attributable (which campaign produced it).
    const owner = targets[0];
    const convPatch: Record<string, any> = { source_campaign_id: camp.id };
    if (owner) { convPatch.assigned_agent_id = owner.id; convPatch.assigned_at = new Date().toISOString(); }
    await db.from("conversations").update(convPatch).eq("id", opts.conversationId);
    // Give the lead a short human ref (best-effort) so alerts/replies can name it.
    // Captured BEFORE alerting so it fills {{2}} (Lead ID) in the agent template.
    const leadRef = (await ensureLeadRef(opts.conversationId)) || "";

    const leadName = opts.contactName && opts.contactName !== opts.contactPhone ? opts.contactName : "New contact";
    // What the campaign is about — the per-campaign blurb if set, else the name.
    const baseAbout = (camp.blurb && camp.blurb.trim()) ? camp.blurb.trim() : `Campaign: ${camp.name}`;
    // Tappable "see what we sent" link to the exact creative we broadcast (the
    // campaign template's header image), so the agent knows what the lead responded
    // to. Best-effort: a text-only template just yields no link.
    const sentImg = camp.template_sid ? await getContentMedia(camp.template_sid) : null;
    const about = sentImg ? `${baseAbout} · See what we sent: ${sentImg}` : baseAbout;
    // Pipedrive is the system of record for campaign leads: the deal IS the
    // hand-off, so no WhatsApp alert goes to the agent here (23 Jul 2026). The
    // round-robin still decides WHO owns it — it just owns it in the CRM.
    // Best-effort: a Pipedrive failure must never break the inbound webhook.
    // The agents are not pinged on this path, but the lead-gen tracker still is:
    // Zek gets a copy of every lead. Empty target list = nothing is deduped away.
    await ccTrackers(db, [], opts.conversationId, leadRef, leadName, opts.contactPhone, about, "WhatsApp");

    const answers: Record<string, string> = {};
    if ((opts.replyBody || "").trim()) answers["They replied"] = opts.replyBody!.trim().slice(0, 500);
    if ((camp.blurb || "").trim()) answers["Campaign is about"] = camp.blurb!.trim().slice(0, 500);
    if (sentImg) answers["What we sent them"] = sentImg;
    if (leadRef) answers["Lead ref"] = leadRef;

    let dealId: number | undefined;
    try {
      const r = await syncMetaLeadToPipedrive({
        name: leadName === "New contact" ? "" : leadName,
        e164: opts.contactPhone,
        detail: `WhatsApp campaign: ${camp.name}`,
        assignedAgent: owner?.name ?? null,
        sourceValue: "WhatsApp Campaign",
        kind: "WhatsApp campaign lead",
        titlePrefix: "WhatsApp",
        answers,
      });
      dealId = r.dealId;
    } catch { /* non-fatal */ }
    if (dealId) {
      await db.from("conversations").update({ pipedrive_deal_id: String(dealId) }).eq("id", opts.conversationId);
    }
    return { assigned: owner ? [owner.name] : [] };
  } catch {
    return null;
  }
}

// Outcome of routing a Meta lead — persisted to lead_events for tracking so no
// lead falls through unnoticed.
export type MetaLeadResult = {
  status: "routed" | "no_route" | "no_active_agents" | "alert_failed" | "error";
  ref: string | null;          // matched route ref, if any
  assigned: string[];          // agent names pinged (empty if unrouted)
  ownerId: string | null;      // owning agent's uuid — conversations.assigned_agent_id is a
                               // real FK and the inbox filters on IT, not on the name column
  alertOk: boolean;            // an assigned agent's alert was accepted by Twilio
  fallbackOk: boolean;         // the safety-net owner was notified (only on failure)
  alertSid: string | null;     // Twilio SID of the owner's alert, for delivery reconciliation
  alertError: string | null;   // why the alert send failed (if it did)
};

// Auto-distribute an inbound Meta ad lead (Instant Lead Form -> console) to the
// agent pool configured for its listing. Resolves a lead_routes row by `ref`
// (the listing/ad code, compared case-insensitively); if none is given or it does
// not match, tries to find a route whose ref appears in `detail` (the ad/campaign/
// form name). Round-robins across the route's active agents and pings them with
// the lead's number + a "From Meta Ad" heads-up that names the listing.
//
// Always returns a MetaLeadResult (never throws) so the webhook can log the
// outcome for every lead. On any failure path it pings the safety-net owner
// (LEAD_FALLBACK_WA) so a lead is never lost silently; the lead also stays hot +
// visible in the inbox Hot tab regardless.
export async function distributeMetaLead(opts: {
  conversationId?: string; // the lead's conversation, for alert-log correlation + lead_ref
  contactPhone: string; // +E.164
  contactName?: string;
  ref?: string;          // listing/ad code, e.g. "CAYAN-BH"
  detail?: string;       // campaign name, for matching + context
  listing?: string;      // specific property (ad set/ad) shown in the alert
  email?: string;        // lead's email, shown in the alert
  previewUrl?: string;   // stable public link to the exact ad creative (IG/FB permalink)
  answers?: Record<string, string>; // the form's qualifying answers, label -> value
}): Promise<MetaLeadResult> {
  const leadName = opts.contactName && opts.contactName !== opts.contactPhone ? opts.contactName : "New contact";
  const listing = (opts.listing || "").trim();
  const emailPart = opts.email && opts.email.trim() ? ` · ${opts.email.trim()}` : "";
  // The qualifying answers ride inside the existing free-text {{4}} "Enquiry"
  // variable, so the agent sees "Rent it out · Talia the Valley" in the alert
  // without a new Meta-approved template. Values only: the labels are obvious
  // in context and every character counts in a WhatsApp alert.
  const answersPart = Object.values(opts.answers || {}).filter(Boolean).join(" · ");

  // The pre-filled opener reads "about your enquiry on <q>", so q must be a
  // PLACE and nothing else — "on Rent it out · Talia the Valley" reads broken.
  // When the form asked which building/community the property is in, that beats
  // the ad-set label ("Owner Listings"), which is an internal name the owner has
  // never seen. Falls back to the ad set when no place-like answer exists.
  const placeAnswer = Object.entries(opts.answers || {})
    .find(([label]) => /building|community|area|location|project/i.test(label))?.[1]
    ?.trim() || "";
  const context = [listing || opts.detail, opts.email].filter(Boolean).join(" · ");
  // Lead ID for {{2}} in the agent template + later button-tap correlation. Captured
  // up front (before any alert or fallback) so every send path can name the lead.
  const leadRef = opts.conversationId ? (await ensureLeadRef(opts.conversationId)) || "" : "";
  try {
    const db = supabaseAdmin();

    // Load active routes and resolve the best match: exact ref first, then a route
    // whose ref token appears in the ad/campaign/form name.
    const { data: routes } = await db
      .from("lead_routes")
      .select("ref, label, agent_ids, distribution, rr_pointer")
      .eq("active", true);
    const all = (routes || []) as any[];
    const wantRef = (opts.ref || "").trim().toLowerCase();
    const detail = (opts.detail || "").toLowerCase();
    const route =
      (wantRef && all.find((r) => String(r.ref).toLowerCase() === wantRef)) ||
      (detail && all.find((r) => detail.includes(String(r.ref).toLowerCase()))) ||
      null;

    // No matching route -> safety net.
    if (!route) {
      const fallbackOk = await notifyFallback("no_route", leadRef, leadName, opts.contactPhone, context);
      return { status: "no_route", ref: null, assigned: [], ownerId: null, alertOk: false, fallbackOk, alertSid: null, alertError: null };
    }

    const ids: string[] = (route.agent_ids as string[]) || [];
    const ordered = await loadAgents(db, ids);
    // Route exists but nobody active to take it -> safety net.
    if (ordered.length === 0) {
      const fallbackOk = await notifyFallback("no_active_agents", leadRef, leadName, opts.contactPhone, context);
      return { status: "no_active_agents", ref: String(route.ref), assigned: [], ownerId: null, alertOk: false, fallbackOk, alertSid: null, alertError: null };
    }

    // Advance the route pointer ATOMICALLY (keyed by ref) before mapping to an
    // agent, so concurrent Meta leads never collide on the same agent.
    let pointer = 0;
    if (route.distribution !== "all") {
      pointer = await atomicRrPointer(db, "next_route_rr_pointer", { p_ref: String(route.ref) });
    }
    const targets = pickTargets(ordered, route.distribution, pointer);
    if (targets.length === 0) {
      const fallbackOk = await notifyFallback("no_active_agents", leadRef, leadName, opts.contactPhone, context);
      return { status: "no_active_agents", ref: String(route.ref), assigned: [], ownerId: null, alertOk: false, fallbackOk, alertSid: null, alertError: null };
    }

    // Give the agent the full context of what the lead is about: the specific
    // property they enquired about (ad set) AND the campaign it came from, so the
    // {{4}} "Enquiry" line reads e.g. "Sobha The Crest — ERE | Keeley Listings".
    // Dedupe so we never repeat the same string, and append the email if we have it.
    const place = listing || (route.label && String(route.label).trim()) || String(route.ref);
    const campaign = (opts.detail || "").trim();
    // Tappable "See the ad" link to the exact creative so the agent knows what the
    // lead responded to. Single line: WhatsApp template params can't carry newlines.
    const previewPart = (opts.previewUrl || "").trim() ? ` · See the ad: ${opts.previewUrl!.trim()}` : "";
    // Answers go BEFORE the email/ad link: what they want is the part the agent
    // acts on, and a long preview URL can push the tail out of the notification.
    const answersSuffix = answersPart ? ` · ${answersPart}` : "";
    const enquiry = [place, campaign].filter(Boolean).filter((v, i, a) => a.indexOf(v) === i).join(" — ") + answersSuffix + emailPart + previewPart;
    // Recruitment leads are candidates joining ERE — route them to the recruiter via
    // the recruit template (no property "enquiry", no sales status buttons). Detect on
    // the matched route ref or the ad/campaign name, same test as leadIngest.
    const isRecruit = /recruit/i.test(String(route.ref)) || /recruit/i.test(opts.detail || "");
    const recruitSource = [campaign || (route.label && String(route.label).trim()) || String(route.ref), opts.email && opts.email.trim(), (opts.previewUrl || "").trim() ? `See the ad: ${opts.previewUrl!.trim()}` : ""].filter(Boolean).join(" · ");
    const results = isRecruit
      ? await alertRecruiters(targets, leadName, opts.contactPhone, recruitSource)
      // `place` = the specific property, named in the one-tap reply opener.
      // previewUrl rides along so the opener also carries the ad itself.
      // A one-character answer ("t") is a mis-tap, not a community — it would
      // produce "about your enquiry on t". Require something plausible.
      : await alertAgents(targets, leadRef, leadName, opts.contactPhone, enquiry,
          placeAnswer.length >= 3 ? placeAnswer : place, opts.previewUrl || null);
    const assigned = results.map((r) => r.name);
    const alertOk = results.some((r) => r.ok);
    const alertSid = results.find((r) => r.ok)?.sid ?? null;
    const alertError = results.find((r) => r.error)?.error ?? null;

    // Log each successful alert + ensure a lead_ref, so a later button tap maps
    // back to THIS lead. Only when we know the conversation (caller passes it).
    // Recruitment alerts carry no status buttons, so nothing to correlate — skip.
    if (opts.conversationId && !isRecruit) {
      for (const r of results) {
        if (r.ok) await logAgentAlert(db, { agentId: r.id, agentWa: r.wa, conversationId: opts.conversationId, alertSid: r.sid });
      }
    }

    // CC the global lead-gen tracker(s) with a copy of every lead, deduped — for
    // both sales and recruitment leads, so the monitor sees 100% of them.
    await ccTrackers(db, targets.map((t) => t.wa_number), opts.conversationId, leadRef, leadName, opts.contactPhone, isRecruit ? `Recruitment · ${recruitSource}` : enquiry, "Meta");

    // Agent(s) chosen but no alert got through -> safety net so it is not silent.
    if (!alertOk) {
      const fallbackOk = await notifyFallback("alert_failed", leadRef, leadName, opts.contactPhone, `${context} (agent: ${assigned.join(", ")})`);
      return { status: "alert_failed", ref: String(route.ref), assigned, ownerId: targets[0]?.id ?? null, alertOk: false, fallbackOk, alertSid: null, alertError };
    }
    return { status: "routed", ref: String(route.ref), assigned, ownerId: targets[0]?.id ?? null, alertOk: true, fallbackOk: false, alertSid, alertError: null };
  } catch {
    // Unexpected error -> still try the safety net, never throw into the webhook.
    const fallbackOk = await notifyFallback("error", leadRef, leadName, opts.contactPhone, context).catch(() => false);
    return { status: "error", ref: null, assigned: [], ownerId: null, alertOk: false, fallbackOk, alertSid: null, alertError: null };
  }
}
