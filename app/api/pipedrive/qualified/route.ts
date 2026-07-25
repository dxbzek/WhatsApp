import { NextRequest, NextResponse } from "next/server";
import crypto from "crypto";
import { supabaseAdmin } from "@/lib/supabase";

export const dynamic = "force-dynamic";

// Real-time Meta CAPI "Qualified Lead" fire, triggered by a Pipedrive webhook the moment
// a pipeline-2 deal enters the Qualified stage (or beyond). Replaces the batch cron
// (meta_capi_qualified_pipedrive.py --send) — the qualify signal is a Pipedrive STAGE
// CHANGE, so we wire the event instead of polling. See [[project_meta_lead_reporting]].
//
// Why this is cheap even though a raw deal-updated webhook fires on every edit: the whole
// company's deal edits early-return on the stage/pipeline gate below with ZERO external
// calls; only a genuine qualification does a Supabase lookup + one Meta POST. And the fire
// is idempotent per lead — `lead_events.capi_prequalified_sent_at` is stamped once, so a
// deal re-edited while it sits in a qualified stage never re-fires (Meta also dedups on
// event_id `qualw-<id>`, matching the batch script so the two can never double-count).
//
// Env:
//   PIPEDRIVE_WEBHOOK_SECRET  shared secret Pipedrive must present (?s= or Bearer). If
//                             unset the route is open — always set it in production.
//   CAPI_LIVE=1               ARMS the real send. Without it the route is LOG-ONLY (dry
//                             run) so a qualification is logged but nothing reaches Meta —
//                             this is the "check first" gate. Flip to 1 once a dry-run
//                             log confirms the wiring, then verify the event in Events Mgr.
//   META_ADS_TOKEN|META_SYSTEM_TOKEN  Meta token with events perms on the pixel.
//   META_CAPI_PIXEL_ID        default 2210707412649816 (ERE HOMES - CAPI).
//   META_API_VERSION          default v21.0.

const QUALIFIED_STAGES = new Set([8, 9, 10, 11, 19]); // Qualified, Viewing, Offer Made/Accepted, Closed Won
const PIPELINE_ID = 2;

const clean = (v?: string | null) => (v || "").replace(/^﻿/, "").trim();
const PIXEL = () => clean(process.env.META_CAPI_PIXEL_ID) || "2210707412649816";
const TOKEN = () => clean(process.env.META_ADS_TOKEN) || clean(process.env.META_SYSTEM_TOKEN);
const V = () => clean(process.env.META_API_VERSION) || "v21.0";
const SECRET = () => clean(process.env.PIPEDRIVE_WEBHOOK_SECRET);
const LIVE = () => clean(process.env.CAPI_LIVE) === "1";

const sha = (s: string) => crypto.createHash("sha256").update(s.trim().toLowerCase()).digest("hex");

// Fire one "Qualified Lead" event, matching meta_capi_qualified_pipedrive.py byte-for-byte
// (action_source website + sentinel URL is what makes it match the native Custom Conversion
// "Qualified Lead" 1354065416693754; system_generated never matched — see memory).
async function fireCapi(phoneDigits: string, eventTime: number, leadRef: string) {
  const payload = {
    data: [
      {
        event_name: "Qualified Lead",
        event_time: eventTime,
        action_source: "website",
        event_source_url: "https://erehomes.ae/crm/qualified-lead",
        event_id: `qualw-${leadRef}`,
        user_data: { ph: [sha(phoneDigits)] },
        custom_data: { content_category: "qualified", content_name: "Qualified Lead" },
      },
    ],
  };
  // Token goes through the URL via encodeURIComponent and is never string-interpolated into
  // a logged message; nothing thrown from here carries it.
  const url = `https://graph.facebook.com/${V()}/${PIXEL()}/events?access_token=${encodeURIComponent(TOKEN())}`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  const data: any = await res.json().catch(() => ({}));
  return { ok: res.ok && (data?.events_received ?? 0) >= 1, status: res.status, received: data?.events_received ?? 0 };
}

