import { NextRequest, NextResponse } from "next/server";
import { twilioCreds, twilioGet, cleanEnv } from "@/lib/twilio";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Account balance + real spend from Twilio Usage Records (the actual billed
// amount). Per-message `price` is unreliable for WhatsApp, so we use the
// `totalprice` usage category instead.
export async function GET(req: NextRequest) {
  try {
    const { sid } = twilioCreds();
    const days = Math.min(Math.max(parseInt(req.nextUrl.searchParams.get("days") || "30", 10), 1), 365);
    const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
    const sinceStr = since.toISOString().slice(0, 10);

    // Live prepaid balance. The prepaid balance lives on the PARENT Twilio account,
    // NOT the WhatsApp subaccount this console authenticates as — so Balance.json
    // against the subaccount SID returns nothing (the "prepaid balance unavailable"
    // dash). When parent creds are configured, read the balance from the parent;
    // otherwise fall back to this account so behaviour is unchanged.
    let balance: { balance: string; currency: string } | null = null;
    try {
      const parentSid = cleanEnv(process.env.TWILIO_PARENT_ACCOUNT_SID);
      const parentToken = cleanEnv(process.env.TWILIO_PARENT_ACCOUNT_TOKEN);
      const balSid = parentSid || sid;
      const auth = parentSid && parentToken
        ? "Basic " + Buffer.from(`${parentSid}:${parentToken}`).toString("base64")
        : undefined;
      const b: any = await twilioGet(`/2010-04-01/Accounts/${balSid}/Balance.json`, auth);
      balance = { balance: b.balance, currency: b.currency };
    } catch {
      balance = null;
    }

    // Daily total spend over the window (actual billed amount)
    const daily: any = await twilioGet(
      `/2010-04-01/Accounts/${sid}/Usage/Records/Daily.json?Category=totalprice&StartDate=${sinceStr}&PageSize=366`
    );
    let total = 0;
    let currency = balance?.currency || "USD";
    const byDay = (daily.usage_records || []).map((r: any) => {
      const spend = Math.abs(parseFloat(r.price || "0"));
      total += spend;
      if (r.price_unit) currency = String(r.price_unit).toUpperCase();
      return { day: (r.start_date || "").slice(0, 10), spend: Math.round(spend * 10000) / 10000 };
    });

    // All-time spend, for context
    let allTime = 0;
    try {
      const at: any = await twilioGet(`/2010-04-01/Accounts/${sid}/Usage/Records/AllTime.json?Category=totalprice`);
      const rec = (at.usage_records || [])[0];
      if (rec) allTime = Math.abs(parseFloat(rec.price || "0"));
    } catch {}

    // FX rates from USD (Twilio bills in USD). AED is pegged; GBP fetched live.
    let fx: Record<string, number> = { USD: 1, AED: 3.6725, GBP: 0.79 };
    try {
      const r = await fetch("https://open.er-api.com/v6/latest/USD");
      const j: any = await r.json();
      if (j?.rates) fx = { USD: 1, AED: j.rates.AED ?? fx.AED, GBP: j.rates.GBP ?? fx.GBP };
    } catch {}

    return NextResponse.json({
      balance,
      range: { days, since: sinceStr },
      spend: {
        total: Math.round(total * 10000) / 10000,
        allTime: Math.round(allTime * 10000) / 10000,
        avgPerDay: byDay.length ? Math.round((total / byDay.length) * 10000) / 10000 : 0,
        currency,
      },
      byDay,
      fx,
    });
  } catch (e: any) {
    return NextResponse.json({ error: e.message || "Failed to load billing" }, { status: 500 });
  }
}
