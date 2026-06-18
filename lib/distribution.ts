import { supabaseAdmin } from "@/lib/supabase";
import { sendWhatsApp } from "@/lib/twilio";
import { setLeadOwner } from "@/lib/pipedrive";

// Auto-distribute an interested lead to one of the agents assigned to the
// campaign it came from. Resolves the campaign from the contact's most recent
// outbound template send, picks an agent (round-robin across the campaign's
// agent_ids, or "all" = notify every assigned agent), sets the Pipedrive lead
// owner, and WhatsApp-pings the agent(s). Best-effort end to end: any failure
// is swallowed so it can never break the inbound webhook.
//
// Returns the assigned agent name(s), or null when the campaign has no agents
// (in which case the lead stays unassigned, exactly like before this feature).
export async function distributeLead(opts: {
  conversationId: string;
  leadId?: string | null;
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

    // Owner = the first target. Set it in Pipedrive if we know the user id.
    const owner = targets[0];
    if (opts.leadId && owner?.pipedrive_user_id) {
      try { await setLeadOwner(opts.leadId, Number(owner.pipedrive_user_id)); } catch { /* non-fatal */ }
    }

    const leadName = opts.contactName && opts.contactName !== opts.contactPhone ? opts.contactName : "New contact";
    // What the campaign is about — the per-campaign blurb if set, else the name.
    const about = (camp.blurb && camp.blurb.trim()) ? camp.blurb.trim() : `Campaign: ${camp.name}`;
    // Phone on its own line so it is tap-to-call / easy to copy in WhatsApp.
    const msg =
      `New lead 🔥 — ${leadName}\n\n` +
      `${opts.contactPhone}\n` +
      `${about}\n\n` +
      `They just tapped Interested on our WhatsApp. Give them a call or message now while it is hot.`;
    const assigned: string[] = [];
    for (const a of targets) {
      try { await sendWhatsApp(a.wa_number, msg); } catch { /* 24h window may be closed */ }
      assigned.push(a.name);
    }
    return { assigned };
  } catch {
    return null;
  }
}
