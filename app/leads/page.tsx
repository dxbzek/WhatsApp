"use client";
import { useEffect, useState } from "react";
import { Icon, IC, PageHead } from "@/lib/ui";
import { formatPhone } from "@/lib/format";

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

// Stage sections in the order the board reads. "null" = not contacted yet.
const SECTIONS: { key: string; label: string; color: string }[] = [
  { key: "null", label: "Not Contacted Yet", color: "var(--ink-3)" },
  { key: "contacted", label: "Contacted", color: "var(--blue)" },
  { key: "viewing", label: "Viewing", color: "var(--amber-dot)" },
  { key: "won", label: "Won", color: "var(--green-dot)" },
  { key: "lost", label: "Lost", color: "var(--red)" },
];

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
  return new Date(iso).toLocaleString([], { day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" });
}

const ellipsis: React.CSSProperties = { whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", minWidth: 0 };

export default function Leads() {
  const [leads, setLeads] = useState<Lead[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  // Sections start collapsed except the active-work stages. "Not Contacted Yet"
  // is the big backlog, so it stays closed by default to keep the page short.
  const [open, setOpen] = useState<Record<string, boolean>>({
    null: false, contacted: true, viewing: true, won: true, lost: false,
  });
  const toggle = (k: string) => setOpen((o) => ({ ...o, [k]: !o[k] }));

  const load = () => {
    setLeads(null); setErr(null);
    fetch("/api/conversations?view=by-status")
      .then((r) => r.json())
      .then((d) => { if (d?.leads) setLeads(d.leads); else setErr(d?.error || "Could not load leads."); })
      .catch(() => setErr("Could not load leads."));
  };
  useEffect(load, []);

  // Bucket leads by stage. A null/unknown stage falls into "Not Contacted Yet".
  const byStage: Record<string, Lead[]> = { null: [], contacted: [], viewing: [], won: [], lost: [] };
  for (const l of leads || []) {
    const key = l.lead_stage && byStage[l.lead_stage] ? l.lead_stage : "null";
    byStage[key].push(l);
  }
  const total = (leads || []).length;

  return (
    <div className="page"><div className="maxw">
      <PageHead title="Lead Status" sub="Every lead by stage — from first touch to won or lost. Agents move stages by replying to alerts.">
        <button className="btn btn-sec" onClick={load}><Icon d={IC.refresh} s={15} />Refresh</button>
      </PageHead>

      {err && <div className="err-box" style={{ marginBottom: 14 }}>{err}</div>}

      {leads === null && !err && (
        <div className="card"><div className="perf"><div className="perf-row"><div className="perf-name" style={{ color: "var(--ink-3)" }}>Loading leads…</div></div></div></div>
      )}

      {leads && total === 0 && !err && (
        <div className="card"><div className="perf"><div className="perf-row"><div className="perf-name" style={{ color: "var(--ink-3)" }}>No leads yet.</div></div></div></div>
      )}

      {leads && total > 0 && (
        <div style={{ display: "flex", flexDirection: "column", gap: 18 }}>
          {SECTIONS.map((s) => {
            const rows = byStage[s.key];
            const isOpen = open[s.key] && rows.length > 0;
            return (
              <div className="card" key={s.key}>
                <div
                  className="card-head"
                  onClick={() => rows.length > 0 && toggle(s.key)}
                  style={{ cursor: rows.length > 0 ? "pointer" : "default", userSelect: "none" }}
                >
                  <div className="card-t" style={{ display: "flex", alignItems: "center", gap: 8 }}>
                    <span style={{ width: 9, height: 9, borderRadius: 9, background: s.color, display: "inline-block" }} />
                    {s.label}
                  </div>
                  <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                    <div className="card-meta">{rows.length} {rows.length === 1 ? "lead" : "leads"}</div>
                    {rows.length > 0 && (
                      <span style={{ display: "inline-flex", color: "var(--ink-3)", transform: isOpen ? "none" : "rotate(-90deg)", transition: "transform .15s" }}>
                        <Icon d={IC.chevron} s={16} w={2} />
                      </span>
                    )}
                  </div>
                </div>
                {isOpen && (
                  <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(min(100%, 270px), 1fr))", gap: 12 }}>
                    {rows.map((l) => (
                      <LeadCard key={l.id} lead={l} color={s.color} />
                    ))}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div></div>
  );
}

function LeadCard({ lead, color }: { lead: Lead; color: string }) {
  const name = lead.name && lead.name !== ("+" + lead.wa_phone) ? lead.name : `+${formatPhone(lead.wa_phone)}`;
  // The most relevant timestamp for the stage: when it last moved, else assigned.
  const when = lead.stage_updated_at || lead.assigned_at;
  return (
    <div style={{
      border: "1px solid var(--border)", borderLeft: `3px solid ${color}`, borderRadius: 10,
      padding: "12px 14px", background: "var(--surface)", display: "flex", flexDirection: "column", gap: 8, minWidth: 0,
    }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, minWidth: 0 }}>
        <div style={{ ...ellipsis, fontWeight: 650, color: "var(--ink-1)", flex: 1 }} title={name}>{name}</div>
        {lead.lead_ref && (
          <span className="mono" style={{ fontSize: 11, color: "var(--ink-2)", background: "var(--chip)", borderRadius: 6, padding: "2px 6px", flex: "none" }}>{lead.lead_ref.toUpperCase()}</span>
        )}
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 4, fontSize: 12.5, color: "var(--ink-2)" }}>
        <div style={{ display: "flex", gap: 6, alignItems: "center", minWidth: 0 }}>
          <Icon d={IC.phone} s={13} /><span style={{ ...ellipsis, color: "var(--ink-1)" }}>+{formatPhone(lead.wa_phone)}</span>
        </div>
        <div style={{ display: "flex", gap: 6, alignItems: "center", minWidth: 0 }}>
          <span style={{ color: "var(--ink-3)", flex: "none" }}>Agent</span><span style={{ ...ellipsis, color: "var(--ink-1)" }}>{lead.agent_name || "Unassigned"}</span>
        </div>
        <div style={{ display: "flex", gap: 6, alignItems: "center", minWidth: 0 }}>
          <span style={{ color: "var(--ink-3)", flex: "none" }}>Source</span><span style={{ ...ellipsis, color: "var(--ink-1)" }}>{lead.source || dash}</span>
        </div>
        <div style={{ display: "flex", gap: 6, alignItems: "center", minWidth: 0 }}>
          <span style={{ color: "var(--ink-3)", flex: "none" }}>Updated</span><span style={{ ...ellipsis, color: "var(--ink-1)" }}>{relTime(when)}</span>
        </div>
      </div>
    </div>
  );
}
