import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase";
import { getPageToken, listActiveForms, fetchFormLeads } from "@/lib/metaLeads";
import { ingestMetaLead } from "@/lib/leadIngest";
import { retryPipedriveBacklog } from "@/lib/metaLeadPipedrive";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

// Polls the ERE Homes Page's active lead forms for NEW Instant-Form leads and
// routes each one to its agent (lead_routes), with no Zapier in the loop. Dedupes
// on leadgen_id via meta_seen_leads so a lead is processed exactly once; a failed
// run simply retries on the next tick. Secured by CRON_SECRET (pg_cron passes it
// as x-cron-secret), same as the dispatch / lead-watch crons.
const PER_FORM = 50; // most recent leads to scan per form per run

async function run(req: NextRequest) {
  const secret = process.env.CRON_SECRET;
  if (!secret) return NextResponse.json({ error: "CRON_SECRET not configured" }, { status: 503 });
  const provided = req.headers.get("x-cron-secret") || new URL(req.url).searchParams.get("key") || "";
  if (provided !== secret) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const db = supabaseAdmin();
  let forms = 0, scanned = 0, fresh = 0, routed = 0;
  const errors: string[] = [];

  let pageToken: string;
  try {
    pageToken = await getPageToken();
  } catch (e: any) {
    return NextResponse.json({ error: `Meta auth failed: ${e?.message || e}` }, { status: 502 });
  }

  let formList: { id: string; name: string }[] = [];
  try {
    formList = await listActiveForms(pageToken);
  } catch (e: any) {
    return NextResponse.json({ error: `List forms failed: ${e?.message || e}` }, { status: 502 });
  }
  forms = formList.length;

  for (const form of formList) {
    let leads;
    try {
      leads = await fetchFormLeads(pageToken, form.id, PER_FORM);
    } catch (e: any) {
      errors.push(`form ${form.id}: ${e?.message || e}`);
      continue;
    }
    for (const lead of leads) {
      scanned++;
      // Dedupe: insert the id; if it already existed, ignoreDuplicates yields no row.
      const { data: claimed, error: seenErr } = await db
        .from("meta_seen_leads")
        .upsert({ leadgen_id: lead.id }, { onConflict: "leadgen_id", ignoreDuplicates: true })
        .select("leadgen_id");
      if (seenErr) { errors.push(`seen ${lead.id}: ${seenErr.message}`); continue; }
      if (!claimed || claimed.length === 0) continue; // already processed on a prior run
      fresh++;

      const res = await ingestMetaLead({
        name: lead.name,
        phone: lead.phone,
        email: lead.email,
        detail: lead.detail,
        listing: lead.listing, // the specific ad set (e.g. "Marina Residences 6") shown in the agent alert
        adId: lead.ad_id,
        adsetId: lead.adset_id,
        campaignId: lead.campaign_id,
        adsetName: lead.adset_name,
        adName: lead.ad_name,
        metaLeadId: lead.id, // leadgen id — CRM attribution key for the Qualified Lead CAPI event
        answers: lead.answers, // qualifying answers (rent vs sell, community, …)
      });
      if (res.status === "routed") routed++;

      // Stamp the outcome on the dedupe row for at-a-glance debugging.
      await db.from("meta_seen_leads").update({
        name: lead.name || null,
        status: res.ok ? (res.status || null) : (res.error || "ingest_error"),
      }).eq("leadgen_id", lead.id);
    }
  }

  // Sweep any lead whose Pipedrive deal never got created (rate limit, timeout, deploy).
  // This cron runs every 2 minutes round the clock, so a transient CRM failure costs
  // minutes rather than losing the lead. Best-effort: never fails the ingest run.
  const pipedrive = await retryPipedriveBacklog().catch(() => ({ retried: 0, created: 0 }));

  return NextResponse.json({ ok: true, forms, scanned, fresh, routed, pipedrive, errors });
}

export async function GET(req: NextRequest) { return run(req); }
export async function POST(req: NextRequest) { return run(req); }
