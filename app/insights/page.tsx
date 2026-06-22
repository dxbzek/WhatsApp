"use client";
import { useEffect, useState } from "react";
import { Icon, IC, PageHead, downloadCSV } from "@/lib/ui";
import { errorCause, DEAD_NUMBER_CODES } from "@/lib/twilioErrors";

// datetime-local <-> Date helpers (local time, minute precision)
const pad = (n: number) => String(n).padStart(2, "0");
const toInput = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
const QUICK: [string, number][] = [["24h", 24], ["7d", 168], ["30d", 720], ["90d", 2160]];

type Totals = { outbound: number; validOutbound: number; notOnWhatsApp: number; deliveryRate: number; deliveryRateValid: number; readRate: number; inbound: number; failed: number; undelivered: number; failRate: number; neverSent?: number; accountLocked?: number; marketingThrottled?: number };
type TplRow = { name: string; sent: number; replyRate: number };

// One authoritative source of error-code labels (lib/twilioErrors), shared with
// the campaign log — so "63024" reads "not a WhatsApp user", not a wrong guess.
const errLabel = (code: string) => `${code} — ${errorCause(code)}`;
const LEAD_ORDER = ["hot", "warm", "new", "cold", "won", "lost"] as const;
const LEAD_LABEL: Record<string, string> = { new: "New", hot: "Hot", warm: "Warm", cold: "Cold", won: "Won", lost: "Lost" };
const LEAD_COLOR: Record<string, string> = { hot: "var(--red)", warm: "var(--amber-dot)", new: "var(--ink-3)", cold: "var(--blue)", won: "var(--green-dot)", lost: "var(--ink-3)" };

const dash = "—";