function authed(req: NextRequest): boolean {
  const secret = SECRET();
  if (!secret) return true; // no secret configured -> open (warn in logs at deploy time)
  const got =
    new URL(req.url).searchParams.get("s") ||
    clean(req.headers.get("authorization")).replace(/^Bearer\s+/i, "");
  return got === secret;
}

export async function POST(req: NextRequest) {
  if (!authed(req)) return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });

  let body: any = {};
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ ok: true, skipped: "no-body" });
  }

  // Pipedrive v2 webhook nests the entity under `data` (memory: NOT `current`); v1 uses
  // `current`. Support both so a v1 hook still works.
  const deal = body?.data ?? body?.current ?? {};
  const dealId = Number(deal?.id);
  const stageId = Number(deal?.stage_id);
  const pipelineId = Number(deal?.pipeline_id);

  // The gate that makes this cheap: 99% of company-wide deal edits stop here, no I/O.
  if (!dealId || pipelineId !== PIPELINE_ID || !QUALIFIED_STAGES.has(stageId)) {
    return NextResponse.json({ ok: true, skipped: "not-qualified", dealId: dealId || null, stageId: stageId || null });
  }

  const db = supabaseAdmin();
  const { data: rows, error } = await db
    .from("lead_events")
    .select("id, wa_phone, name, created_at, capi_prequalified_sent_at")
    .eq("pipedrive_deal_id", dealId)
    .order("created_at", { ascending: true });
  if (error) return NextResponse.json({ ok: false, error: "db" }, { status: 500 });

  // First un-fired lead_events row for this deal. If none is pending, this qualification
  // was already reported (or the deal isn't a tracked Meta lead) -> nothing to do.
  const le = (rows || []).find((r: any) => !r.capi_prequalified_sent_at);
  if (!le) return NextResponse.json({ ok: true, skipped: "no-pending-lead-event", dealId });

  const phone = String(le.wa_phone || "").replace(/\+/g, "");
  if (!phone) return NextResponse.json({ ok: true, skipped: "no-phone", dealId, leadEventId: le.id });

  // event_time = now: the deal became qualified now, and "now" is always inside Meta's 7-day
  // window (created_at could be older and get rejected). event_id keeps dedup stable.
  const eventTime = Math.floor(Date.now() / 1000);

  if (!LIVE()) {
    console.log(
      `[capi-qualified] DRY-RUN (CAPI_LIVE unset) — would fire Qualified Lead: deal=${dealId} stage=${stageId} leadEvent=${le.id} name=${le.name || "?"}`
    );
    return NextResponse.json({ ok: true, dryRun: true, dealId, stageId, leadEventId: le.id });
  }
  if (!TOKEN()) return NextResponse.json({ ok: false, error: "no-meta-token" }, { status: 500 });

  try {
    const r = await fireCapi(phone, eventTime, String(le.id));
    if (!r.ok) {
      console.log(`[capi-qualified] FAIL deal=${dealId} leadEvent=${le.id} status=${r.status} received=${r.received}`);
      return NextResponse.json({ ok: false, error: "capi-failed", status: r.status }, { status: 502 });
    }
    await db
      .from("lead_events")
      .update({ capi_prequalified_sent_at: new Date().toISOString() })
      .eq("id", le.id);
    console.log(`[capi-qualified] OK fired Qualified Lead deal=${dealId} leadEvent=${le.id} name=${le.name || "?"}`);
    return NextResponse.json({ ok: true, fired: true, dealId, leadEventId: le.id });
  } catch (e: any) {
    console.log(`[capi-qualified] ERR deal=${dealId} leadEvent=${le.id}: ${String(e?.message || e).slice(0, 160)}`);
    return NextResponse.json({ ok: false, error: "exception" }, { status: 500 });
  }
}

// Lightweight probe so hitting the URL in a browser confirms the route is deployed and
// shows which mode it's in — without leaking any secret or token value.
export async function GET() {
  return NextResponse.json({
    ok: true,
    route: "pipedrive/qualified",
    mode: LIVE() ? "live" : "log-only",
    secretConfigured: Boolean(SECRET()),
    pixel: PIXEL(),
  });
}
