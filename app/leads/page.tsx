"use client";
import { useEffect, useMemo, useState } from "react";
import { Icon, IC, PageHead, Skeleton, Avatar } from "@/lib/ui";
import { Pager } from "@/lib/Pager";
import { formatPhone } from "@/lib/format";

const PAGE_SIZE = 50;

// A lead as returned by /api/conversations?view=by-status.
type Lead = {
  id: string;
  wa_phone: string;
  name: string | null;
  lead_ref: string | null;
  lead_status: string | null;
  lead_stage: string | null;
  stage_updated_at: string | null;
  assigned_at: string | null;
  agent_name: string | null;
  source: string | null;
};

// The pipeline, in the order a lead travels it. "" = no stage set yet.
const STAGES: { key: string; label: string; short: string; color: string }[] = [
  { key: "", label: "Not contacted yet", short: "Not contacted", color: "var(--ink-3)" },
  { key: "contacted", label: "Contacted", short: "Contacted", color: "var(--blue)" },
  { key: "viewing", label: "Viewing", short: "Viewing", color: "var(--amber-dot)" },
  { key: "won", label: "Won", short: "Won", color: "var(--green-dot)" },
  { key: "lost", label: "Lost", short: "Lost", color: "var(--red)" },
];
const stageMeta = (k: string | null) => STAGES.find((s) => s.key === (k || "")) || STAGES[0];

const dash = "—";

// Compact relative time, e.g. "5m ago", "3h ago", "2d ago", else a date.
function relTime(iso: string | null): string {
  if (!iso) return dash;
  const ms = Date.now() - new Date(iso).getTime();
  if (Number.isNaN(ms)) return dash;
  const m = Math.round(ms / 60000);
  if (m < 1) return "just now";
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.round(h / 24);
  if (d < 30) return `${d}d ago`;
  return new Date(iso).toLocaleDateString([], { day: "2-digit", month: "short", year: "numeric" });
}

