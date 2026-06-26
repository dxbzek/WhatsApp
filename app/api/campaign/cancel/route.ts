import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase";
import { cancelMessage } from "@/lib/twilio";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

// Cancel the still-pending (scheduled) messages of a campaign. Already-sent
// messages can't be unsent. POST { id }
export async function POST(req: NextRequest) {
  try {
    const { id } = await req.json();
    if (!id) return NextResponse.json({ error: "id required" }, { status: 400 });
    const db = supabaseAdmin();

    // Server-drip rows were never handed to Twilio (no twilio_sid) — the
    // dispatcher would otherwise keep sending them. Mark them canceled in bulk
    // so the dispatcher's "scheduled + twilio_sid IS NULL" claim skips them.
    const { data: dripRows } = await db
      .from("messages")
      .update({ status: "canceled" })
      .eq("campaign", id)
      .is("twilio_sid", null)
      .eq("status", "scheduled")
      .select("id");
    const dripCanceled = dripRows?.length || 0;

    // Pending = messages handed to Twilio (have a SID) still in a schedulable
    // state — cancel each via the Twilio API.
    const { data: pending } = await db
      .from("messages")
      .select("id, twilio_sid")
      .eq("campaign", id)
      .not("twilio_sid", "is", null)
      .in("status", ["scheduled", "accepted", "queued"]);

    let canceled = 0, alreadyGone = 0;
    for (const m of pending || []) {
      if (!m.twilio_sid) continue;
      try {
        await cancelMessage(m.twilio_sid);
        await db.from("messages").update({ status: "canceled" }).eq("id", m.id);
        canceled++;
      } catch {
        // Twilio refuses if it already sent - leave that message as-is.
        alreadyGone++;
      }
    }
    canceled += dripCanceled;

    await db.from("campaigns").update({ status: "canceled", scheduled: 0 }).eq("id", id);
    return NextResponse.json({ ok: true, canceled, alreadyGone });
  } catch (e: any) {
    return NextResponse.json({ error: e.message || "Cancel failed" }, { status: 500 });
  }
}
