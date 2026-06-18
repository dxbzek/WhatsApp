import { supabaseAdmin } from "@/lib/supabase";
import { sendWhatsApp, sendTemplate } from "@/lib/twilio";

// Approved "lead alert" template (Utility). Lets us notify an agent any time,
// not just inside their 24h WhatsApp window. Variables: {{1}} lead name,
// {{2}} number, {{3}} campaign heads-up.
const LEAD_ALERT_CONTENT_SID = "HXc2cd73732854096291ff396e13c5cb73";

type Agent = { id: string; name: string; wa_number: string; pipedrive_user_id?: string | null; active?: boolean };

// Ping each target agent with the lead. Prefer the approved template (works any
// time); if it is rejected — e.g. still pending — fall back to free text, which
// only delivers inside an open 24h window. Best-effort: a per-agent failure is
// swallowed so one bad number never blocks the rest. Returns the names pinged.
async function alertAgents(targets: Agent[], leadName: string, contactPhone: string, about: string): Promise<string[]> {
  const vars = { "1": leadName, "2": contactPhone, "3": about };
  const fallback =
    `New ERE lead from WhatsApp.\n\n` +
    `Name: ${leadName}\nNumber: ${contactPhone}\nCampaign: ${about}\n\n` +
    `They just came in. Call or message them now while it is hot.`;
  const assigned: string[] = [];
  for (const a of targets) {
    try {
      await sendTemplate(a.wa_number, LEAD_ALERT_CONTENT_SID, vars);
    } catch {
      try { await sendWhatsApp(a.wa_number, fallback); } catch { /* window may be closed */ }
    }
    assigned.push(a.name);
  }
  return assigned;
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
    const assigned = await alertAgents(targets, leadName, opts.contactPhone, about);
    return { assigned };
  } catch {
    return null;
  }
}

// Auto-distribute an inbound Meta ad lead (Instant Lead Form -> console) to the
// agent pool configured for its listing. Resolves a lead_routes row by `ref`
// (the listing/ad code, compared case-insensitively); if none is given or it does
// not match, tries to find a route whose ref appears in `detail` (the ad/campaign/
// form name). Round-robins across the route's active agents and pings them with
// the lead's number + a "From Meta Ad" heads-up that names the listing.
//
// Best-effort end to end: any failure is swallowed so it can never break the lead
// webhook. Returns the assigned agent name(s), or null when no route/agent matches
// (the lead stays hot + unassigned in the inbox Hot tab, never silently dropped).
export async function distributeMetaLead(opts: {
  contactPhone: string; // +E.164
  contactName?: string;
  ref?: string;          // listing/ad code, e.g. "CAYAN-BH"
  detail?: string;       // ad / campaign / form name, for matching + context
}): Promise<{ assigned: string[]; ref: string | null } | null> {
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
    if (!route) return null;

    const ids: string[] = (route.agent_ids as string[]) || [];
    const ordered = await loadAgents(db, ids);
    if (ordered.length === 0) return null;

    const { targets, nextPointer } = pickTargets(ordered, route.distribution, route.rr_pointer ?? 0);
    if (route.distribution !== "all") {
      await db.from("lead_routes").update({ rr_pointer: nextPointer }).eq("ref", route.ref);
    }

    const leadName = opts.contactName && opts.contactName !== opts.contactPhone ? opts.contactName : "New contact";
    const label = (route.label && String(route.label).trim()) || (opts.detail && opts.detail.trim()) || String(route.ref);
    const about = `From Meta Ad: ${label}`;
    const assigned = await alertAgents(targets, leadName, opts.contactPhone, about);
    return { assigned, ref: String(route.ref) };
  } catch {
    return null;
  }
}
