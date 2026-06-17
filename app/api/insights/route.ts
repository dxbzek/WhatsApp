import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase";
import { DEAD_NUMBER_CODES } from "@/lib/twilioErrors";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

// Template-level failures: Meta paused/disabled the TEMPLATE for low quality, so
// every send on it fails regardless of recipient. That's a content signal, not a
// per-number deliverability signal — exclude from the delivery-rate denominator
// and surface separately. (Mirrors lib/twilioErrors descriptions for 63051/63052.)
const TEMPLATE_PAUSED_CODES = new Set(["63051", "63052"]);
// Meta's per-user marketing throttle: a real non-delivery to a LIVE, valid number
// (over-messaging), so it DOES count against the rate — but we also surface it.
const MARKETING_THROTTLE_CODE = "63049";

// Messaging insights computed from OUR messages table — the same source the
// campaign log trusts — not Twilio's list API. The Twilio API was capped at a
// few thousand rows (undercounting volume), slow, and its error-code buckets
// drifted from the rest of the app. Our table has every console message with its
// live status (delivery callbacks update it) and is complete + fast.
export async function GET(req: NextRequest) {
  try {
    const db = supabaseAdmin();

    // Window: explicit from/to (ISO) take priority; otherwise fall back to days.
    const fromParam = req.nextUrl.searchParams.get("from");
    const toParam = req.nextUrl.searchParams.get("to");
    const days = Math.min(Math.max(parseInt(req.nextUrl.searchParams.get("days") || "1", 10), 1), 365);
    const fromMs = fromParam ? Date.parse(fromParam) : Date.now() - days * 24 * 60 * 60 * 1000;
    const toMs = toParam ? Date.parse(toParam) : Date.now();
    const fromDate = new Date(isNaN(fromMs) ? Date.now() - 86400000 : fromMs);
    const toDate = new Date(isNaN(toMs) ? Date.now() : toMs);

    const byStatus: Record<string, number> = {};
    const byErr: Record<string, number> = {};
    const byDay: Record<string, { out: number; in: number }> = {};
    let outbound = 0, inbound = 0, delivered = 0, read = 0, failed = 0,
      undelivered = 0, notOnWhatsApp = 0, queued = 0, total = 0,
      neverSent = 0, templatePaused = 0, marketingThrottled = 0;

    // Page through the window. Only the columns we aggregate, so this stays light
    // even over a wide range.
    let capped = false;
    const MAX_ROWS = 200000;
    for (let from = 0; from < MAX_ROWS; from += 1000) {
      const { data, error } = await db
        .from("messages")
        .select("direction, status, error_code, created_at")
        .gte("created_at", fromDate.toISOString())
        .lte("created_at", toDate.toISOString())
        .order("created_at", { ascending: true })
        .range(from, from + 999);
      if (error) throw error;
      const rows = data || [];
      for (const m of rows as any[]) {
        total++;
        const status = m.status || "unknown";
        byStatus[status] = (byStatus[status] || 0) + 1;
        const isOut = m.direction === "out";

        const dayKey = (m.created_at || "").slice(0, 10);
        if (dayKey) {
          if (!byDay[dayKey]) byDay[dayKey] = { out: 0, in: 0 };
          byDay[dayKey][isOut ? "out" : "in"]++;
        }

        if (!isOut) { inbound++; continue; }

        // Still in our queue (server drip) or in flight — NOT yet a real attempt,
        // so it must not deflate the delivery rate.
        if (status === "scheduled" || status === "sending" || status === "queued" || status === "accepted" || status === "sent") {
          queued++;
          continue;
        }
        // Never actually sent: canceled (killed before send, e.g. a suspension)
        // or skipped (suppressed — blocked/invalid — before send). These never
        // hit Twilio/Meta, so counting them as failed attempts is wrong.
        if (status === "canceled" || status === "skipped") {
          neverSent++;
          continue;
        }

        const code = m.error_code ? String(m.error_code) : null;

        // Template paused/disabled by Meta — a content-level failure that hits
        // every recipient on the template, not a per-number delivery signal.
        // Keep it out of the rate; report it on its own.
        if (code && TEMPLATE_PAUSED_CODES.has(code)) {
          templatePaused++;
          byErr[code] = (byErr[code] || 0) + 1;
          continue;
        }

        outbound++;
        if (status === "delivered") delivered++;
        else if (status === "read") read++;
        else if (status === "failed") failed++;
        else if (status === "undelivered") undelivered++;

        if (code) {
          byErr[code] = (byErr[code] || 0) + 1;
          if (DEAD_NUMBER_CODES.has(code)) notOnWhatsApp++;
          if (code === MARKETING_THROTTLE_CODE) marketingThrottled++;
        }
      }
      if (rows.length < 1000) break;
      if (from + 1000 >= MAX_ROWS) capped = true;
    }

    // delivered + read = reached the handset. outbound = resolved attempts
    // (delivered/read/failed/undelivered) — in-flight/queued excluded above.
    const reached = delivered + read;
    const validOutbound = Math.max(0, outbound - notOnWhatsApp);
    const pct = (num: number, den: number) => (den ? Math.round((num / den) * 1000) / 10 : 0);
    const deliveryRate = pct(reached, outbound);
    const deliveryRateValid = pct(reached, validOutbound);
    const readRate = pct(read, reached);
    const failRate = pct(failed + undelivered, outbound);

    return NextResponse.json({
      range: { from: fromDate.toISOString(), to: toDate.toISOString() },
      totals: {
        total, outbound, validOutbound, notOnWhatsApp, inbound, queued,
        neverSent, templatePaused, marketingThrottled,
        delivered, read, failed, undelivered,
        deliveryRate, deliveryRateValid, readRate, failRate, capped,
      },
      byStatus,
      byErr,
      byDay: Object.entries(byDay).sort((a, b) => (a[0] < b[0] ? -1 : 1)).map(([day, v]) => ({ day, ...v })),
      logs: [],
    });
  } catch (e: any) {
    return NextResponse.json({ error: e.message || "Failed to load insights" }, { status: 500 });
  }
}
