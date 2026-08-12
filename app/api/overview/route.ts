// Command Centre — the one route behind hub.erehomes.ae.
//
// Returns everything the home page needs in a single call: the four tiles, the
// deduplicated inbound lead list (untouched first), the per-source split, and
// an honest account of what was EXCLUDED.
//
// Design decisions this route encodes (settled with Zek 12 Aug 2026):
//   - Pipedrive is the spine. Website and portal leads never enter the WhatsApp
//     database, so aggregating Supabase alone would miss most inquiries.
//   - Leads are LIVE on every call; money refreshes hourly (Meta does not report
//     spend faster than that, so re-pulling it per page load buys nothing).
//   - One row per PERSON, not per inquiry. Someone who fills a Meta form and
//     then WhatsApps is one lead tagged with both, so the count stays honest and
//     cost per lead does not read artificially low.
//   - Telesales list uploads are NOT leads. 2,959 of 3,783 deals created in a
//     14-day window were owner/DAMAC batch loads. They are excluded and the
//     excluded count is returned, so "0 dropped" can never look the same as
//     "the filter never ran".
import { NextRequest, NextResponse } from "next/server";
import {
  classifyDeal, isTouched, isQualified, PIPELINE_PROPERTY, AUTOMATION_USER_IDS,
} from "@/lib/leadSource";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const clean = (v?: string) => (v || "").replace(/^﻿/, "").trim();
const PD_TOKEN = () => clean(process.env.PIPEDRIVE_API_TOKEN);
const PD_BASE = "https://api.pipedrive.com";

type Win = "24h" | "today" | "7d" | "30d";
const WINDOWS: Record<Win, number> = { "24h": 1, today: 1, "7d": 7, "30d": 30 };

function windowStart(win: Win): Date {
  const now = new Date();
  if (win === "today") {
    // Calendar day in Dubai, so the page lines up with every other ERE report.
    const dubai = new Date(now.getTime() + 4 * 3600_000);
    dubai.setUTCHours(0, 0, 0, 0);
    return new Date(dubai.getTime() - 4 * 3600_000);
  }
  return new Date(now.getTime() - (WINDOWS[win] || 1) * 86400_000);
}

/** One Pipedrive call. The token rides in the query string, so nothing that
 *  throws here may ever echo the URL — errors carry the path only. */
async function pd(path: string, params: Record<string, string | number>, version = 1) {
  const q = new URLSearchParams({ ...Object.fromEntries(
    Object.entries(params).map(([k, v]) => [k, String(v)])), api_token: PD_TOKEN() });
  const res = await fetch(`${PD_BASE}/api/v${version}/${path}?${q}`, {
    cache: "no-store",
  });
  if (!res.ok) throw new Error(`Pipedrive GET ${path} -> ${res.status}`);
  const j = await res.json().catch(() => ({}));
  return j;
}

/**
 * Walk deals newest-first and STOP at the window edge.
 *
 * Paging every list endpoint matters: a single page of 500 against a 3,783-deal
 * fortnight reads as "the run stopped early" rather than "the query stopped
 * early". The cap is a runaway guard, and when it bites the caller is told, so
 * a truncated sweep can never be reported as full coverage.
 */
async function dealsSince(since: Date, cap = 6000) {
  const out: any[] = [];
  let start = 0;
  let truncated = false;
  const sinceMs = since.getTime();
  for (;;) {
    const j = await pd("deals", {
      limit: 500, start, sort: "add_time DESC",
      status: "all_not_deleted",
    });
    const batch: any[] = j?.data || [];
    if (!batch.length) break;
    for (const d of batch) {
      const t = Date.parse(String(d.add_time || "").replace(" ", "T") + "Z");
      if (!isNaN(t) && t < sinceMs) return { deals: out, truncated };
      out.push(d);
    }
    const more = j?.additional_data?.pagination?.more_items_in_collection;
    if (!more) break;
    start = j.additional_data.pagination.next_start ?? start + 500;
    if (out.length >= cap) { truncated = true; break; }
  }
  return { deals: out, truncated };
}

/**
 * Deal ids carrying a note written by a REAL PERSON in this window.
 *
 * One windowed /notes call, not one per deal. Every inbound deal is born with
 * automation notes attached, so the author is the only thing separating "an
 * agent wrote something" from "the integration logged the enquiry".
 */
async function humanNotedDeals(since: Date): Promise<Set<number>> {
  const ids = new Set<number>();
  let start = 0;
  for (;;) {
    const j = await pd("notes", {
      limit: 500, start,
      start_date: since.toISOString().slice(0, 10),
      sort: "add_time DESC",
    });
    const batch: any[] = j?.data || [];
    if (!batch.length) break;
    for (const n of batch) {
      if (!n?.deal_id) continue;
      if (AUTOMATION_USER_IDS.has(Number(n.user_id))) continue;
      ids.add(Number(n.deal_id));
    }
    const more = j?.additional_data?.pagination?.more_items_in_collection;
    if (!more) break;
    start = j.additional_data.pagination.next_start ?? start + 500;
    if (start > 20000) break; // runaway guard
  }
  return ids;
}

/** Meta spend for the window. Returns null when unavailable — never 0, because
 *  a zero reads as "we spent nothing" and that is a different fact. */
