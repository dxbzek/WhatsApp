import { supabaseAdmin } from "@/lib/supabase";
import { sendWhatsApp, sendTemplate, getContentMedia } from "@/lib/twilio";
import { ensureLeadRef } from "@/lib/leadRef";

// Approved agent lead-alert template (category UTILITY, so it is exempt from Meta's
// per-recipient MARKETING throttle that silently drops bursts with error 63049).
// Variables: {{1}} agent name, {{2}} lead name, {{3}} number, {{4}} ad set/campaign + preview link.
// Hardcoded on purpose: a stale META_LEAD_ALERT_SID env var pointing at an
// UNAPPROVED template was the original silent-failure bug. The old MARKETING
// template (ere_lead_alert) was deleted — never reintroduce a non-UTILITY alert.
const META_LEAD_ALERT_SID = "HX031a430ae0b08ec0cd081c92c3dcbe98";

// Approved WhatsApp-campaign lead-alert template (category UTILITY). For leads who
// tapped a button on one of our WhatsApp broadcasts (vs a Meta lead form). Variables:
// {{1}} agent name, {{2}} lead name, {{3}} number, {{4}} what they responded to + "see what we sent" link.
const WA_LEAD_ALERT_SID = "HX15dc0ab3d6557582da6cab535d77ded6";

// AGENT_LEAD_ALERT_SID (pending approval, not wired yet)
// New unified agent lead-alert template; once Meta approves it this can replace
// both SIDs above. Until then we keep using META_LEAD_ALERT_SID / WA_LEAD_ALERT_SID.
// const AGENT_LEAD_ALERT_SID = "HX9866d614203dd8a9c3f503402ee76032";

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

// Send the lead-alert to one WhatsApp number. Routes through the SAME approved
// UTILITY template as the Meta path (sendMetaAlert) so it is exempt from Meta's
// per-recipient MARKETING throttle (63049) that was silently dropping campaign +
// stale-nudge alerts on the old MARKETING template. Returns true if accepted.
async function sendAlert(agentName: string, toWa: string, leadName: string, contactPhone: string, about: string): Promise<AlertOutcome> {
  try {
    // Approved UTILITY WhatsApp-campaign template (accurate "new ERE lead from WhatsApp" wording).
    const r: any = await sendTemplate(toWa, WA_LEAD_ALERT_SID, { "1": agentName, "2": leadName, "3": contactPhone, "4": about });
    return { ok: true, sid: r?.sid || null, error: null };
  } catch {
    // Fall back to the approved Meta UTILITY template if the WA one ever fails.
    return sendMetaAlert(agentName, toWa, leadName, contactPhone, about);
  }
}

// Ping a single agent's WhatsApp with a lead reminder/alert (used by the
// stale-lead watcher). Reuses the approved UTILITY alert template.
export async function pingAgent(agentName: string, wa_number: string, leadName: string, contactPhone: string, about: string): Promise<boolean> {
  return (await sendAlert(agentName, wa_number, leadName, contactPhone, about)).ok;
}

// Meta-ad lead alert — its OWN variant so the agent can tell a Meta form lead
// apart from a WhatsApp-interest lead, and personalised with the agent's name.
// Prefers the dedicated Meta template (META_LEAD_ALERT_SID, vars 1=agent name,
// 2=lead name, 3=number, 4=enquiry); until that template is approved + its SID
// is set, it sends via the existing approved alert template so delivery is never
// lost, and on any rejection falls back to Meta-worded free text (24h window).
type AlertOutcome = { ok: boolean; sid: string | null; error: string | null };
async function sendMetaAlert(agentName: string, toWa: string, leadName: string, contactPhone: string, enquiry: string): Promise<AlertOutcome> {
  try {
    // Approved UTILITY template (not throttled). 4 vars: agent, lead, number, ad set/campaign + preview.
    const r: any = await sendTemplate(toWa, META_LEAD_ALERT_SID, { "1": agentName, "2": leadName, "3": contactPhone, "4": enquiry });
    return { ok: true, sid: r?.sid || null, error: null };
  } catch (e: any) {
    // No throttled-MARKETING fallback by design: a failure here is rare (the UTILITY
    // template is reliable), and the caller still pings the safety-net owner + the
    // lead stays hot in the inbox. Record the real error instead of a silent drop.
    return { ok: false, sid: null, error: String(e?.message || e).slice(0, 200) };
  }
}

// Ping each Meta-lead target agent, personalised by name. Mirrors alertAgents.
async function alertMetaAgents(targets: Agent[], leadName: string, contactPhone: string, enquiry: string): Promise<{ id: string; name: string; wa: string; ok: boolean; sid: string | null; error: string | null }[]> {
  const results: { id: string; name: string; wa: string; ok: boolean; sid: string | null; error: string | null }[] = [];
  for (const a of targets) {
    const r = await sendMetaAlert(a.name, a.wa_number, leadName, contactPhone, enquiry);
    results.push({ id: a.id, name: a.name, wa: a.wa_number, ...r });
  }
  return results;
}

