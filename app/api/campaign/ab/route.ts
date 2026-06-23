import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const fetchCache = "force-no-store";
export const maxDuration = 60;

const NO_STORE = { "Cache-Control": "no-store, max-age=0, must-revalidate" };

// Per-variant results for an A/B campaign. A tap = an inbound reply whose text
// matches one of our converting CTA buttons (the same push_pipedrive auto_reply
// rules that mark a lead hot), attributed to whichever variant that contact got.
// GET ?campaign=ID -> { ab: true, variants: [{ key:'A'|'B', sid, name, sent, reached, read, taps, tapRate }] } or { ab:false }
export async function GET(req: NextRequest) {
  try {
    const campaignId = req.nextUrl.searchParams.get("campaign");
    if (!campaignId) return NextResponse.json({ error: "campaign required" }, { status: 400 });
    const db = supabaseAdmin();

    const { data: camp } = await db
      .from("campaigns")
      .select("template_sid, template_name, template_sid_b, template_name_b")
      .eq("id", campaignId)
      .maybeSingle();
    if (!camp?.template_sid_b) return NextResponse.json({ ab: false }, { headers: NO_STORE });

    // Outbound messages for this campaign: which variant each contact got + status.
    const { data: outs } = await db
      .from("messages")
      .select("content_sid, status, conversation")
      .eq("campaign", campaignId).eq("direction", "out");
    const rows = (outs || []) as any[];

    type V = { sent: number; reached: number; read: number; taps: number };
    const blank = (): V => ({ sent: 0, reached: 0, read: 0, taps: 0 });
    const stat: Record<string, V> = {};
    const convSid = new Map<string, string>(); // conversation -> content_sid it received
    for (const m of rows) {
      const sid = m.content_sid || "unknown";
      const v = (stat[sid] ||= blank());
      v.sent++;
      if (m.status === "delivered" || m.status === "read") v.reached++;
      if (m.status === "read") v.read++;
      if (m.conversation) convSid.set(m.conversation, sid);
    }

    // Converting-button triggers (same set that marks a lead hot).
    const { data: rules } = await db.from("auto_replies").select("trigger").eq("enabled", true).eq("push_pipedrive", true).eq("block", false);
    const converting = new Set((rules || []).map((r: any) => String(r.trigger || "").trim().toLowerCase()));

    // Inbound replies on those conversations -> attribute taps to the variant.
    const convIds = Array.from(convSid.keys());
    for (let i = 0; i < convIds.length; i += 300) {
      const { data: ins } = await db.from("messages").select("conversation, body")
        .eq("direction", "in").in("conversation", convIds.slice(i, i + 300));
      for (const m of (ins || []) as any[]) {
        const text = String(m.body || "").trim().toLowerCase().replace(/[\s!.?,]+$/, "");
        if (!converting.has(text)) continue;
        const sid = convSid.get(m.conversation);
        if (sid && stat[sid]) stat[sid].taps++;
      }
    }

    const build = (key: string, sid: string, name: string | null) => {
      const v = stat[sid] || blank();
      return { key, sid, name: name || sid, ...v, tapRate: v.reached ? Math.round((v.taps / v.reached) * 1000) / 10 : 0 };
    };
    const variants = [
      build("A", camp.template_sid, camp.template_name),
      build("B", camp.template_sid_b, camp.template_name_b),
    ];
    return NextResponse.json({ ab: true, variants }, { headers: NO_STORE });
  } catch (e: any) {
    return NextResponse.json({ error: e.message || "Failed to compute A/B" }, { status: 500, headers: NO_STORE });
  }
}
