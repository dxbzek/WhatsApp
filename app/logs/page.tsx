"use client";
import { useEffect, useMemo, useState } from "react";
import { Icon, IC, PageHead, Skeleton } from "@/lib/ui";
import { Pager } from "@/lib/Pager";
import { errorCause } from "@/lib/twilioErrors";
import { useLive } from "@/lib/useLive";

type Row = {
  id: string;
  direction: "in" | "out" | string;
  status: string | null;
  error_code: string | null;
  body: string | null;
  content_sid: string | null;
  created_at: string;
  conversation: { wa_phone: string; name: string | null } | null;
};

type FilterKey = "all" | "failed" | "delivered" | "replies";
const FILTERS: { id: FilterKey; label: string }[] = [
  { id: "all", label: "All" },
  { id: "failed", label: "Failed" },
  { id: "delivered", label: "Delivered" },
  { id: "replies", label: "Replies" },
];

const PAGE_SIZE = 50;

export default function Logs() {
  const [rows, setRows] = useState<Row[] | null>(null);
  const [tpl, setTpl] = useState<Record<string, string>>({}); // content_sid -> template name
  const [filter, setFilter] = useState<FilterKey>("all");
  const [q, setQ] = useState("");
  const [updatedAt, setUpdatedAt] = useState<number | null>(null);
  const [page, setPage] = useState(1);

  // Any filter/search change jumps back to the first page so you're never
  // stranded on an empty page that no longer exists for the new result set.
  useEffect(() => { setPage(1); }, [filter, q]);

  async function load() {
    const data = await fetch("/api/messages?view=log&limit=400").then((r) => r.json()).then((d) => d.messages).catch(() => null);
    setRows((data as any as Row[]) || []);
    setUpdatedAt(Date.now());
  }
  useEffect(() => {
    fetch("/api/templates").then((r) => r.json()).then((d) => {
      const map: Record<string, string> = {};
      for (const t of d.templates || []) map[t.sid] = t.name;
      setTpl(map);
    }).catch(() => {});
    load();
    // Backstop only. The SSE feed below drives the log in real time; this catches
    // the gap if the stream is down or a frame is missed.
    const poll = setInterval(load, 60000);
    return () => clearInterval(poll);
  }, []); // eslint-disable-line

  // Push updates: every insert/update on messages refetches, so a status flips
  // here the moment Twilio's callback lands rather than up to 20s later.
  const liveFeed = useLive(["messages"], load);

  const failedCount = (rows || []).filter(isFail).length;

  const shown = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return (rows || []).filter((r) => {
      if (filter === "failed" && !isFail(r)) return false;
      if (filter === "replies" && r.direction !== "in") return false;
      if (filter === "delivered" && !(r.status === "delivered" || r.status === "read")) return false;
      if (needle) {
        const hay = `${r.conversation?.name || ""} ${r.conversation?.wa_phone || ""} ${tpl[r.content_sid || ""] || ""} ${r.body || ""}`.toLowerCase();
        if (!hay.includes(needle)) return false;
      }
      return true;
    });
  }, [rows, filter, q, tpl]);

  const totalPages = Math.max(1, Math.ceil(shown.length / PAGE_SIZE));
  const safePage = Math.min(page, totalPages);
  const pageRows = shown.slice((safePage - 1) * PAGE_SIZE, safePage * PAGE_SIZE);

  return (
    <div className="page"><div className="maxw">
      <PageHead title="Logs" sub="Live activity log — every message in and out, with delivery status and the reason for any failure. Newest first.">
        <button className="btn btn-sec" onClick={load}><Icon d={IC.refresh} s={15} />Refresh</button>
      </PageHead>

      <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 14, flexWrap: "wrap" }}>
        <div style={{ display: "flex", gap: 6 }}>
          {FILTERS.map((f) => (
            <button
              key={f.id}
              onClick={() => setFilter(f.id)}
              className={`btn btn-sm ${filter === f.id ? "btn-primary" : "btn-sec"}`}
            >
              {f.label}{f.id === "failed" && failedCount > 0 ? ` · ${failedCount}` : ""}
            </button>
          ))}
        </div>
        <div style={{ flex: 1, minWidth: 200, maxWidth: 320, display: "flex", alignItems: "center", gap: 8, padding: "7px 11px", border: "1px solid var(--border)", borderRadius: "var(--r)", background: "var(--surface)", color: "var(--ink-3)" }}>
          <Icon d={IC.search} s={15} />
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search name, number, template…"
            style={{ flex: 1, border: "none", outline: "none", background: "transparent", fontSize: 13.5, color: "var(--ink)" }}
          />
        </div>
        {updatedAt && (
          <span style={{ fontSize: 11.5, color: "var(--ink-3)", marginLeft: "auto", display: "flex", alignItems: "center", gap: 6 }}>
            <span
              title={liveFeed ? "Live — updates pushed the moment they happen" : "Reconnecting — falling back to a refresh every 60s"}
              style={{ width: 7, height: 7, borderRadius: "50%", background: liveFeed ? "var(--green)" : "var(--ink-3)" }}
            />
            {liveFeed ? "live" : "reconnecting"} · updated {new Date(updatedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })}
          </span>
        )}
      </div>

      {rows === null ? (
        <div className="panel" style={{ borderTop: "1px solid var(--border)", borderRadius: "var(--r-lg)" }}><Skeleton rows={8} /></div>
      ) : shown.length === 0 ? (
        <div className="empty">
          <div className="ei"><Icon d={IC.clock} s={22} /></div>
          <h4>Nothing to show</h4>
          <div>{rows.length === 0 ? "No messages logged yet." : "No log entries match this filter."}</div>
        </div>
      ) : (
        <>
          <div className="panel" style={{ borderTop: "1px solid var(--border)", borderRadius: "var(--r-lg)" }}>
            <table className="ttable">
              <thead>
                <tr>
                  <th style={{ width: 132 }}>Time</th>
                  <th style={{ width: 54 }}>Dir</th>
                  <th>Contact</th>
                  <th>Detail</th>
                  <th style={{ width: 200 }}>Status</th>
                </tr>
              </thead>
              <tbody>
                {pageRows.map((r) => <LogRow key={r.id} r={r} tplName={tpl[r.content_sid || ""]} />)}
              </tbody>
            </table>
          </div>
          <Pager page={safePage} totalPages={totalPages} total={shown.length} onPage={setPage} />
        </>
      )}
    </div></div>
  );
}

