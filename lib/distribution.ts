import { supabaseAdmin } from "@/lib/supabase";
import { sendWhatsApp, sendTemplate } from "@/lib/twilio";

// Approved "lead alert" template (Utility). Lets us notify an agent any time,
// not just inside their 24h WhatsApp window. Variables: {{1}} lead name,
// {{2}} number, {{3}} campaign heads-up.
const LEAD_ALERT_CONTENT_SID = "HXc2cd73732854096291ff396e13c5cb73";

type Agent = { id: string; name: string; wa_number: string; pipedrive_user_id?: string | null; active?: boolean };

// Send the lead-alert to one WhatsApp number. Prefer the approved template (works
// any time); if it is rejected — e.g. still pending — fall back to free text,
// which only delivers inside an open 24h window. Returns true if either send was
// accepted by Twilio (so the caller can tell a real delivery failure from a hit).
async function sendAlert(toWa: string, leadName: string, contactPhone: string, about: string): Promise<boolean> {
  const vars = { "1": leadName, "2": contactPhone, "3": about };
  const fallback =
    `New ERE lead from WhatsApp.\n\n` +
    `Name: ${leadName}\nNumber: ${contactPhone}\nCampaign: ${about}\n\n` +
    `They just came in. Call or message them now while it is hot.`;
  try {
    await sendTemplate(toWa, LEAD_ALERT_CONTENT_SID, vars);
    return true;
  } catch {
    try { await sendWhatsApp(toWa, fallback); return true; } catch { return false; }
  }
}

// Ping each target agent with the lead. Best-effort: a per-agent failure never
// blocks the rest. Returns { name, ok } per agent so the caller knows whether the
// alert actually reached at least one of them.
async function alertAgents(targets: Agent[], leadName: string, contactPhone: string, about: string): Promise<{ name: string; ok: boolean }[]> {
  const results: { name: string; ok: boolean }[] = [];
  for (const a of targets) {
    const ok = await sendAlert(a.wa_number, leadName, contactPhone, about);
    results.push({ name: a.name, ok });
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
  return sendAlert(to, leadName, contactPhone, about);
}

// Pick the target agent(s) from an ordered pool: "all" notifies everyone (owner =
// first); otherwise round-robin by `pointer`. Returns the chosen agents plus the
// next pointer value to persist (so assignment stays even across calls).
function pickTargets(ordered: Agent[], distribution: string | null | undefined, pointer: number): { targets: Agent[]; nextPointer: number } {
  if (distribution === "all") return { targets: ordered, nextPointer: pointer };
  const idx = (pointer ?? 0) % ordered.length;
  return { targets: [ordered[idx]], nextPointer: (pointer ?? 0) + 1 };
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
      .select("id, name, blurb, agent_ids, distribution, rr_pointer")
      .eq("id", lastOut.campaign)
      .maybeSingle();
    const ids: string[] = (camp?.agent_ids as string[]) || [];
    if (!camp || ids.length === 0) return null;

    const ordered = await loadAgents(db, ids);
    if (ordered.length === 0) return null;

    // "all" pings every assigned agent (owner = first). Otherwise round-robin:
    // pick by the campaign pointer and advance it so assignment stays even.
    const { targets, nextPointer } = pickTargets(ordered, camp.distribution, camp.rr_pointer ?? 0);
    if (camp.distribution !== "all") {
      await db.from("campaigns").update({ rr_pointer: nextPointer }).eq("id", camp.id);
    }

    const leadName = opts.contactName && opts.contactName !== opts.contactPhone ? opts.contactName : "New contact";
    // What the campaign is about — the per-campaign blurb if set, else the name.
    const about = (camp.blurb && camp.blurb.trim()) ? camp.blurb.trim() : `Campaign: ${camp.name}`;
    const results = await alertAgents(targets, leadName, opts.contactPhone, about);
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
  contactPhone: string; // +E.164
  contactName?: string;
  ref?: string;          // listing/ad code, e.g. "CAYAN-BH"
  detail?: string;       // ad / campaign / form name, for matching + context
}): Promise<MetaLeadResult> {
  const leadName = opts.contactName && opts.contactName !== opts.contactPhone ? opts.contactName : "New contact";
  const context = [opts.ref, opts.detail].filter(Boolean).join(" · ");
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
      return { status: "no_route", ref: null, assigned: [], alertOk: false, fallbackOk };
    }

    const ids: string[] = (route.agent_ids as string[]) || [];
    const ordered = await loadAgents(db, ids);
    // Route exists but nobody active to take it -> safety net.
    if (ordered.length === 0) {
      const fallbackOk = await notifyFallback("no_active_agents", leadName, opts.contactPhone, context);
      return { status: "no_active_agents", ref: String(route.ref), assigned: [], alertOk: false, fallbackOk };
    }

    const { targets, nextPointer } = pickTargets(ordered, route.distribution, route.rr_pointer ?? 0);
    if (route.distribution !== "all") {
      await db.from("lead_routes").update({ rr_pointer: nextPointer }).eq("ref", route.ref);
    }

    const label = (route.label && String(route.label).trim()) || (opts.detail && opts.detail.trim()) || String(route.ref);
    const about = `From Meta Ad: ${label}`;
    const results = await alertAgents(targets, leadName, opts.contactPhone, about);
    const assigned = results.map((r) => r.name);
    const alertOk = results.some((r) => r.ok);

    // Agent(s) chosen but no alert got through -> safety net so it is not silent.
    if (!alertOk) {
      const fallbackOk = await notifyFallback("alert_failed", leadName, opts.contactPhone, `${context} (agent: ${assigned.join(", ")})`);
      return { status: "alert_failed", ref: String(route.ref), assigned, alertOk: false, fallbackOk };
    }
    return { status: "routed", ref: String(route.ref), assigned, alertOk: true, fallbackOk: false };
  } catch {
    // Unexpected error -> still try the safety net, never throw into the webhook.
    const fallbackOk = await notifyFallback("error", leadName, opts.contactPhone, context).catch(() => false);
    return { status: "error", ref: null, assigned: [], alertOk: false, fallbackOk };
  }
}
