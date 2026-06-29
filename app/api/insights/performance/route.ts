import { NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

// Agent performance + campaign→deal attribution, straight from our own
// conversations. Distributed leads carry their source_campaign_id (which
// campaign produced them) and, once worked, an owner + stage + first_response_at
// — so we can show who's converting and which campaigns actually make deals,
// not just which get clicks.
export async function GET() {
  try {
    const db = supabaseAdmin();

    // Only lead rows: anything with a source campaign or an owner. Small set
    // (distributed leads), so we aggregate in memory.
    const { data: rows, error } = await db
      .from("conversations")
      .select("assigned_agent_id, source_campaign_id, lead_stage, first_response_at, assigned_at, source")
      .eq("is_internal", false)
      .or("source_campaign_id.not.is.null,assigned_agent_id.not.is.null")
      .limit(50000);
    if (error) throw new Error(error.message);

    const [{ data: agents }, { data: camps }] = await Promise.all([
      db.from("agents").select("id, name"),
      db.from("campaigns").select("id, name"),
    ]);
    const agentName = new Map((agents || []).map((a: any) => [a.id, a.name]));
    const campName = new Map((camps || []).map((c: any) => [c.id, c.name]));

    type Acc = { leads: number; active: number; won: number; lost: number; respSum: number; respN: number };
    const blank = (): Acc => ({ leads: 0, active: 0, won: 0, lost: 0, respSum: 0, respN: 0 });
    const byAgent = new Map<string, Acc>();
    const byCamp = new Map<string, Acc>();
    let pool = 0;

    for (const r of (rows || []) as any[]) {
      // WhatsApp insights only — this console is WhatsApp, so exclude Meta lead-form
      // leads (they have an owner but did not come through a WhatsApp campaign).
      if (r.source === "meta_lead_form") continue;
      const stage = r.lead_stage as string | null;
      const active = stage === "contacted" || stage === "viewing";
      const respMin = r.first_response_at && r.assigned_at
        ? (new Date(r.first_response_at).getTime() - new Date(r.assigned_at).getTime()) / 60000
        : null;

      if (stage === "lost") pool++;

      // Per-agent (only currently-owned leads; "lost" releases ownership so it
      // lands in the pool, not against an agent).
      if (r.assigned_agent_id) {
        const a = byAgent.get(r.assigned_agent_id) || blank();
        a.leads++;
        if (active) a.active++;
        if (stage === "won") a.won++;
        if (respMin != null && respMin >= 0) { a.respSum += respMin; a.respN++; }
        byAgent.set(r.assigned_agent_id, a);
      }

      // Per-campaign attribution by NAME, so re-runs of the same campaign (same
      // name, different id) merge into ONE row instead of showing 4 duplicates.
      if (r.source_campaign_id) {
        const cname = campName.get(r.source_campaign_id) || "Unknown";
        const c = byCamp.get(cname) || blank();
        c.leads++;
        if (active) c.active++;
        if (stage === "won") c.won++;
        if (stage === "lost") c.lost++;
        byCamp.set(cname, c);
      }
    }

    const agentRows = Array.from(byAgent.entries())
      .map(([id, a]) => ({
        id, name: agentName.get(id) || "Unknown",
        leads: a.leads, active: a.active, won: a.won,
        avgResponseMins: a.respN ? Math.round(a.respSum / a.respN) : null,
      }))
      .sort((x, y) => y.won - x.won || y.leads - x.leads);

    const campRows = Array.from(byCamp.entries())
      .map(([name, c]) => ({
        id: name, name,
        leads: c.leads, active: c.active, won: c.won, lost: c.lost,
        winRate: c.won + c.lost > 0 ? Math.round((c.won / (c.won + c.lost)) * 100) : null,
      }))
      .sort((x, y) => y.won - x.won || y.leads - x.leads);

    return NextResponse.json({ agents: agentRows, campaigns: campRows, pool });
  } catch (e: any) {
    return NextResponse.json({ error: e.message || "Failed to load performance" }, { status: 500 });
  }
}