function LogRow({ r, tplName }: { r: Row; tplName?: string }) {
  const out = r.direction === "out";
  const fail = isFail(r);
  const contact = r.conversation?.name || (r.conversation?.wa_phone ? "+" + r.conversation.wa_phone : "—");
  const detail = out
    ? (tplName ? tplName : r.content_sid ? "Template " + r.content_sid.slice(0, 10) + "…" : (r.body || "Message"))
    : (r.body || "Reply");
  return (
    <tr className="norow">
      <td style={{ whiteSpace: "nowrap", color: "var(--ink-3)", fontSize: 12.5 }}>
        {new Date(r.created_at).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })}
      </td>
      <td>
        <span className="badge" style={{ color: out ? "var(--blue)" : "var(--green-ink)", borderColor: out ? "var(--blue)" : "var(--green-border)", background: "transparent" }}>
          {out ? "OUT" : "IN"}
        </span>
      </td>
      <td style={{ maxWidth: 200, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{contact}</td>
      <td style={{ maxWidth: 320 }}>
        <span style={{ display: "block", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", color: "var(--ink-2)", fontFamily: out && (tplName || r.content_sid) ? "var(--mono)" : undefined, fontSize: out && (tplName || r.content_sid) ? 12.5 : 13.5 }}>
          {detail}
        </span>
      </td>
      <td>
        <StatusCell status={r.status} fail={fail} errorCode={r.error_code} />
      </td>
    </tr>
  );
}

function StatusCell({ status, fail, errorCode }: { status: string | null; fail: boolean; errorCode: string | null }) {
  const color = statusColor(status);
  return (
    <div style={{ minWidth: 0 }}>
      <span className="badge" style={{ color, borderColor: color, background: "transparent" }}>
        <span className="bd" style={{ background: color }} />{status || "—"}
      </span>
      {fail && (
        <div style={{ fontSize: 11.5, color: "var(--red-ink)", marginTop: 3, lineHeight: 1.35 }}>
          {errorCode ? `${errorCause(errorCode)} · ${errorCode}` : "No error code reported"}
        </div>
      )}
    </div>
  );
}

const isFail = (r: Row) => r.status === "failed" || r.status === "undelivered";
function statusColor(s: string | null): string {
  if (s === "read") return "var(--blue)";
  if (s === "delivered" || s === "sent") return "var(--green-ink)";
  if (s === "queued" || s === "accepted") return "var(--amber-ink)";
  if (s === "failed" || s === "undelivered") return "var(--red-ink)";
  return "var(--ink-3)"; // received (inbound) and anything else
}
