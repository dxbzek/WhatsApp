import { supabaseAdmin } from "@/lib/supabase";
import { sendWhatsApp, sendTemplate, getContentMedia } from "@/lib/twilio";
import { ensureLeadRef } from "@/lib/leadRef";

// Unified agent lead-alert template on the UTILITY subaccount (category UTILITY,
// so it is exempt from Meta's per-recipient MARKETING throttle that silently drops
// bursts with error 63049). Variables:
//   {{1}} agent name, {{2}} lead ID (lead_ref), {{3}} lead name, {{4}} number,
//   {{5}} source (what the lead responded to + any tappable link).
// Its quick-reply buttons Contacted / Viewing / Won / Lost feed handleAgentReport,
// which moves the lead's stage. The old parent-account SIDs (ere_meta_lead_alert +
// the WA-campaign alert) are DEAD after the utility repoint — never reintroduce them.
// Env-overridable so we can flip to the new status-button template
// (ere_lead_status_alert: Interested / No answer / Not interested / Broker) the
// moment WhatsApp approves it, WITHOUT a code deploy — just set AGENT_LEAD_ALERT_SID
// in Vercel. Falls back to the current v2 (Contacted/Viewing/Won/Lost) until then.
const AGENT_LEAD_ALERT_SID = (process.env.AGENT_LEAD_ALERT_SID || "HXe1b69d2c15b5cf888655ce75bba4ec23").trim();

// Dedicated recruitment alert (utility subaccount, text-only, NO status buttons).
// Recruitment leads are candidates applying to JOIN ERE, not property enquiries, so
// they get their own recruiter-facing template instead of the sales-pipeline alert.
// Vars: {{1}} recruiter name, {{2}} candidate name, {{3}} number, {{4}} source.
const RECRUIT_LEAD_ALERT_SID = "HXd53adb11d39bab9a6a9f72df5f7a9c02";

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
async function sendAgentAlert(agentName: string, toWa: string, leadRef: string, leadName: string, contactPhone: string, source: string): Promise<AlertOutcome> {
  try {
    const r: any = await sendTemplate(toWa, AGENT_LEAD_ALERT_SID, {
      "1": agentName, "2": leadRef || "—", "3": leadName, "4": contactPhone, "5": source,
    });
    return { ok: true, sid: r?.sid || null, error: null };
  } catch (e: any) {
    return { ok: false, sid: null, error: String(e?.message || e).slice(0, 200) };
  }
}

