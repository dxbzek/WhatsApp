import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

// Given a list of phone numbers, return which ones have ALREADY received an
// outbound WhatsApp from us that reached them (delivered or read). The campaign
// flow uses this to drop already-messaged contacts so a re-send never
// double-messages someone who already got it. Failed/never-sent numbers are NOT
// counted as reached, so they correctly stay in for a retry.
// POST { phones: string[] } -> { reached: string[] }  (reached = digit-only keys)
export async function POST(req: NextRequest) {
  try {
    const { phones } = await req.json();
    const keys = Array.from(
      new Set((Array.isArray(phones) ? phones : []).map((p: string) => String(p).replace(/[^0-9]/g, "")))
    ).filter(Boolean);
    if (!keys.length) return NextResponse.json({ reached: [] });

    const db = supabaseAdmin();
    const reached = new Set<string>();

    // Chunk so the IN lists stay sane on large master lists.
    for (let i = 0; i < keys.length; i += 500) {
      const slice = keys.slice(i, i + 500);
      const { data: convs } = await db
        .from("conversations")
        .select("id, wa_phone")
        .in("wa_phone", slice);
      const idToPhone = new Map<string, string>((convs || []).map((c: any) => [c.id, c.wa_phone]));
      const ids = Array.from(idToPhone.keys());
      if (!ids.length) continue;

      // "Reached" = any outbound that left our hands toward this contact: handed
      // to Twilio (queued/accepted/sent) or confirmed (delivered/read). The
      // dispatcher records the Twilio creation status and relies on async
      // callbacks to advance it, so counting only delivered/read would let a
      // just-sent contact look "not reached" and get double-messaged on a re-send.
      for (let j = 0; j < ids.length; j += 500) {
        const idSlice = ids.slice(j, j + 500);
        const { data: msgs } = await db
          .from("messages")
          .select("conversation")
          .eq("direction", "out")
          .in("status", ["queued", "accepted", "sent", "delivered", "read"])
          .in("conversation", idSlice);
        for (const m of msgs || []) {
          const p = idToPhone.get((m as any).conversation);
          if (p) reached.add(p);
        }
      }
    }

    return NextResponse.json({ reached: Array.from(reached) });
  } catch (e: any) {
    return NextResponse.json({ error: e.message || "Lookup failed" }, { status: 500 });
  }
}
