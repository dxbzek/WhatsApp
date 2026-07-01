import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Record final tallies once the client has finished looping batches.
// POST { id, total? }  (client-sent sent/scheduled/failed/skipped are IGNORED)
// #12: the client's own tallies can be wrong (a closed tab, a lost response, a
// double-count). Recompute the real numbers server-side from the messages table
// for this campaign so the campaign log is always ground truth, not client input.
export async function POST(req: NextRequest) {
  try {
    const { id, total } = await req.json();
    if (!id) return NextResponse.json({ error: "id required" }, { status: 400 });
    const db = supabaseAdmin();

    // Count outbound messages for this campaign by delivery bucket.
    const countFor = async (statuses: string[]) => {
      const { count } = await db
        .from("messages")
        .select("id", { count: "exact", head: true })
        .eq("campaign", id)
        .eq("direction", "out")
        .in("status", statuses);
      return count || 0;
    };
    const [sent, scheduled, failed, skipped] = await Promise.all([
      countFor(["queued", "accepted", "sent", "delivered", "read"]),
      countFor(["scheduled", "sending"]),
      countFor(["failed", "undelivered"]),
      countFor(["skipped"]),
    ]);

    // "scheduled" if any are still queued for the future; else "completed" only if
    // every recipient was accounted for; otherwise "incomplete" (stopped partway).
    const processed = sent + failed + skipped;
    const status = scheduled > 0
      ? "scheduled"
      : (total && processed < total ? "incomplete" : "completed");
    const { error } = await db
      .from("campaigns")
      .update({ sent, scheduled, failed, skipped, status })
      .eq("id", id);
    if (error) throw error;
    return NextResponse.json({ ok: true, status, sent, scheduled, failed, skipped });
  } catch (e: any) {
    return NextResponse.json({ error: e.message || "Failed to finalize" }, { status: 500 });
  }
}