// Ping a single agent's WhatsApp with a lead alert/reminder (used by the stale-lead
// watcher). Reuses the approved UTILITY alert template.
export async function pingAgent(agentName: string, wa_number: string, leadRef: string, leadName: string, contactPhone: string, source: string): Promise<boolean> {
  return (await sendAgentAlert(agentName, wa_number, leadRef, leadName, contactPhone, source)).ok;
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
async function alertAgents(targets: Agent[], leadRef: string, leadName: string, contactPhone: string, source: string): Promise<{ id: string; name: string; wa: string; ok: boolean; sid: string | null; error: string | null }[]> {
  const results: { id: string; name: string; wa: string; ok: boolean; sid: string | null; error: string | null }[] = [];
  for (const a of targets) {
    const r = await sendAgentAlert(a.name, a.wa_number, leadRef, leadName, contactPhone, source);
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
// as an assigned agent (dedupe by digits) so no one is pinged twice. The alert's
// source line is prefixed [TRACKER] so the monitor can tell a copy from a lead
// that is actually theirs to work. Best-effort: never breaks routing.
async function ccTrackers(
  db: ReturnType<typeof supabaseAdmin>,
  alreadyAlertedWa: string[],
  conversationId: string | undefined,
  leadRef: string, leadName: string, contactPhone: string, source: string,
): Promise<void> {
  try {
    if (LEAD_TRACKER_WA.length === 0) return;
    const digits = (w: string) => w.replace(/[^0-9]/g, "");
    const seen = new Set(alreadyAlertedWa.map(digits));
    const src = `[TRACKER] ${source}`;
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
    const results = await alertAgents(targets, leadRef, leadName, opts.contactPhone, about);
    // Log each successful alert so a later button tap maps back to THIS lead.
    for (const r of results) {
      if (r.ok) await logAgentAlert(db, { agentId: r.id, agentWa: r.wa, conversationId: opts.conversationId, alertSid: r.sid });
    }
    // CC the global lead-gen tracker(s) with a copy of every lead, deduped.
    await ccTrackers(db, targets.map((t) => t.wa_number), opts.conversationId, leadRef, leadName, opts.contactPhone, about);
    return { assigned: results.map((r) => r.name) };
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
}): Promise<MetaLeadResult> {
  const leadName = opts.contactName && opts.contactName !== opts.contactPhone ? opts.contactName : "New contact";
  const listing = (opts.listing || "").trim();
  const emailPart = opts.email && opts.email.trim() ? ` · ${opts.email.trim()}` : "";
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
      return { status: "no_route", ref: null, assigned: [], alertOk: false, fallbackOk, alertSid: null, alertError: null };
    }

    const ids: string[] = (route.agent_ids as string[]) || [];
    const ordered = await loadAgents(db, ids);
    // Route exists but nobody active to take it -> safety net.
    if (ordered.length === 0) {
      const fallbackOk = await notifyFallback("no_active_agents", leadRef, leadName, opts.contactPhone, context);
      return { status: "no_active_agents", ref: String(route.ref), assigned: [], alertOk: false, fallbackOk, alertSid: null, alertError: null };
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
      return { status: "no_active_agents", ref: String(route.ref), assigned: [], alertOk: false, fallbackOk, alertSid: null, alertError: null };
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
    const enquiry = [place, campaign].filter(Boolean).filter((v, i, a) => a.indexOf(v) === i).join(" — ") + emailPart + previewPart;
    // Recruitment leads are candidates joining ERE — route them to the recruiter via
    // the recruit template (no property "enquiry", no sales status buttons). Detect on
    // the matched route ref or the ad/campaign name, same test as leadIngest.
    const isRecruit = /recruit/i.test(String(route.ref)) || /recruit/i.test(opts.detail || "");
    const recruitSource = [campaign || (route.label && String(route.label).trim()) || String(route.ref), opts.email && opts.email.trim(), (opts.previewUrl || "").trim() ? `See the ad: ${opts.previewUrl!.trim()}` : ""].filter(Boolean).join(" · ");
    const results = isRecruit
      ? await alertRecruiters(targets, leadName, opts.contactPhone, recruitSource)
      : await alertAgents(targets, leadRef, leadName, opts.contactPhone, enquiry);
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
    await ccTrackers(db, targets.map((t) => t.wa_number), opts.conversationId, leadRef, leadName, opts.contactPhone, isRecruit ? `Recruitment · ${recruitSource}` : enquiry);

    // Agent(s) chosen but no alert got through -> safety net so it is not silent.
    if (!alertOk) {
      const fallbackOk = await notifyFallback("alert_failed", leadRef, leadName, opts.contactPhone, `${context} (agent: ${assigned.join(", ")})`);
      return { status: "alert_failed", ref: String(route.ref), assigned, alertOk: false, fallbackOk, alertSid: null, alertError };
    }
    return { status: "routed", ref: String(route.ref), assigned, alertOk: true, fallbackOk: false, alertSid, alertError: null };
  } catch {
    // Unexpected error -> still try the safety net, never throw into the webhook.
    const fallbackOk = await notifyFallback("error", leadRef, leadName, opts.contactPhone, context).catch(() => false);
    return { status: "error", ref: null, assigned: [], alertOk: false, fallbackOk, alertSid: null, alertError: null };
  }
}
