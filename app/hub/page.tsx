"use client";
// ERE Command Centre — the one page. hub.erehomes.ae
//
// Week 1 scope (settled with Zek 12 Aug 2026): four tiles, the live inbound lead
// list with untouched first, the per-source split, and an honest statement of
// what was excluded. Money detail, engagement and the remaining channels land in
// weeks 2 and 3.
//
// Nothing here ever invents a number. A value we could not fetch renders as an
// em dash, never as 0 — "we spent nothing" and "we could not read the spend" are
// different facts and must never look the same on screen.
import { useCallback, useEffect, useState } from "react";
import { PageHead, Skeleton } from "@/lib/ui";
import { useLive } from "@/lib/useLive";

type Row = {
  id: number; name: string; title: string; source: string; org: string;
  owner: string; stage: number; addedAt: string; touched: boolean;
  qualified: boolean; phone: string; sources: string[];
};
type Overview = {
  window: string; since: string; generatedAt: string;
  tiles: {
    leads: number; untouched: number; spend: number | null;
    qualified: number; cpl: number | null; cpql: number | null;
  };
  bySource: Record<string, number>;
  excluded: { bulkUploads: number; unclassified: number };
  truncated: boolean;
  rows: Row[];
};

const WINDOWS: [string, string][] = [
  ["24h", "Last 24h"], ["today", "Today"], ["7d", "7 days"], ["30d", "30 days"],
];

// A dash, never a zero, for anything we could not read.
const dash = (n: number | null | undefined) =>
  n === null || n === undefined ? "—" : n.toLocaleString();
const aed = (n: number | null | undefined) =>
  n === null || n === undefined ? "—" : `${Math.round(n).toLocaleString()}`;

const PD_DEAL = "https://erehomesrealestatebrokers.pipedrive.com/deal/";