export default function Leads() {
  const [leads, setLeads] = useState<Lead[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [filter, setFilter] = useState<string>("all");
  const [q, setQ] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [page, setPage] = useState(1);
  useEffect(() => { setPage(1); }, [filter, q]); // new filter/search -> back to page 1

  const load = () => {
    setLeads(null); setErr(null);
    fetch("/api/conversations?view=by-status")
      .then((r) => r.json())
      .then((d) => { if (d?.leads) setLeads(d.leads); else setErr(d?.error || "Could not load leads."); })
      .catch(() => setErr("Could not load leads."));
  };
  useEffect(load, []);

  // Move a lead's stage. Optimistic: the row updates immediately, and we roll it
  // back if the write fails, so a dropped request can't leave the board lying.
  async function setStage(lead: Lead, next: string) {
    const prev = lead.lead_stage;
    const now = new Date().toISOString();
    setBusy(lead.id);
    setLeads((ls) => (ls || []).map((l) => (l.id === lead.id ? { ...l, lead_stage: next || null, stage_updated_at: now } : l)));
    const ok = await fetch("/api/conversations", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: lead.id, patch: { lead_stage: next } }),
    }).then((r) => r.ok).catch(() => false);
    if (!ok) {
      setLeads((ls) => (ls || []).map((l) => (l.id === lead.id ? { ...l, lead_stage: prev, stage_updated_at: lead.stage_updated_at } : l)));
      setErr("Could not move that lead. Nothing was saved.");
    }
    setBusy(null);
  }

  const all = useMemo(() => leads || [], [leads]);

  // Counts per stage drive both the funnel strip and the filter tabs.
  const counts = useMemo(() => {
    const c: Record<string, number> = { all: all.length };
    for (const s of STAGES) c[s.key || "none"] = 0;
    for (const l of all) c[(l.lead_stage || "none")] = (c[(l.lead_stage || "none")] || 0) + 1;
    return c;
  }, [all]);

  const shown = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return all.filter((l) => {
      if (filter !== "all" && (l.lead_stage || "") !== filter) return false;
      if (!needle) return true;
      return [l.name, l.wa_phone, l.lead_ref, l.agent_name, l.source]
        .some((v) => (v || "").toLowerCase().includes(needle));
    });
  }, [all, filter, q]);

  const totalPages = Math.max(1, Math.ceil(shown.length / PAGE_SIZE));
  const safePage = Math.min(page, totalPages);
  const pageRows = shown.slice((safePage - 1) * PAGE_SIZE, safePage * PAGE_SIZE);

  return (
    <div className="page"><div className="maxw">
      <PageHead title="Lead Status" sub="Every lead by stage — from first touch to won or lost. Move a lead with the stage dropdown on its row.">
        <button className="btn btn-sec" onClick={load}><Icon d={IC.refresh} s={15} />Refresh</button>
      </PageHead>

      {err && <div className="err-box" style={{ marginBottom: 14 }}>{err}</div>}

      {leads && all.length > 0 && <Funnel counts={counts} total={all.length} />}

      <div className="bar">
        <div className="tabs">
          <button className={`tab ${filter === "all" ? "active" : ""}`} onClick={() => setFilter("all")}>
            All<span className="cnt">{counts.all ?? 0}</span>
          </button>
          {STAGES.map((s) => (
            <button key={s.key || "none"} className={`tab ${filter === s.key ? "active" : ""}`} onClick={() => setFilter(s.key)}>
              {s.short}<span className="cnt">{counts[s.key || "none"] ?? 0}</span>
            </button>
          ))}
        </div>
        <div className="bar-right">
          <div className="list-search">
            <Icon d={IC.search} s={15} />
            <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search name, phone, ref, agent" aria-label="Search leads" />
            {q && (
              <button onClick={() => setQ("")} aria-label="Clear search" style={{ display: "grid", placeItems: "center", color: "var(--ink-3)", flex: "none" }}>
                <Icon d={IC.x} s={14} />
              </button>
            )}
          </div>
        </div>
      </div>

      <div className="panel">
        {leads === null && !err ? <Skeleton rows={8} /> : shown.length > 0 ? (
          <table className="ttable">
            <thead>
              <tr><th>Lead</th><th>Stage</th><th>Agent</th><th>Source</th><th>Updated</th></tr>
            </thead>
            <tbody>
              {pageRows.map((l) => {
                const m = stageMeta(l.lead_stage);
                const named = l.name && l.name !== "+" + l.wa_phone;
                const name = named ? (l.name as string) : `+${formatPhone(l.wa_phone)}`;
                const when = l.stage_updated_at || l.assigned_at;
                return (
                  <tr key={l.id} className="norow">
                    <td>
                      <div className="cell-name">
                        <Avatar name={name} size={30} />
                        <div className="nm">
                          <div className="t" style={{ fontFamily: "var(--sans)", display: "flex", alignItems: "center", gap: 7 }}>
                            {name}
                            {l.lead_ref && <span className="mono" style={{ fontSize: 10.5, color: "var(--ink-2)", background: "var(--chip)", borderRadius: 5, padding: "1px 5px" }}>{l.lead_ref.toUpperCase()}</span>}
                          </div>
                          {named && <div className="p">+{formatPhone(l.wa_phone)}</div>}
                        </div>
                      </div>
                    </td>
                    <td>
                      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                        <span style={{ width: 8, height: 8, borderRadius: 8, background: m.color, flex: "none" }} />
                        <select
                          className="input"
                          value={l.lead_stage || ""}
                          disabled={busy === l.id}
                          onChange={(e) => setStage(l, e.target.value)}
                          aria-label={`Stage for ${name}`}
                          style={{ height: 32, width: "auto", minWidth: 140, fontSize: 13 }}
                        >
                          {STAGES.map((s) => <option key={s.key || "none"} value={s.key}>{s.label}</option>)}
                        </select>
                      </div>
                    </td>
                    <td className={l.agent_name ? "tcol-type" : "tcol-muted"}>{l.agent_name || "Unassigned"}</td>
                    <td className="tcol-muted">{l.source || dash}</td>
                    <td className="tcol-muted" title={when || ""}>{relTime(when)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        ) : (
          <div className="empty">
            <div className="ei"><Icon d={IC.users} s={22} /></div>
            <h4>{all.length === 0 ? "No leads yet" : "Nothing matches"}</h4>
            <div>{all.length === 0 ? "Leads appear here once someone replies, gets classified, or comes in from a Meta form." : "Try a different stage or search."}</div>
          </div>
        )}
      </div>

      {leads !== null && <Pager page={safePage} totalPages={totalPages} total={shown.length} onPage={setPage} unit="leads" />}
    </div></div>
  );
}

// The funnel strip: one proportional bar across the pipeline plus a legend.
// A stage with no leads keeps its legend entry (reading "0") but contributes no
// bar segment, so an empty pipeline looks empty instead of looking broken.
function Funnel({ counts, total }: { counts: Record<string, number>; total: number }) {
  return (
    <div className="card">
      <div style={{ display: "flex", alignItems: "baseline", gap: 8, marginBottom: 12 }}>
        <div style={{ fontSize: 22, fontWeight: 700, color: "var(--ink)" }}>{total.toLocaleString()}</div>
        <div style={{ fontSize: 13, color: "var(--ink-2)" }}>{total === 1 ? "lead" : "leads"} in the pipeline</div>
      </div>
      <div style={{ display: "flex", height: 10, borderRadius: 6, overflow: "hidden", background: "var(--chip)", gap: 2 }}>
        {STAGES.map((s) => {
          const n = counts[s.key || "none"] || 0;
          if (!n) return null;
          return <div key={s.key || "none"} title={`${s.label}: ${n}`} style={{ flex: n, background: s.color, minWidth: 3 }} />;
        })}
      </div>
      <div style={{ display: "flex", flexWrap: "wrap", gap: "8px 20px", marginTop: 12 }}>
        {STAGES.map((s) => {
          const n = counts[s.key || "none"] || 0;
          const pct = total ? Math.round((n / total) * 100) : 0;
          return (
            <div key={s.key || "none"} style={{ display: "flex", alignItems: "center", gap: 7, fontSize: 12.5, opacity: n ? 1 : 0.55 }}>
              <span style={{ width: 8, height: 8, borderRadius: 8, background: s.color, flex: "none" }} />
              <span style={{ color: "var(--ink-2)" }}>{s.label}</span>
              <span className="mono" style={{ color: "var(--ink)", fontWeight: 600 }}>{n}</span>
              <span style={{ color: "var(--ink-3)" }}>{pct}%</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}