export default function Insights() {
  // Default window: last 24 hours.
  const [to, setTo] = useState(() => toInput(new Date()));
  const [from, setFrom] = useState(() => toInput(new Date(Date.now() - 24 * 3600000)));
  const setQuick = (hours: number) => { const n = new Date(); setTo(toInput(n)); setFrom(toInput(new Date(n.getTime() - hours * 3600000))); };
  const hrs = Math.max(1, Math.round((new Date(to).getTime() - new Date(from).getTime()) / 3600000));
  const spanLabel = hrs <= 48 ? `${hrs}h` : `${Math.round(hrs / 24)}d`;
  const [totals, setTotals] = useState<Totals | null>(null);
  const [byErr, setByErr] = useState<Record<string, number>>({});
  const [tpls, setTpls] = useState<TplRow[] | null>(null);
  const [replyRate, setReplyRate] = useState<number | null>(null);
  const [leads, setLeads] = useState<number | null>(null);
  const [pipeline, setPipeline] = useState<Record<string, number> | null>(null);
  const [err, setErr] = useState<string | null>(null);

  // Real Twilio messaging totals for the selected window.
  useEffect(() => {
    setTotals(null); setByErr({}); setErr(null);
    const qs = `from=${encodeURIComponent(new Date(from).toISOString())}&to=${encodeURIComponent(new Date(to).toISOString())}`;
    fetch(`/api/insights?${qs}`)
      .then((r) => r.json())
      .then((d) => { if (d?.totals) { setTotals(d.totals); setByErr(d.byErr || {}); } else if (d?.error) setErr(d.error); })
      .catch(() => setErr("Could not load Twilio insights."));
  }, [from, to]);

  // Real per-template performance (last 90 days) → top templates + overall reply rate.
  useEffect(() => {
    Promise.all([
      fetch("/api/templates/performance").then((r) => r.json()),
      fetch("/api/templates").then((r) => r.json()),
    ])
      .then(([perf, list]) => {
        const stats: Record<string, any> = perf?.stats || {};
        const names: Record<string, string> = {};
        for (const t of list?.templates || []) names[t.sid] = t.name;
        const rows: TplRow[] = Object.entries(stats)
          .map(([sid, s]: any) => ({ name: names[sid] || sid, sent: s.sent, replyRate: s.replyRate }))
          .filter((r) => r.sent > 0)
          .sort((a, b) => b.replyRate - a.replyRate)
          .slice(0, 6);
        setTpls(rows);
        // Reply rate of DELIVERED (people who actually received it), never of
        // every conversation — failed/undelivered sends don't belong in the base.
        let replied = 0, delivered = 0;
        for (const s of Object.values(stats) as any[]) { replied += s.replied || 0; delivered += s.delivered || 0; }
        setReplyRate(delivered ? Math.round((replied / delivered) * 100) : 0);
      })
      .catch(() => { setTpls([]); setReplyRate(0); });
  }, []);

  // Real lead pipeline from our own conversations. Leads = people who tapped
  // Interested (hot) — the inbox Hot tab is the lead home now, not Pipedrive.
  // The pipeline view already excludes errors (failed/dead/opt-out).
  useEffect(() => {
    setPipeline(null);
    const qs = `from=${encodeURIComponent(new Date(from).toISOString())}&to=${encodeURIComponent(new Date(to).toISOString())}`;
    fetch(`/api/conversations?view=pipeline&${qs}`)
      .then((r) => r.json())
      .then((d) => {
        const rows = d.conversations || [];
        const pl: Record<string, number> = {};
        let l = 0;
        for (const c of rows as any[]) {
          pl[c.lead_status || "new"] = (pl[c.lead_status || "new"] || 0) + 1;
          if ((c.lead_status || "") === "hot") l++;
        }
        setPipeline(pl);
        setLeads(l);
      })
      .catch(() => { setPipeline({}); setLeads(0); });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [from, to]);

  const exportCSV = () => {
    const rows: (string | number)[][] = [["Section", "Name", "Value", "Detail"]];
    // Headline KPIs first — the actual numbers shown on the page, so an exported
    // report isn't just templates + pipeline with the metrics missing.
    rows.push(["Metric", "Messages attempted", totals?.outbound ?? "", `last ${spanLabel}`]);
    rows.push(["Metric", "Messages sent (on WhatsApp)", totals?.validOutbound ?? "", `${notOnWA} not on WhatsApp`]);
    rows.push(["Metric", "Not on WhatsApp", notOnWA, "dead numbers (63024/63003/21211/21614)"]);
    rows.push(["Metric", "Delivery rate % (reachable)", totals?.deliveryRateValid ?? "", `of ${totals?.validOutbound ?? ""} on WhatsApp`]);
    rows.push(["Metric", "Delivery rate % (all attempts)", totals?.deliveryRate ?? "", `of ${totals?.outbound ?? ""} attempted`]);
    rows.push(["Metric", "Failed/undelivered (real)", realFailed, topRealErr ? errLabel(topRealErr) : ""]);
    rows.push(["Metric", "Read rate %", totals?.readRate ?? "", "of delivered"]);
    rows.push(["Metric", "Reply rate %", replyRate ?? "", "marketing · 90d"]);
    rows.push(["Metric", "Interested leads", leads ?? "", `tapped Interested · last ${spanLabel}`]);
    (tpls || []).forEach((t) => rows.push(["Template", t.name, t.sent, `${t.replyRate}% reply`]));
    Object.entries(pipeline || {}).forEach(([k, v]) => rows.push(["Lead status", LEAD_LABEL[k] || k, v, ""]));
    downloadCSV(`ere-insights-${spanLabel}.csv`, rows);
  };

  const kv = (v: string | number | null, suffix = "") => (v === null ? dash : `${v}${suffix}`);
  const pipeRows = LEAD_ORDER.filter((k) => (pipeline?.[k] ?? 0) > 0);
  const pipeMax = Math.max(1, ...Object.values(pipeline || {}));
  // Failed deliveries + the single most common reason, to explain the delivery rate.
  // Numbers not on WhatsApp are dead numbers, not real delivery failures - break them
  // out so the headline "sent" and delivery rate reflect reachable numbers only.
  const NOT_ON_WA = DEAD_NUMBER_CODES;
  const failedCount = totals ? totals.failed + totals.undelivered : 0;
  const notOnWA = totals ? totals.notOnWhatsApp : 0;
  const realFailed = Math.max(0, failedCount - notOnWA);
  const topErr = Object.entries(byErr).sort((a, b) => b[1] - a[1])[0]?.[0] || null;
  const topRealErr = Object.entries(byErr).filter(([k]) => !NOT_ON_WA.has(k)).sort((a, b) => b[1] - a[1])[0]?.[0] || null;

  return (
    <div className="page"><div className="maxw">
      <PageHead title="Insights" sub="Real WhatsApp messaging performance from Twilio and your inbox — no estimates.">
        <div className="seg">
          {QUICK.map(([id, h]) => (
            <button key={id} className={spanLabel === id ? "on" : ""} onClick={() => setQuick(h)}>{id}</button>
          ))}
        </div>
        <input type="datetime-local" className="input dt-range" value={from} max={to} onChange={(e) => setFrom(e.target.value)} title="From" />
        <span style={{ color: "var(--ink-3)" }}>→</span>
        <input type="datetime-local" className="input dt-range" value={to} min={from} onChange={(e) => setTo(e.target.value)} title="To" />
        <button className="btn btn-sec" onClick={exportCSV}><Icon d={IC.dl} s={15} />Export</button>
      </PageHead>

      {err && <div className="err-box" style={{ marginBottom: 14 }}>{err}</div>}

      <div className="kpis k5">
        <div className="kpi" title={totals ? `${totals.outbound.toLocaleString()} attempted, ${notOnWA.toLocaleString()} not on WhatsApp` : ""}><div className="kl">Messages sent</div><div className="kv">{kv(totals ? totals.validOutbound.toLocaleString() : null)}</div><div className="ks">{totals ? (notOnWA ? `${notOnWA.toLocaleString()} not on WhatsApp` : `last ${spanLabel}`) : `last ${spanLabel}`}</div></div>
        <div className="kpi" title="Delivery rate among numbers that are on WhatsApp (excludes dead numbers)"><div className="kl">Delivery rate</div><div className="kv">{kv(totals ? totals.deliveryRateValid : null, "%")}</div><div className="ks">{totals ? (realFailed ? `${realFailed.toLocaleString()} failed${topRealErr ? ` · ${errLabel(topRealErr)}` : ""}` : `of ${totals.validOutbound.toLocaleString()} on WhatsApp`) : "of sent"}</div></div>
        <div className="kpi"><div className="kl">Read rate</div><div className="kv">{kv(totals ? totals.readRate : null, "%")}</div><div className="ks">of delivered</div></div>
        <div className="kpi"><div className="kl">Reply rate</div><div className="kv">{kv(replyRate, "%")}</div><div className="ks">marketing · 90d</div></div>
        <div className="kpi"><div className="kl">Interested leads</div><div className="kv">{leads === null ? dash : leads.toLocaleString()}</div><div className="ks">tapped Interested · last {spanLabel}</div></div>
      </div>

      {totals && ((totals.accountLocked ?? 0) > 0 || (totals.marketingThrottled ?? 0) > 0 || (totals.neverSent ?? 0) > 0) && (
        <div className="note" style={{ display: "flex", flexWrap: "wrap", gap: 16, fontSize: 13, color: "var(--ink-3)", margin: "2px 0 14px", padding: "8px 12px", background: "var(--chip)", borderRadius: 8 }}>
          {((totals.accountLocked ?? 0) > 0 || (totals.neverSent ?? 0) > 0) && <span style={{ color: "var(--ink-2)" }}>Excluded from the rate (never reached a real attempt):</span>}
          {(totals.accountLocked ?? 0) > 0 && <span><b style={{ color: "var(--ink-1)" }}>{totals.accountLocked!.toLocaleString()}</b> sender/account locked by Meta (63051 · the suspension)</span>}
          {(totals.neverSent ?? 0) > 0 && <span><b style={{ color: "var(--ink-1)" }}>{totals.neverSent!.toLocaleString()}</b> never sent (canceled/skipped)</span>}
          {(totals.marketingThrottled ?? 0) > 0 && <span style={{ color: "var(--amber-dot, var(--ink-2))" }}>Counted as failed: <b style={{ color: "var(--ink-1)" }}>{totals.marketingThrottled!.toLocaleString()}</b> Meta marketing throttle (63049 · over-messaging live numbers)</span>}
        </div>
      )}

      <div className="grid-2">
        <div className="card">
          <div className="card-head"><div className="card-t">Top templates</div><div className="card-meta">by reply rate · 90d</div></div>
          <div className="perf">
            {tpls === null && <div className="perf-row"><div className="perf-name" style={{ color: "var(--ink-3)" }}>Loading…</div></div>}
            {tpls && tpls.length === 0 && <div className="perf-row"><div className="perf-name" style={{ color: "var(--ink-3)" }}>No template sends yet.</div></div>}
            {(tpls || []).map((t) => (
              <div className="perf-row" key={t.name}>
                <div className="perf-name mono">{t.name}</div>
                <div className="perf-stat">{t.sent.toLocaleString()} sent</div>
                <div className="perf-stat strong">{t.replyRate}% reply</div>
              </div>
            ))}
          </div>
        </div>
        <div className="card">
          <div className="card-head"><div className="card-t">Lead pipeline</div><div className="card-meta">conversations · last {spanLabel}</div></div>
          <div className="perf">
            {pipeline === null && <div className="perf-row"><div className="perf-name" style={{ color: "var(--ink-3)" }}>Loading…</div></div>}
            {pipeline && pipeRows.length === 0 && <div className="perf-row"><div className="perf-name" style={{ color: "var(--ink-3)" }}>No conversations in range.</div></div>}
            {pipeRows.map((k) => (
              <div className="perf-row" key={k}>
                <div className="perf-name" style={{ display: "flex", alignItems: "center", gap: 8, minWidth: 70 }}>
                  <span style={{ width: 8, height: 8, borderRadius: 8, background: LEAD_COLOR[k], display: "inline-block" }} />{LEAD_LABEL[k]}
                </div>
                <div style={{ flex: 1, height: 6, background: "var(--chip)", borderRadius: 6, margin: "0 12px", overflow: "hidden" }}>
                  <div style={{ width: `${Math.round(((pipeline?.[k] ?? 0) / pipeMax) * 100)}%`, height: "100%", background: LEAD_COLOR[k] }} />
                </div>
                <div className="perf-stat strong">{(pipeline?.[k] ?? 0).toLocaleString()}</div>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div></div>
  );
}