// Ping each target agent with the lead. Best-effort: a per-agent failure never
// blocks the rest. Returns { name, ok } per agent so the caller knows whether the
// alert actually reached at least one of them.
async function alertAgents(targets: Agent[], leadName: string, contactPhone: string, about: string): Promise<{ id: string; name: string; wa: string; ok: boolean; sid: string | null }[]> {
  const results: { id: string; name: string; wa: string; ok: boolean; sid: string | null }[] = [];
  for (const a of targets) {
    const r = await sendAlert(a.name, a.wa_number, leadName, contactPhone, about);
    results.push({ id: a.id, name: a.name, wa: a.wa_number, ok: r.ok, sid: r.sid });
  }
  return results;
}

// Safety net: when a lead cannot reach its assigned agent (no route, no active
// agents, or every agent alert failed), ping the fallback owner (LEAD_FALLBACK_WA)
// so a lead is NEVER lost silently. Returns true if the fallback was notified.
async function notifyFallback(reason: string, leadName: string, contactPhone: string, context: string): Promise<boolean> {
  const to = (process.env.LEAD_FALLBACK_WA || "").trim();
  if (!to) return false;
  const about = `UNROUTED (${reason})${context ? ` — ${context}` : ""}. Reassign this lead.`;
  return (await sendMetaAlert("team", to, leadName, contactPhone, about)).ok;
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
    await ensureLeadRef(opts.conversationId);

    const leadName = opts.contactName && opts.contactName !== opts.contactPhone ? opts.contactName : "New contact";
    // What the campaign is about — the per-campaign blurb if set, else the name.
    const baseAbout = (camp.blurb && camp.blurb.trim()) ? camp.blurb.trim() : `Campaign: ${camp.name}`;
    // Tappable "see what we sent" link to the exact creative we broadcast (the
    // campaign template's header image), so the agent knows what the lead responded
    // to. Best-effort: a text-only template just yields no link.
    const sentImg = camp.template_sid ? await getContentMedia(camp.template_sid) : null;
    const about = sentImg ? `${baseAbout} · See what we sent: ${sentImg}` : baseAbout;
    const results = await alertAgents(targets, leadName, opts.contactPhone, about);
    // Log each successful alert so a later button tap maps back to THIS lead.
    for (const r of results) {
      if (r.ok) await logAgentAlert(db, { agentId: r.id, agentWa: r.wa, conversationId: opts.conversationId, alertSid: r.sid });
    }
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
      const fallbackOk = await notifyFallback("no_route", leadName, opts.contactPhone, context);
      return { status: "no_route", ref: null, assigned: [], alertOk: false, fallbackOk, alertSid: null, alertError: null };
    }

    const ids: string[] = (route.agent_ids as string[]) || [];
    const ordered = await loadAgents(db, ids);
    // Route exists but nobody active to take it -> safety net.
    if (ordered.length === 0) {
      const fallbackOk = await notifyFallback("no_active_agents", leadName, opts.contactPhone, context);
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
      const fallbackOk = await notifyFallback("no_active_agents", leadName, opts.contactPhone, context);
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
    const results = await alertMetaAgents(targets, leadName, opts.contactPhone, enquiry);
    const assigned = results.map((r) => r.name);
    const alertOk = results.some((r) => r.ok);
    const alertSid = results.find((r) => r.ok)?.sid ?? null;
    const alertError = results.find((r) => r.error)?.error ?? null;

    // Log each successful alert + ensure a lead_ref, so a later button tap maps
    // back to THIS lead. Only when we know the conversation (caller passes it).
    if (opts.conversationId) {
      for (const r of results) {
        if (r.ok) await logAgentAlert(db, { agentId: r.id, agentWa: r.wa, conversationId: opts.conversationId, alertSid: r.sid });
      }
      await ensureLeadRef(opts.conversationId);
    }

    // Agent(s) chosen but no alert got through -> safety net so it is not silent.
    if (!alertOk) {
      const fallbackOk = await notifyFallback("alert_failed", leadName, opts.contactPhone, `${context} (agent: ${assigned.join(", ")})`);
      return { status: "alert_failed", ref: String(route.ref), assigned, alertOk: false, fallbackOk, alertSid: null, alertError };
    }
    return { status: "routed", ref: String(route.ref), assigned, alertOk: true, fallbackOk: false, alertSid, alertError: null };
  } catch {
    // Unexpected error -> still try the safety net, never throw into the webhook.
    const fallbackOk = await notifyFallback("error", leadName, opts.contactPhone, context).catch(() => false);
    return { status: "error", ref: null, assigned: [], alertOk: false, fallbackOk, alertSid: null, alertError: null };
  }
}
