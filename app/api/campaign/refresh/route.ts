import { NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

// Recompute live counts/status for campaigns that aren't finished yet, from
// their actual message rows (delivery callbacks update messages, not the
// campaign rollup). Uses the campaign_status_counts() SQL aggregate (one
// grouped query); falls back to row-paging if the RPC isn't installed yet.
// POST -> { updated }
export async function POST() {
  try {
    const db = supabaseAdmin();
    const { data: active } = await db
      .from("campaigns").select("id, status").in("status", ["sending", "scheduled"]);
    const ids = (active || []).map((c: any) => c.id);
    if (ids.length === 0) return NextResponse.json({ ok: true, updated: 0 });

    // campaign -> { status -> count }
    const counts: Record<string, Record<string, number>> = {};
    const { data: rpc, error: rpcErr } = await db.rpc("campaign_status_counts", { ids });
    if (!rpcErr && Array.isArray(rpc)) {
      for (const r of rpc as any[]) {
        (counts[r.campaign] ||= {})[r.status || "?"] = Number(r.n) || 0;
      }
    } else {
      for (const id of ids) {
        const c: Record<string, number> = (counts[id] = {});
        for (let from = 0; ; from += 1000) {
          const { data } = await db.from("messages").select("status").eq("campaign", id).range(from, from + 999);
          for (const m of data || []) c[(m as any).status || "?"] = (c[(m as any).status || "?"] || 0) + 1;
          if (!data || data.length < 1000) break;
        }
      }
    }

    let updated = 0;
    for (const id of ids) {
      const c = counts[id] || {};
      const n = (k: string) => c[k] || 0;
      const scheduled = n("scheduled") + n("sending");
      const failed = n("undelivered") + n("failed");
      const sent = n("delivered") + n("read") + n("sent") + n("queued") + n("accepted");
      const status = scheduled > 0 ? "scheduled" : "completed";
      await db.from("campaigns").update({ sent, scheduled, failed, status }).eq("id", id);
      updated++;
    }
    return NextResponse.json({ ok: true, updated });
  } catch (e: any) {
    return NextResponse.json({ error: e.message || "Refresh failed" }, { status: 500 });
  }
}
