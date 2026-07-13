import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

// Proactive quality brake. The status-callback circuit-breaker only trips on 63051
// — the LOCK signal, which is already the near-ban moment (2,400 of those preceded
// the June ban). This watches the TREND instead: over the last 24h, per sender, it
// measures the real delivery rate and the Meta marketing-throttle (63049) rate, and
// pauses a sender BEFORE Meta locks it. It only ever ADDS a pause (fail-safe) and
// never clears one — a human clears pauses from the sender-health panel once quality
// has recovered. Deliberately conservative: needs a minimum volume so a couple of
// early failures on a tiny send can't trip it.

// Tunables (env-overridable). Defaults chosen to catch a genuine quality slide, not
// normal noise: 63049 is common at volume, so the ceiling is generous.
const WINDOW_HOURS = Number(process.env.QUALITY_WINDOW_HOURS || 24);
const MIN_RESOLVED = Number(process.env.QUALITY_MIN_RESOLVED || 40); // need this many delivered+failed to judge
const DELIVERY_FLOOR = Number(process.env.QUALITY_DELIVERY_FLOOR || 45); // pause if delivered% of resolved falls below
const THROTTLE_CEIL = Number(process.env.QUALITY_THROTTLE_CEIL || 35); // pause if 63049% of attempts exceeds
const PAUSE_HOURS = Number(process.env.QUALITY_PAUSE_HOURS || 12);
const SCAN_CAP = 8000; // max recent outbound rows to scan

const bare = (s: string) => String(s || "").replace(/^whatsapp:/, "").replace(/[^0-9]/g, "");
const RESOLVED_OK = new Set(["delivered", "read"]);
const RESOLVED_FAIL = new Set(["failed", "undelivered"]);

async function run(req: NextRequest) {
  const secret = process.env.CRON_SECRET;
  if (!secret) return NextResponse.json({ error: "CRON_SECRET not configured" }, { status: 503 });
  const provided = req.headers.get("x-cron-secret") || new URL(req.url).searchParams.get("key") || "";
  if (provided !== secret) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const db = supabaseAdmin();
  const now = Date.now();
  const since = new Date(now - WINDOW_HOURS * 3600000).toISOString();

  // Recent outbound messages in the window. Attribute each to a SENDER via its
  // campaign (broadcasts are the quality-risk surface). Rows with no campaign are
  // auto-replies / one-off sends and are skipped here.
  const { data: msgs } = await db
    .from("messages")
    .select("status, error_code, campaign")
    .eq("direction", "out")
    .not("campaign", "is", null)
    .gte("created_at", since)
    .limit(SCAN_CAP);
  const rows = msgs || [];

  // Map each campaign to the number it sends from.
  const campIds = Array.from(new Set(rows.map((m: any) => m.campaign).filter(Boolean)));
  const senderByCamp = new Map<string, string>();
  for (let i = 0; i < campIds.length; i += 500) {
    const { data } = await db.from("campaigns").select("id, sender").in("id", campIds.slice(i, i + 500));
    for (const c of data || []) if ((c as any).sender) senderByCamp.set((c as any).id, bare((c as any).sender));
  }

  // Tally per sender: attempts, delivered, failed, and 63049 marketing throttles.
  type Stat = { attempts: number; delivered: number; failed: number; throttle49: number };
  const stats = new Map<string, Stat>();
  const bump = (s: string): Stat => {
    let v = stats.get(s);
    if (!v) { v = { attempts: 0, delivered: 0, failed: 0, throttle49: 0 }; stats.set(s, v); }
    return v;
  };
  for (const m of rows as any[]) {
    const sender = senderByCamp.get(m.campaign);
    if (!sender) continue;
    const st = bump(sender);
    st.attempts++;
    if (RESOLVED_OK.has(m.status)) st.delivered++;
    else if (RESOLVED_FAIL.has(m.status)) st.failed++;
    if (String(m.error_code || "") === "63049") st.throttle49++;
  }

  // Already-paused senders — never re-pause / extend (a human owns the clear).
  const { data: guards } = await db.from("send_guard").select("sender").gt("paused_until", new Date(now).toISOString());
  const paused = new Set((guards || []).map((g: any) => bare((g as any).sender)));

  const evaluated: any[] = [];
  const pausedNow: any[] = [];
  for (const [sender, s] of stats) {
    const resolved = s.delivered + s.failed;
    const deliveryRate = resolved ? Math.round((s.delivered / resolved) * 100) : null;
    const throttleRate = s.attempts ? Math.round((s.throttle49 / s.attempts) * 100) : 0;
    const report = { sender, ...s, resolved, deliveryRate, throttleRate };
    evaluated.push(report);

    if (paused.has(sender)) continue; // already held
    if (resolved < MIN_RESOLVED) continue; // not enough signal to act

    const lowDelivery = deliveryRate != null && deliveryRate < DELIVERY_FLOOR;
    const highThrottle = throttleRate > THROTTLE_CEIL;
    if (!lowDelivery && !highThrottle) continue;

    const why = lowDelivery
      ? `delivery ${deliveryRate}% < ${DELIVERY_FLOOR}% floor`
      : `marketing throttle ${throttleRate}% > ${THROTTLE_CEIL}% ceiling`;
    await db.from("send_guard").upsert(
      {
        sender,
        paused_until: new Date(now + PAUSE_HOURS * 3600000).toISOString(),
        reason: `auto quality pause — ${why} over ${WINDOW_HOURS}h (${s.delivered}✓/${s.failed}✗/${s.throttle49}⏸ of ${s.attempts}). Review before clearing.`,
        updated_at: new Date(now).toISOString(),
      },
      { onConflict: "sender" }
    );
    pausedNow.push({ sender, why });
  }

  return NextResponse.json({ window_hours: WINDOW_HOURS, scanned: rows.length, evaluated, pausedNow });
}

export async function POST(req: NextRequest) {
  try { return await run(req); } catch (e: any) { return NextResponse.json({ error: e.message || "quality-watch failed" }, { status: 500 }); }
}
export async function GET(req: NextRequest) {
  try { return await run(req); } catch (e: any) { return NextResponse.json({ error: e.message || "quality-watch failed" }, { status: 500 }); }
}
