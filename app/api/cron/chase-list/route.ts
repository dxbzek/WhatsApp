import { NextRequest, NextResponse } from "next/server";
import { collectChaseRows, sendChaseList } from "@/lib/chaseList";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

// Daily 09:00 Dubai chase list — every live lead nobody has logged a call on.
//
// Scheduled from pg_cron (see lib/setup_chase_list_cron.sql) rather than Vercel cron so
// it uses the same secret + protection-bypass pattern as the other jobs here.
//
// Recipients: CHASE_LIST_TO, comma-separated. Falls back to LEAD_ALERT_CC (marketing@)
// so a missing env var still reaches a human instead of silently sending nowhere.
//
// GET with ?dry=1 returns the rows WITHOUT emailing — use that to check the list before
// pointing it at the team.
const MIN_AGE_HOURS = Number(process.env.CHASE_MIN_AGE_HOURS || 24);
const MAX_AGE_DAYS = Number(process.env.CHASE_MAX_AGE_DAYS || 14);
const CAP = Number(process.env.CHASE_CAP || 60);

async function run(req: NextRequest) {
  const secret = process.env.CRON_SECRET;
  if (!secret) return NextResponse.json({ error: "CRON_SECRET not configured" }, { status: 503 });
  const provided = req.headers.get("x-cron-secret") || new URL(req.url).searchParams.get("key") || "";
  if (provided !== secret) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  if (!process.env.PIPEDRIVE_API_TOKEN) {
    return NextResponse.json({ error: "PIPEDRIVE_API_TOKEN not set" }, { status: 503 });
  }

  const dry = new URL(req.url).searchParams.get("dry") === "1";

  try {
    const { rows, scanned } = await collectChaseRows(MIN_AGE_HOURS, MAX_AGE_DAYS, CAP);

    // An empty list is a real, good answer — send nothing rather than a daily
    // "0 leads" email nobody will keep opening.
    if (rows.length === 0) return NextResponse.json({ ok: true, scanned, stale: 0, emailed: [] });

    if (dry) return NextResponse.json({ ok: true, dryRun: true, scanned, stale: rows.length, rows });

    const to = (process.env.CHASE_LIST_TO || process.env.LEAD_ALERT_CC || "marketing@erehomes.ae")
      .split(",").map((s) => s.trim()).filter(Boolean);
    const res = await sendChaseList(rows, to);
    return NextResponse.json({ ok: res.error === null, scanned, stale: rows.length, emailed: res.sent, error: res.error });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: String(e?.message || e).slice(0, 200) }, { status: 500 });
  }
}

export async function GET(req: NextRequest) { return run(req); }
export async function POST(req: NextRequest) { return run(req); }
