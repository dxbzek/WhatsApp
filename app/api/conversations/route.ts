import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

// Read/update WhatsApp conversations through the service role, behind the app
// login gate (middleware). The browser must NOT touch this table with the public
// anon key (RLS denies anon), so the inbox/dashboard/suppressed/sidebar call this
// route instead. Each view keeps its query thin and explicit.
export async function GET(req: NextRequest) {
  try {
    const db = supabaseAdmin();
    const sp = req.nextUrl.searchParams;
    const view = sp.get("view") || "inbox";

    if (view === "unreadCount") {
      // Only ACTIONABLE unread — a blocked/invalid contact lives in Suppressed,
      // not the inbox, so it must not inflate the sidebar badge.
      const { count, error } = await db.from("conversations").select("id", { count: "exact", head: true })
        .eq("unread", true).eq("is_internal", false).not("status", "in", "(blocked,invalid)");
      if (error) throw new Error(error.message);
      return NextResponse.json({ count: count ?? 0 });
    }

    if (view === "recent") {
      const limit = Math.min(200, Number(sp.get("limit")) || 50);
      // Only conversations we've actually messaged or heard from (last_at set).
      // A drip pre-creates a row per recipient while their send is still
      // scheduled; those have no activity yet and must not surface here.
      const { data, error } = await db.from("conversations").select("*")
        .not("last_at", "is", null).eq("is_internal", false)
        .order("last_at", { ascending: false }).limit(limit);
      if (error) throw new Error(error.message);
      return NextResponse.json({ conversations: data || [] });
    }

    if (view === "leads") {
      const { data, error } = await db.from("conversations").select("id,lead_status")
        .eq("is_internal", false).in("lead_status", ["hot", "warm"]);
      if (error) throw new Error(error.message);
      return NextResponse.json({ conversations: data || [] });
    }

    if (view === "waiting") {
      // People whose LAST message is inbound = they messaged us and we haven't
      // replied since. The dashboard's daily action list. Suppressed contacts
      // excluded. Caller computes 24h-window open/closed from last_at.
      const limit = Math.min(100, Number(sp.get("limit")) || 50);
      const { data, error } = await db.from("conversations")
        .select("id, wa_phone, name, last_body, last_at, lead_status, unread")
        .eq("last_direction", "in").eq("is_internal", false)
        .not("status", "in", "(blocked,invalid)")
        .order("last_at", { ascending: false }).limit(limit);
      if (error) throw new Error(error.message);
      return NextResponse.json({ conversations: data || [] });
    }

    if (view === "suppressed") {
      const { data, error } = await db.from("conversations").select("id, wa_phone, name, status, last_at, suppressed_at")
        .eq("is_internal", false).in("status", ["blocked", "invalid"]).order("suppressed_at", { ascending: false, nullsFirst: false }).limit(1000);
      if (error) throw new Error(error.message);
      return NextResponse.json({ conversations: data || [] });
    }

    if (view === "by-status") {
      // Leads grouped by stage for the Lead Status page. GENUINE leads only —
      // not every broadcast recipient. Every drip/broadcast contact is a
      // conversation with lead_status defaulted to 'new' and source_campaign_id/
      // lead_ref set, so those are NOT discriminators. A real lead is someone who
      // engaged or was worked: they replied, were classified hot/warm, were
      // assigned an agent, have a pipeline stage, or came in via a Meta lead form.
      // Without this filter the board floods with ~7.5k "Not Contacted Yet" rows.
      const { data, error } = await db.from("conversations")
        .select("id, wa_phone, name, lead_ref, lead_status, lead_stage, stage_updated_at, assigned_agent_id, assigned_at, source, source_campaign_id, created_at")
        .eq("is_internal", false)
        .not("status", "in", "(blocked,invalid)")
        .or("replied.eq.true,lead_status.eq.hot,lead_status.eq.warm,assigned_agent_id.not.is.null,lead_stage.not.is.null,source.eq.meta_lead_form")
        .order("stage_updated_at", { ascending: false, nullsFirst: false })
        .limit(2000);
      if (error) throw new Error(error.message);
      const rows = data || [];

      // Resolve agent names for the assigned_agent_id set.
      const agentIds = Array.from(new Set(rows.map((r: any) => r.assigned_agent_id).filter(Boolean)));
      const agentName = new Map<string, string>();
      if (agentIds.length) {
        const { data: ags } = await db.from("agents").select("id, name").in("id", agentIds);
        for (const a of ags || []) agentName.set(a.id, a.name);
      }

      // Resolve campaign names for the source_campaign_id set (for the "source" label).
      const campIds = Array.from(new Set(rows.map((r: any) => r.source_campaign_id).filter(Boolean)));
      const campName = new Map<string, string>();
      if (campIds.length) {
        const { data: cs } = await db.from("campaigns").select("id, name").in("id", campIds);
        for (const c of cs || []) campName.set(c.id, c.name);
      }

      const leads = rows.map((r: any) => ({
        id: r.id,
        wa_phone: r.wa_phone,
        name: r.name,
        lead_ref: r.lead_ref,
        lead_status: r.lead_status,
        lead_stage: r.lead_stage,
        stage_updated_at: r.stage_updated_at,
        assigned_at: r.assigned_at,
        agent_name: r.assigned_agent_id ? agentName.get(r.assigned_agent_id) || null : null,
        // Source label: the campaign name if attributed, else Meta/WhatsApp derived
        // from the source column, else null.
        source: r.source_campaign_id
          ? (campName.get(r.source_campaign_id) || "Campaign")
          : (r.source === "meta_lead_form" ? "Meta" : (r.source ? "WhatsApp" : null)),
      }));
      return NextResponse.json({ leads });
    }

    if (view === "pipeline") {
      const from = sp.get("from");
      const to = sp.get("to");
      // Only real leads, never error rows: a failed/undelivered send or a dead
      // number is not a lead. Count a conversation only if we actually reached
      // the person (delivered/read) OR they replied — and never blocked/invalid.
      let q = db.from("conversations").select("lead_status, pipedrive_lead_id, created_at")
        .eq("is_internal", false)
        .not("status", "in", "(blocked,invalid)")
        .or("replied.eq.true,last_status.in.(delivered,read)");
      if (from) q = q.gte("created_at", from);
      if (to) q = q.lte("created_at", to);
      const { data, error } = await q;
      if (error) throw new Error(error.message);
      return NextResponse.json({ conversations: data || [] });
    }

    // default: inbox — recent 1000 PLUS every actionable lead (hot/warm/unread/
    // replied) even if older than that window, merged + deduped + sorted
    // newest-first, so the Hot/Unread/Replied tabs never drop a lead past the
    // recent 1000.
    // recent = conversations with real activity (last_at set). Not-yet-sent drip
    // recipients have last_at null and would otherwise sort to the TOP (Postgres
    // NULLS FIRST on DESC), flooding the inbox with blank, un-openable rows.
    const [recent, priority] = await Promise.all([
      db.from("conversations").select("*").not("last_at", "is", null).eq("is_internal", false).order("last_at", { ascending: false }).limit(1000),
      db.from("conversations").select("*").eq("is_internal", false).or("lead_status.eq.hot,lead_status.eq.warm,unread.eq.true,replied.eq.true").limit(1000),
    ]);
    if (recent.error) throw new Error(recent.error.message);
    const seen = new Set<string>();
    const conversations = [...(recent.data || []), ...(priority.data || [])]
      .filter((c: any) => (seen.has(c.id) ? false : (seen.add(c.id), true)))
      .sort((a: any, b: any) => new Date(b.last_at || 0).getTime() - new Date(a.last_at || 0).getTime());
    return NextResponse.json({ conversations });
  } catch (e: any) {
    return NextResponse.json({ error: e.message || "Failed to load conversations" }, { status: 500 });
  }
}

