import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

// Read WhatsApp messages through the service role, behind the app login gate.
// Replaces direct anon-key reads from the inbox/logs/campaigns/dashboard pages,
// so RLS can deny anon on the messages table.
export async function GET(req: NextRequest) {
  try {
    const db = supabaseAdmin();
    const sp = req.nextUrl.searchParams;
    const view = sp.get("view") || "thread";

    if (view === "thread") {
      const conversation = sp.get("conversation");
      if (!conversation) return NextResponse.json({ error: "conversation required" }, { status: 400 });
      const { data, error } = await db.from("messages").select("*")
        .eq("conversation", conversation).order("created_at");
      if (error) throw new Error(error.message);
      return NextResponse.json({ messages: data || [] });
    }

    if (view === "log") {
      const limit = Math.min(1000, Number(sp.get("limit")) || 400);
      const { data, error } = await db.from("messages")
        .select("id, direction, status, error_code, body, content_sid, created_at, conversation(wa_phone, name)")
        .order("created_at", { ascending: false }).limit(limit);
      if (error) throw new Error(error.message);
      return NextResponse.json({ messages: data || [] });
    }

    if (view === "campaign") {
      const campaign = sp.get("campaign");
      if (!campaign) return NextResponse.json({ error: "campaign required" }, { status: 400 });
      // select * so a later-added column (e.g. scheduled_at) lights up without 400-ing.
      const { data, error } = await db.from("messages")
        .select("*, conversation(wa_phone, name)")
        .eq("campaign", campaign).order("created_at", { ascending: false }).limit(2000);
      if (error) throw new Error(error.message);
      return NextResponse.json({ messages: data || [] });
    }

    if (view === "repliedIds") {
      // Distinct conversation ids that replied (inbound) inside the window.
      const from = sp.get("from");
      const to = sp.get("to");
      let q = db.from("messages").select("conversation").eq("direction", "in");
      if (from) q = q.gte("created_at", from);
      if (to) q = q.lte("created_at", to);
      const { data, error } = await q;
      if (error) throw new Error(error.message);
      const ids = Array.from(new Set((data || []).map((m: any) => m.conversation).filter(Boolean)));
      return NextResponse.json({ conversationIds: ids });
    }

    if (view === "outCount") {
      // Outbound count since a timestamp (the campaigns daily-cap guard).
      const since = sp.get("since");
      let q = db.from("messages").select("id", { count: "exact", head: true }).eq("direction", "out");
      if (since) q = q.gte("created_at", since);
      const { count, error } = await q;
      if (error) throw new Error(error.message);
      return NextResponse.json({ count: count ?? 0 });
    }

    return NextResponse.json({ error: "unknown view" }, { status: 400 });
  } catch (e: any) {
    return NextResponse.json({ error: e.message || "Failed to load messages" }, { status: 500 });
  }
}
