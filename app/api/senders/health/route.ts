import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase";
import { whatsappSenders, cleanEnv } from "@/lib/twilio";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const fetchCache = "force-no-store";

const bare = (s: string) => String(s || "").replace(/^whatsapp:/, "").replace(/[^0-9]/g, "");
const WINDOW_HOURS = 24;
const RESOLVED_OK = new Set(["delivered", "read"]);
const RESOLVED_FAIL = new Set(["failed", "undelivered"]);

// GET: per-sender health — lane, current pause (with countdown), and the last-24h
// delivery quality (delivered% + marketing-throttle 63049 count). Read-only.
export async function GET() {
  const db = supabaseAdmin();
  const now = Date.now();
  const since = new Date(now - WINDOW_HOURS * 3600000).toISOString();

  const utility = bare(cleanEnv(process.env.TWILIO_WHATSAPP_FROM));
  const configuredMkt = bare(cleanEnv(process.env.TWILIO_MKT_WHATSAPP_FROM));
  const numbers = whatsappSenders().map(bare).filter(Boolean);
  const marketing = configuredMkt || numbers.find((n) => n !== utility) || "";
  const laneOf = (n: string) => (n && n === marketing ? "marketing" : "utility");

  // Recent outbound broadcast messages, attributed to a sender via campaign.
  const { data: msgs } = await db
    .from("messages").select("status, error_code, campaign")
    .eq("direction", "out").not("campaign", "is", null).gte("created_at", since).limit(8000);
  const rows = msgs || [];
  const campIds = Array.from(new Set(rows.map((m: any) => m.campaign).filter(Boolean)));
  const senderByCamp = new Map<string, string>();
  for (let i = 0; i < campIds.length; i += 500) {
    const { data } = await db.from("campaigns").select("id, sender").in("id", campIds.slice(i, i + 500));
    for (const c of data || []) if ((c as any).sender) senderByCamp.set((c as any).id, bare((c as any).sender));
  }
  const stat = new Map<string, { attempts: number; delivered: number; failed: number; throttle49: number }>();
  for (const m of rows as any[]) {
    const s = senderByCamp.get(m.campaign);
    if (!s) continue;
    let v = stat.get(s); if (!v) { v = { attempts: 0, delivered: 0, failed: 0, throttle49: 0 }; stat.set(s, v); }
    v.attempts++;
    if (RESOLVED_OK.has(m.status)) v.delivered++;
    else if (RESOLVED_FAIL.has(m.status)) v.failed++;
    if (String(m.error_code || "") === "63049") v.throttle49++;
  }

  const { data: guards } = await db.from("send_guard").select("sender, paused_until, reason, updated_at");
  const guardBy = new Map<string, any>();
  for (const g of guards || []) guardBy.set(bare((g as any).sender), g);

  const senders = numbers.map((n) => {
    const g = guardBy.get(n);
    const pausedUntil = g?.paused_until && new Date(g.paused_until).getTime() > now ? g.paused_until : null;
    const s = stat.get(n) || { attempts: 0, delivered: 0, failed: 0, throttle49: 0 };
    const resolved = s.delivered + s.failed;
    return {
      number: n,
      lane: laneOf(n),
      paused: !!pausedUntil,
      pausedUntil,
      pauseReason: pausedUntil ? g?.reason || null : null,
      last24h: {
        ...s,
        resolved,
        deliveryRate: resolved ? Math.round((s.delivered / resolved) * 100) : null,
        throttleRate: s.attempts ? Math.round((s.throttle49 / s.attempts) * 100) : 0,
      },
    };
  });

  return NextResponse.json({ senders, windowHours: WINDOW_HOURS });
}

// POST { sender, action: "clear" }: lift a pause on a sender. This RESUMES a number
// that was paused for a quality/penalty reason — deliberately gated behind a typed
// action and a UI confirm, because resuming a flagged number too early risks a ban.
export async function POST(req: NextRequest) {
  try {
    const { sender, action } = await req.json();
    const s = bare(sender);
    if (!s) return NextResponse.json({ error: "sender required" }, { status: 400 });
    if (action !== "clear") return NextResponse.json({ error: "unknown action" }, { status: 400 });
    const db = supabaseAdmin();
    // Match on digits like the dispatcher, so any stored format is cleared.
    const { data: rows } = await db.from("send_guard").select("sender");
    const target = (rows || []).map((r: any) => r.sender).filter((x: string) => bare(x) === s);
    for (const raw of target) await db.from("send_guard").delete().eq("sender", raw);
    return NextResponse.json({ cleared: s, rows: target.length });
  } catch (e: any) {
    return NextResponse.json({ error: e.message || "clear failed" }, { status: 500 });
  }
}
