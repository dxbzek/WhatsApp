import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const fetchCache = "force-no-store";
export const revalidate = 0;
export const maxDuration = 60;

// Always-fresh JSON: the campaign log polls this every 20s, so any caching (browser
// or Vercel edge) makes it "fake" live — showing a stale snapshot while the timestamp
// ticks. no-store guarantees every poll hits the live DB.
const noStore = (body: any, status = 200) =>
  NextResponse.json(body, { status, headers: { "Cache-Control": "no-store, max-age=0, must-revalidate" } });

// Read campaigns through the service role, behind the app login gate, so RLS can
// deny anon on the campaigns table. (Campaign mutations already live under
// /api/campaign/* — this plural route is read-only list views.)
export async function GET(req: NextRequest) {
  try {
    const db = supabaseAdmin();
    const sp = req.nextUrl.searchParams;
    const view = sp.get("view") || "log";

    if (view === "active") {
      const { data, error } = await db.from("campaigns").select("id,status")
        .in("status", ["sending", "scheduled"]);
      if (error) throw new Error(error.message);
      return noStore({ campaigns: data || [] });
    }

    if (view === "activeProgress") {
      // Live progress for in-flight campaigns, computed from the message log
      // (WhatsApp receipts update messages.status, not the campaign rollup, so
      // the rollup columns go stale). Reuses the campaign_funnel() aggregate.
      const { data: camps, error: cErr } = await db.from("campaigns")
        .select("id,name,sender,status,total,finish_at,created_at")
        .in("status", ["sending", "scheduled"])
        .order("created_at", { ascending: false });
      if (cErr) throw new Error(cErr.message);
      const ids = new Set((camps || []).map((c: any) => c.id));
      if (!camps?.length) return noStore({ campaigns: [] });

      // Per-campaign status tallies. RPC returns grouped (campaign,status,error_code,n).
      const tally: Record<string, { delivered: number; read: number; failed: number; scheduled: number; reached: number; handed: number }> = {};
      const blank = () => ({ delivered: 0, read: 0, failed: 0, scheduled: 0, reached: 0, handed: 0 });
      const { data: rpc } = await db.rpc("campaign_funnel");
      for (const r of (Array.isArray(rpc) ? rpc : []) as any[]) {
        if (!r.campaign || !ids.has(r.campaign)) continue;
        const t = (tally[r.campaign] ||= blank());
        const n = Number(r.n) || 0;
        const s = String(r.status || "");
        if (s === "scheduled") t.scheduled += n;
        else if (s === "failed" || s === "undelivered") { t.failed += n; t.handed += n; }
        else { t.handed += n; if (s === "read") { t.read += n; t.delivered += n; t.reached += n; } else if (s === "delivered") { t.delivered += n; t.reached += n; } }
      }

      const out = (camps || []).map((c: any) => {
        const t = tally[c.id] || blank();
        const resolved = t.delivered + t.failed; // messages with a final receipt
        return {
          id: c.id, name: c.name, sender: c.sender, status: c.status,
          total: c.total, finish_at: c.finish_at,
          reached: t.reached, delivered: t.delivered, read: t.read,
          failed: t.failed, scheduled: t.scheduled,
          deliveryRate: resolved ? Math.round((t.delivered / resolved) * 100) : null,
        };
      });
      return noStore({ campaigns: out });
    }

    // default: log — most recent campaigns with their rollup counts.
    const limit = Math.min(200, Number(sp.get("limit")) || 100);
    const { data, error } = await db.from("campaigns").select("*")
      .order("created_at", { ascending: false }).limit(limit);
    if (error) throw new Error(error.message);
    return noStore({ campaigns: data || [] });
  } catch (e: any) {
    return noStore({ error: e.message || "Failed to load campaigns" }, 500);
  }
}
