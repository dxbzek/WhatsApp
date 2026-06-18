import { supabaseAdmin } from "@/lib/supabase";
import { sendWhatsApp, sendTemplate } from "@/lib/twilio";

// Approved "lead alert" template (Utility). Lets us notify an agent any time,
// not just inside their 24h WhatsApp window. Variables: {{1}} lead name,
// {{2}} number, {{3}} campaign heads-up.
const LEAD_ALERT_CONTENT_SID = "HXc2cd73732854096291ff396e13c5cb73";

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

    // Load the active agents for this campaign, preserving the configured order.
    const { data: agentRows } = await db
      .from("agents")
      .select("id, name, wa_number, pipedrive_user_id, active")
      .in("id", ids)
      .eq("active", true);
    const byId = new Map((agentRows || []).map((a: any) => [a.id, a]));
    const ordered = ids.map((id) => byId.get(id)).filter(Boolean) as any[];
    if (ordered.length === 0) return null;

    // "all" pings every assigned agent (owner = first). Otherwise round-robin:
    // pick by the campaign pointer and advance it so assignment stays even.
    let targets: any[];
    if (camp.distribution === "all") {
      targets = ordered;
    } else {
      const idx = (camp.rr_pointer ?? 0) % ordered.length;
      targets = [ordered[idx]];
      await db.from("campaigns").update({ rr_pointer: (camp.rr_pointer ?? 0) + 1 }).eq("id", camp.id);
    }

    const leadName = opts.contactName && opts.contactName !== opts.contactPhone ? opts.contactName : "New contact";
    // What the campaign is about — the per-campaign blurb if set, else the name.
    const about = (camp.blurb && camp.blurb.trim()) ? camp.blurb.trim() : `Campaign: ${camp.name}`;
    const vars = { "1": leadName, "2": opts.contactPhone, "3": about };
    // Free-text version of the same alert, for the fallback path.
    const fallback =
      `New ERE lead from WhatsApp.\n\n` +
      `Name: ${leadName}\nNumber: ${opts.contactPhone}\nCampaign: ${about}\n\n` +
      `They just tapped Interested. Call or message them now while it is hot.`;
    const assigned: string[] = [];
    for (const a of targets) {
      // Prefer the approved template (works any time). If it is rejected — e.g.
      // still pending approval — fall back to free text, which delivers when the
      // agent already has an open 24h window.
      try {
        await sendTemplate(a.wa_number, LEAD_ALERT_CONTENT_SID, vars);
      } catch {
        try { await sendWhatsApp(a.wa_number, fallback); } catch { /* window may be closed */ }
      }
      assigned.push(a.name);
    }
    return { assigned };
  } catch {
    return null;
  }
}