async function metaSpend(since: Date): Promise<number | null> {
  const token = clean(process.env.META_ADS_TOKEN) || clean(process.env.META_SYSTEM_TOKEN);
  const act = clean(process.env.META_AD_ACCOUNT_ID);
  const v = clean(process.env.META_API_VERSION) || "v21.0";
  if (!token || !act) return null;
  const until = new Date().toISOString().slice(0, 10);
  const from = since.toISOString().slice(0, 10);
  const q = new URLSearchParams({
    fields: "spend",
    time_range: JSON.stringify({ since: from, until }),
    access_token: token,
  });
  try {
    const res = await fetch(`https://graph.facebook.com/${v}/${act}/insights?${q}`,
      { cache: "no-store" });
    if (!res.ok) return null;
    const j = await res.json();
    const rows: any[] = j?.data || [];
    if (!rows.length) return 0; // a real zero: the account reported and spent nothing
    return rows.reduce((s, r) => s + Number(r.spend || 0), 0);
  } catch {
    return null; // unreachable is NOT zero
  }
}

const phoneOf = (d: any): string => {
  const p = d?.person_id;
  const raw = Array.isArray(p?.phone) ? (p.phone[0]?.value || "") : (p?.phone || "");
  return String(raw).replace(/\D/g, "").slice(-9); // last 9 digits: the UAE-safe key
};

export async function GET(req: NextRequest) {
  try {
    if (!PD_TOKEN()) {
      return NextResponse.json({ error: "PIPEDRIVE_API_TOKEN not set" }, { status: 500 });
    }
    const win = (req.nextUrl.searchParams.get("window") || "today") as Win;
    const since = windowStart(win);

    const [{ deals, truncated }, spend, humanNotes] = await Promise.all([
      dealsSince(since),
      metaSpend(since),
      humanNotedDeals(since),
    ]);

    // Property pipeline only. Recruitment is a different funnel with its own
    // definition of qualified; blending them drags CPL and can never qualify.
    const inWindow = deals.filter((d) => Number(d.pipeline_id) === PIPELINE_PROPERTY);

    const bySource: Record<string, number> = {};
    let bulk = 0, unclassified = 0;
    type Row = {
      id: number; name: string; title: string; source: string; org: string;
      owner: string; stage: number; addedAt: string; touched: boolean;
      qualified: boolean; phone: string; sources: string[];
    };
    const byPerson = new Map<string, Row>();
    const rows: Row[] = [];

    for (const d of inWindow) {
      const { kind, source } = classifyDeal(d);
      if (kind === "BULK") { bulk++; continue; }
      if (kind === "UNCLASSIFIED") { unclassified++; continue; }

      bySource[source] = (bySource[source] || 0) + 1;
      const row: Row = {
        id: Number(d.id),
        name: String(d.person_id?.name || d.title || "").slice(0, 60),
        title: String(d.title || ""),
        source,
        org: String(d.org_id?.name || ""),
        owner: String(d.owner_id?.name || d.user_id?.name || ""),
        stage: Number(d.stage_id),
        addedAt: String(d.add_time || ""),
        touched: isTouched(d, humanNotes),
        qualified: isQualified(d),
        phone: phoneOf(d),
        sources: [source],
      };

      // One row per person. Merge on the phone key when we have one; a deal
      // with no phone can only ever be itself, so it never merges (merging on
      // a blank key would collapse every phoneless lead into one row).
      const key = row.phone;
      if (key && byPerson.has(key)) {
        const seen = byPerson.get(key)!;
        if (!seen.sources.includes(source)) seen.sources.push(source);
        // The merged row keeps the WORST state: untouched wins, so a person
        // nobody has called cannot be hidden by a second deal that was touched.
        seen.touched = seen.touched && row.touched;
        seen.qualified = seen.qualified || row.qualified;
        if (row.addedAt > seen.addedAt) seen.addedAt = row.addedAt;
        continue;
      }
      if (key) byPerson.set(key, row);
      rows.push(row);
    }

    // Untouched first, then newest. That ordering IS the product: the page
    // exists to surface the lead nobody has picked up.
    rows.sort((a, b) =>
      Number(a.touched) - Number(b.touched) || (a.addedAt < b.addedAt ? 1 : -1));

    const leads = rows.length;
    const untouched = rows.filter((r) => !r.touched).length;
    const qualified = rows.filter((r) => r.qualified).length;

    return NextResponse.json({
      window: win,
      since: since.toISOString(),
      generatedAt: new Date().toISOString(),
      tiles: {
        leads,
        untouched,
        // null spend renders as a dash, never as 0.
        spend: spend === null ? null : Math.round(spend * 100) / 100,
        qualified,
        cpl: spend && leads ? Math.round((spend / leads) * 100) / 100 : null,
        cpql: spend && qualified ? Math.round((spend / qualified) * 100) / 100 : null,
      },
      bySource,
      // Said out loud, always. An excluded count that is never printed is how a
      // filter that stopped running looks identical to a filter finding nothing.
      excluded: { bulkUploads: bulk, unclassified },
      truncated,
      rows: rows.slice(0, 200),
    });
  } catch (e: any) {
    // Never leak the URL: it carries the token.
    return NextResponse.json({ error: String(e?.message || e) }, { status: 500 });
  }
}