// Update a conversation. Only a small whitelist of UI-settable fields, so a
// stolen session can't rewrite arbitrary columns.
export async function POST(req: NextRequest) {
  try {
    const { id, patch } = await req.json();
    if (!id) return NextResponse.json({ error: "id required" }, { status: 400 });
    const allowed: Record<string, any> = {};
    if (patch && typeof patch === "object") {
      if ("unread" in patch) allowed.unread = !!patch.unread;
      if ("lead_status" in patch) allowed.lead_status = String(patch.lead_status);
      if ("status" in patch) allowed.status = String(patch.status);
      if ("lead_stage" in patch) { allowed.lead_stage = patch.lead_stage ? String(patch.lead_stage) : null; allowed.stage_updated_at = new Date().toISOString(); }
      // Assign / reassign the owning agent. Empty value clears the owner.
      // Stamp assigned_at whenever an owner is set so the handover is timestamped.
      if ("assigned_agent_id" in patch) {
        const a = patch.assigned_agent_id ? String(patch.assigned_agent_id) : null;
        allowed.assigned_agent_id = a;
        allowed.assigned_at = a ? new Date().toISOString() : null;
      }
    }
    if (!Object.keys(allowed).length) return NextResponse.json({ error: "no valid fields" }, { status: 400 });
    const db = supabaseAdmin();
    const { error } = await db.from("conversations").update(allowed).eq("id", id);
    if (error) throw new Error(error.message);
    // Stamp first response once when a manager moves a lead into an active stage
    // (only if not already set) — feeds response-time reporting.
    if (allowed.lead_stage && ["contacted", "viewing", "won"].includes(allowed.lead_stage)) {
      await db.from("conversations").update({ first_response_at: new Date().toISOString() }).eq("id", id).is("first_response_at", null);
    }
    return NextResponse.json({ ok: true });
  } catch (e: any) {
    return NextResponse.json({ error: e.message || "Update failed" }, { status: 500 });
  }
}
