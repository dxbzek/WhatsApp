import { NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

type Agg = { sent: number; delivered: number; read: number; failed: number; scheduled: number; reasons: Record<string, number> };

// Fold one (status, error_code, n) group into a campaign's funnel tallies.
function fold(a: Agg, status: string, errorCode: string | null, n: number) {
  if (status === "failed" || status === "undelivered") {
    a.failed += n;
    const code = errorCode ? String(errorCode) : "unknown";
    a.reasons[code] = (a.reasons[code] || 0) + n;
  } else if (status === "scheduled") {
    // Queued in our DB but not yet handed to WhatsApp — NOT "reached", track on its own.
    a.scheduled += n;
  } else {
    a.sent += n; // reached WhatsApp (queued/sent/delivered/read/accepted)
    if (status === "read") { a.read += n; a.delivered += n; }
    else if (status === "delivered") a.delivered += n;
  }
}

// Per-campaign delivery funnel from our own message log (WhatsApp receipts
// update messages.status, not the campaign rollup). Uses the campaign_funnel()
// SQL aggregate (one grouped query); falls back to row-paging if the RPC isn't
// installed yet. GET -> { funnel: { [campaignId]: { sent, delivered, read, failed, deliveryRate, readRate, reasons } } }
export async function GET() {
  try {
    const db = supabaseAdmin();
    const agg: Record<string, Agg> = {};
    const blank = (): Agg => ({ sent: 0, delivered: 0, read: 0, failed: 0, scheduled: 0, reasons: {} });

    const { data: rpc, error: rpcErr } = await db.rpc("campaign_funnel");
    if (!rpcErr && Array.isArray(rpc)) {
      for (const r of rpc as any[]) {
        if (!r.campaign) continue;
        fold((agg[r.campaign] ||= blank()), r.status || "", r.error_code, Number(r.n) || 0);
      }
    } else {
      // Fallback: page every outbound campaign message and tally in Node.
      for (let from = 0; ; from += 1000) {
        const { data, error } = await db
          .from("messages").select("campaign, status, error_code")
          .not("campaign", "is", null).eq("direction", "out").range(from, from + 999);
        if (error) throw error;
        for (const m of (data as any[]) || []) fold((agg[m.campaign] ||= blank()), m.status, m.error_code, 1);
        if (!data || data.length < 1000) break;
      }
    }

    const funnel: Record<string, any> = {};
    for (const [id, a] of Object.entries(agg)) {
      // Delivery rate = of messages that actually RESOLVED (delivered or failed),
      // how many reached a handset. Still-scheduled/queued have no receipt yet.
      const resolved = a.delivered + a.failed;
      funnel[id] = {
        ...a,
        deliveryRate: resolved ? Math.round((a.delivered / resolved) * 100) : 0,
        readRate: a.delivered ? Math.round((a.read / a.delivered) * 100) : 0,
      };
    }
    return NextResponse.json({ funnel });
  } catch (e: any) {
    return NextResponse.json({ error: e.message || "Failed to compute funnel" }, { status: 500 });
  }
}