function age(iso: string) {
  const t = Date.parse(String(iso || "").replace(" ", "T") + "Z");
  if (isNaN(t)) return "";
  const m = Math.round((Date.now() - t) / 60000);
  if (m < 1) return "now";
  if (m < 60) return `${m}m`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h`;
  return `${Math.round(h / 24)}d`;
}

// Hours a lead has been sitting, for the red/amber escalation on untouched rows.
function hoursOld(iso: string) {
  const t = Date.parse(String(iso || "").replace(" ", "T") + "Z");
  return isNaN(t) ? 0 : (Date.now() - t) / 3600_000;
}

export default function Hub() {
  const [win, setWin] = useState("today");
  const [data, setData] = useState<Overview | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    try {
      const r = await fetch(`/api/overview?window=${win}`, { cache: "no-store" });
      const j = await r.json();
      if (!r.ok) throw new Error(j?.error || `HTTP ${r.status}`);
      setData(j);
      setErr(null);
    } catch (e: any) {
      // An honest error, never a stale-looking page pretending to be current.
      setErr(String(e?.message || e));
    } finally {
      setLoading(false);
    }
  }, [win]);

  useEffect(() => { setLoading(true); load(); }, [load]);

  // Meta leads land in Supabase, so those arrive as a push. Portal, website and
  // call leads are created straight in Pipedrive, which cannot push to us — the
  // 30-second poll is what covers them. Both together, not either alone.
  useLive(["lead_events", "conversations"], load);
  useEffect(() => {
    const t = setInterval(load, 30_000);
    return () => clearInterval(t);
  }, [load]);

  const t = data?.tiles;
  const rows = data?.rows || [];
  const sources = Object.entries(data?.bySource || {}).sort((a, b) => b[1] - a[1]);

  return (
    <>
      <PageHead title="Command Centre" sub="Every inquiry, every channel, one page">
        <div className="seg-tabs" role="tablist">
          {WINDOWS.map(([k, label]) => (
            <button key={k} role="tab" aria-selected={win === k}
              className={win === k ? "on" : ""} onClick={() => setWin(k)}>{label}</button>
          ))}
        </div>
      </PageHead>

      {err && (
        <div className="card hub-err">
          <b>Could not load.</b> {err}
          <button className="card-link" onClick={load} style={{ marginLeft: 10 }}>Retry</button>
        </div>
      )}

      <div className="kpis k4">
        <div className="kpi">
          <div className="kl">Leads in</div>
          <div className="kv">{loading && !data ? "—" : dash(t?.leads)}</div>
          <div className="ks">{data ? `since ${new Date(data.since).toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}` : ""}</div>
        </div>
        <div className="kpi">
          <div className="kl"><span className="dot" style={{ background: "var(--red)" }} />Untouched</div>
          <div className="kv" style={{ color: (t?.untouched || 0) > 0 ? "var(--red)" : undefined }}>
            {loading && !data ? "—" : dash(t?.untouched)}
          </div>
          <div className="ks">no note, no stage move</div>
        </div>
        <div className="kpi">
          <div className="kl">Spend</div>
          <div className="kv">{aed(t?.spend)} <span style={{ fontSize: 14, fontWeight: 600 }}>AED</span></div>
          <div className="ks">{t?.cpl ? `CPL ${aed(t.cpl)} AED` : "Meta ads"}</div>
        </div>
        <div className="kpi">
          <div className="kl">Qualified</div>
          <div className="kv">{loading && !data ? "—" : dash(t?.qualified)}</div>
          <div className="ks">{t?.cpql ? `CPQL ${aed(t.cpql)} AED` : "stage Qualified or beyond"}</div>
        </div>
      </div>

      <div className="card">
        <div className="card-head">
          <div className="card-t">Today&rsquo;s leads</div>
          <div className="card-meta">
            {data ? `${rows.length} shown · updated ${new Date(data.generatedAt).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}` : ""}
          </div>
        </div>
        {loading && !data ? <Skeleton rows={6} /> : rows.length === 0 ? (
          // Empty is a real answer and is rendered as one. No fixtures, ever.
          <div className="hub-empty">No inquiries in this window.</div>
        ) : (
          <div className="hub-rows">
            {rows.map((r) => {
              const hrs = hoursOld(r.addedAt);
              const tone = r.touched ? "" : hrs >= 4 ? "bad" : hrs >= 2 ? "warn" : "new";
              return (
                <a key={r.id} className={`hub-row ${tone}`} href={`${PD_DEAL}${r.id}`}
                  target="_blank" rel="noreferrer">
                  <span className="hr-dot" />
                  <span className="hr-name">{r.name || r.title}</span>
                  <span className="hr-src">
                    {r.sources.map((s) => <span key={s} className="hr-tag">{s}</span>)}
                  </span>
                  <span className="hr-owner">{r.owner || "unassigned"}</span>
                  <span className="hr-age">{age(r.addedAt)}</span>
                  <span className="hr-state">
                    {r.qualified ? "Qualified" : r.touched ? "Worked" : "Untouched"}
                  </span>
                </a>
              );
            })}
          </div>
        )}
      </div>

      <div className="card">
        <div className="card-head"><div className="card-t">Where they came from</div></div>
        {sources.length === 0 ? (
          <div className="hub-empty">Nothing in this window.</div>
        ) : (
          <div className="hub-srcs">
            {sources.map(([s, n]) => (
              <div key={s} className="hub-src">
                <div className="hs-n">{n}</div>
                <div className="hs-l">{s}</div>
              </div>
            ))}
          </div>
        )}
        {data && (
          // The excluded count is stated out loud, always. A filter that stopped
          // running and a filter that found nothing must never look the same.
          <div className="hub-note">
            Excluded: {data.excluded.bulkUploads.toLocaleString()} telesales/owner list uploads
            (not inquiries){data.excluded.unclassified ? `, ${data.excluded.unclassified.toLocaleString()} unclassified` : ""}.
            {data.truncated ? " Result truncated — coverage incomplete for this window." : ""}
          </div>
        )}
      </div>
    </>
  );
}
