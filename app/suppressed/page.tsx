"use client";
import { useEffect, useState } from "react";
import { Icon, IC, PageHead, Skeleton, Avatar } from "@/lib/ui";
import { Pager } from "@/lib/Pager";
import { formatPhone } from "@/lib/format";

const PAGE_SIZE = 50;

type Conv = { id: string; wa_phone: string; name: string | null; status: string; last_at: string | null; suppressed_at: string | null };

// Date + time a contact opted out / was suppressed.
const fmtWhen = (iso: string | null) =>
  iso ? new Date(iso).toLocaleString([], { month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit" }) : "—";

const META: Record<string, { label: string; tone: string; note: string }> = {
  blocked: { label: "Opted out", tone: "var(--red)", note: "Replied STOP / unsubscribed — we never message them." },
  invalid: { label: "Invalid number", tone: "var(--ink-3)", note: "Bounced as not a WhatsApp user — campaigns skip them." },
};

const FILTERS = [
  { id: "all", label: "All" },
  { id: "blocked", label: "Opted out" },
  { id: "invalid", label: "Invalid" },
] as const;

export default function Suppressed() {
  const [rows, setRows] = useState<Conv[] | null>(null);
  const [filter, setFilter] = useState<"all" | "blocked" | "invalid">("all");
  const [busy, setBusy] = useState<string | null>(null);
  const [page, setPage] = useState(1);
  useEffect(() => { setPage(1); }, [filter]); // new filter -> back to page 1

  async function load() {
    const data = await fetch("/api/conversations?view=suppressed").then((r) => r.json()).then((d) => d.conversations).catch(() => null);
    setRows((data as Conv[]) || []);
  }
  useEffect(() => { load(); }, []); // eslint-disable-line

  async function restore(c: Conv) {
    const verb = c.status === "blocked" ? "re-enable messaging to this opted-out contact" : "restore this invalid number";
    if (!confirm(`Are you sure you want to ${verb}? They'll be eligible to receive messages again.`)) return;
    setBusy(c.id);
    await fetch("/api/conversations", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id: c.id, patch: { status: "open" } }) }).catch(() => {});
    setRows((prev) => (prev || []).filter((x) => x.id !== c.id));
    setBusy(null);
  }

  const shown = (rows || []).filter((c) => filter === "all" || c.status === filter);
  const blocked = (rows || []).filter((c) => c.status === "blocked").length;
  const invalid = (rows || []).filter((c) => c.status === "invalid").length;
  const counts: Record<string, number> = { all: (rows || []).length, blocked, invalid };

  const totalPages = Math.max(1, Math.ceil(shown.length / PAGE_SIZE));
  const safePage = Math.min(page, totalPages);
  const pageRows = shown.slice((safePage - 1) * PAGE_SIZE, safePage * PAGE_SIZE);

  return (
    <div className="page"><div className="maxw">
      <PageHead title="Suppressed contacts" sub="Numbers we won't message: people who opted out, and dead WhatsApp numbers that bounced. Restore one if needed.">
        <button className="btn btn-sec" onClick={() => { setRows(null); load(); }}><Icon d={IC.refresh} s={15} />Refresh</button>
      </PageHead>

      <div className="bar">
        <div className="tabs">
          {FILTERS.map((f) => (
            <button key={f.id} className={`tab ${filter === f.id ? "active" : ""}`} onClick={() => setFilter(f.id)}>
              {f.label}<span className="cnt">{counts[f.id]}</span>
            </button>
          ))}
        </div>
      </div>

      <div className="panel">
        {rows === null ? <Skeleton rows={6} /> : shown.length > 0 ? (
          <table className="ttable">
            <thead><tr><th>Contact</th><th>Reason</th><th>Status</th><th>Suppressed</th><th></th></tr></thead>
            <tbody>
              {pageRows.map((c) => {
                const m = META[c.status] || { label: c.status, tone: "var(--ink-3)", note: "" };
                const name = c.name || formatPhone(c.wa_phone);
                return (
                  <tr key={c.id} className="norow">
                    <td>
                      <div className="cell-name">
                        <Avatar name={name} size={30} />
                        <div className="nm">
                          <div className="t" style={{ fontFamily: "var(--sans)" }}>{name}</div>
                          {c.name && <div className="p">{formatPhone(c.wa_phone)}</div>}
                        </div>
                      </div>
                    </td>
                    <td className="tcol-muted">{m.note}</td>
                    <td>
                      <span className="badge" style={{ color: "#fff", background: m.tone, borderColor: m.tone }}>
                        <span className="bd" style={{ background: "rgba(255,255,255,.9)" }} />{m.label}
                      </span>
                    </td>
                    <td className="tcol-muted" title={c.suppressed_at || ""}>{fmtWhen(c.suppressed_at)}</td>
                    <td style={{ textAlign: "right" }}>
                      <button className="btn btn-sec btn-sm" onClick={() => restore(c)} disabled={busy === c.id}>
                        {busy === c.id ? "…" : "Restore"}
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        ) : (
          <div className="empty">
            <div className="ei"><Icon d={IC.users} s={22} /></div>
            <h4>Nothing here</h4>
            <div>No suppressed contacts in this view.</div>
          </div>
        )}
      </div>
      {rows !== null && <Pager page={safePage} totalPages={totalPages} total={shown.length} onPage={setPage} unit="contacts" />}
    </div></div>
  );
}
