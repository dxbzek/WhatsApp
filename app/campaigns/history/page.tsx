"use client";
import { useEffect, useState } from "react";
import Link from "next/link";
import { Icon, IC, PageHead, Skeleton, Toast } from "@/lib/ui";
import { errorCause } from "@/lib/twilioErrors";

type Campaign = {
  id: string; name: string; template_name: string | null; sender: string | null;
  mode: string; total: number; sent: number; scheduled: number; failed: number; skipped: number;
  status: string; finish_at: string | null; created_at: string;
};
type Recipient = { status: string | null; error_code?: string | null; created_at: string; scheduled_at?: string | null; conversation: { wa_phone: string; name: string | null } | null };

type Funnel = { sent: number; delivered: number; read: number; failed: number; scheduled: number; deliveryRate: number; readRate: number; reasons?: Record<string, number> };

export default function CampaignHistory() {
  const [rows, setRows] = useState<Campaign[] | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);
  const [funnels, setFunnels] = useState<Record<string, Funnel>>({});
  const [updatedAt, setUpdatedAt] = useState<number | null>(null);
  const [, setTick] = useState(0); // 1s heartbeat so countdowns/progress bars move live
  const [toast, setToast] = useState<{ kind: "good" | "bad"; text: string } | null>(null);

  async function load() {
    const data = await fetch("/api/campaigns?view=log&limit=100").then((r) => r.json()).then((d) => d.campaigns).catch(() => null);
    setRows((data as Campaign[]) || []);
  }
  async function refreshAll() {
    // Reconcile active campaigns' counts from delivery receipts, then reload + funnel.
    await fetch("/api/campaign/refresh", { method: "POST" }).catch(() => {});
    await load();
    fetch("/api/campaign/funnel").then((r) => r.json()).then((d) => setFunnels(d.funnel || {})).catch(() => {});
    setUpdatedAt(Date.now());
  }
  useEffect(() => { refreshAll(); }, []); // eslint-disable-line

  // While any campaign is still sending/scheduled, poll every 20s so the tracker
  // moves on its own (scheduled -> sent -> delivered) without a manual reload.
  const hasActive = (rows || []).some((c) => c.status === "sending" || c.status === "scheduled");
  useEffect(() => {
    if (!hasActive) return;
    const poll = setInterval(refreshAll, 20000);
    const beat = setInterval(() => setTick((t) => t + 1), 1000);
    return () => { clearInterval(poll); clearInterval(beat); };
  }, [hasActive]); // eslint-disable-line

  async function cancel(c: Campaign) {
    if (!confirm(`Cancel the ${c.scheduled} scheduled message(s) still pending in "${c.name}"? Already-sent messages can't be recalled.`)) return;
    const res = await fetch("/api/campaign/cancel", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id: c.id }),
    });
    const d = await res.json();
    if (!res.ok) { setToast({ kind: "bad", text: "Cancel failed: " + (d.error || "") }); return; }
    setToast({ kind: "good", text: `Canceled ${d.canceled} pending message(s).` + (d.alreadyGone ? ` ${d.alreadyGone} had already sent.` : "") });
    load();
  }

  return (
    <div className="page"><div className="maxw">
      <PageHead title="Campaign log" sub="Every bulk send, with delivery results. Scheduled campaigns can be canceled before they go out.">
        <Link className="btn btn-sec" href="/templates/performance"><Icon d={IC.insights} s={15} />Template performance</Link>
        <Link className="btn btn-primary" href="/campaigns"><Icon d={IC.plus} s={16} />New campaign</Link>
      </PageHead>

      {hasActive && (
        <div style={{ display: "flex", alignItems: "center", gap: 7, fontSize: 12, color: "var(--green-ink)", marginBottom: 16 }}>
          <span style={{ width: 8, height: 8, borderRadius: "50%", background: "var(--green-dot)", display: "inline-block" }} />
          Live · auto-updating every 20s{updatedAt ? ` · last ${new Date(updatedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })}` : ""}
        </div>
      )}

      {rows === null ? (
        <div className="panel" style={{ borderTop: "1px solid var(--border)", borderRadius: "var(--r-lg)" }}><Skeleton rows={4} /></div>
      ) : rows.length === 0 ? (
        <div className="card" style={{ marginBottom: 0 }}>
          <div className="empty">
            <div className="ei"><Icon d={IC.camp} s={22} /></div>
            <h4>No campaigns yet</h4>
            <div>Bulk sends show up here with live delivery results. <Link href="/campaigns" style={{ color: "var(--blue)", fontWeight: 600 }}>Send your first →</Link></div>
          </div>
        </div>
      ) : (
        (rows || []).map((c) => {
          const canCancel = c.status === "scheduled" && c.scheduled > 0;
          const ds = displayStatus(c, funnels[c.id]);
          return (
            <div key={c.id} className="card" style={{ marginBottom: 12 }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 12, flexWrap: "wrap" }}>
                <div className="camp-name" style={{ minWidth: 0 }}>
                  <div className="cn-t" style={{ fontSize: 15 }}>{c.name}</div>
                  <div className="cn-s">
                    {new Date(c.created_at).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })}
                    {c.sender && <> · from +{c.sender.replace("whatsapp:+", "").replace("+", "")}</>}
                    {c.mode !== "now" && <> · {c.mode}</>}
                  </div>
                </div>
                <span className="badge" style={{ color: ds.color, borderColor: ds.color, background: "transparent" }}>
                  <span className="bd" style={{ background: ds.color }} />{ds.label}
                </span>
              </div>

              <Coverage c={c} f={funnels[c.id]} />
              <FailureReasons f={funnels[c.id]} />
              <DripTracker c={c} f={funnels[c.id]} />

              <div style={{ display: "flex", gap: 8, marginTop: 14 }}>
                <button className="btn btn-sec btn-sm" onClick={() => setOpenId(openId === c.id ? null : c.id)}>
                  {openId === c.id ? "Hide recipients" : "View recipients"}
                </button>
                {canCancel && <button className="btn btn-ghost danger btn-sm" onClick={() => cancel(c)}>Cancel scheduled</button>}
              </div>

              {openId === c.id && <Recipients campaignId={c.id} />}
            </div>
          );
        })
      )}
      {toast && <Toast kind={toast.kind} onDone={() => setToast(null)}>{toast.text}</Toast>}
    </div></div>
  );
}

// Per-recipient delivery report for one campaign.
function Recipients({ campaignId }: { campaignId: string }) {
  const [list, setList] = useState<Recipient[] | null>(null);
  useEffect(() => {
    fetch(`/api/messages?view=campaign&campaign=${encodeURIComponent(campaignId)}`)
      .then((r) => r.json())
      .then((d) => setList((d.messages as any as Recipient[]) || []))
      .catch(() => setList([]));
  }, [campaignId]); // eslint-disable-line

  if (list === null) return <div style={{ fontSize: 13, color: "var(--ink-3)", marginTop: 12 }}>Loading recipients…</div>;
  if (list.length === 0) return <div style={{ fontSize: 13, color: "var(--ink-3)", marginTop: 12 }}>No recipient records.</div>;

  return (
    <div style={{ marginTop: 14, borderTop: "1px solid var(--border-soft)", paddingTop: 6, maxHeight: 320, overflowY: "auto" }}>
      {list.map((r, i) => {
        const isSched = r.status === "scheduled";
        const isFail = r.status === "failed" || r.status === "undelivered";
        const when = isSched && r.scheduled_at ? r.scheduled_at : r.created_at;
        const timeLabel = when ? `${isSched ? "scheduled for" : "sent"} ${new Date(when).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })}` : "";
        const cause = isFail ? (r.error_code ? `${errorCause(r.error_code)} · ${r.error_code}` : "Failed — no error code reported") : "";
        return (
          <div key={i} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "8px 0", borderBottom: "1px solid var(--border-soft)", fontSize: 13 }}>
            <div style={{ minWidth: 0, overflow: "hidden" }}>
              <div style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", color: "var(--ink)" }}>
                {r.conversation?.name || (r.conversation?.wa_phone ? "+" + r.conversation.wa_phone : "-")}
              </div>
              {cause
                ? <div style={{ fontSize: 11.5, color: "var(--red-ink)", marginTop: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{cause}</div>
                : timeLabel && <div style={{ fontSize: 11.5, color: isSched ? "var(--blue)" : "var(--ink-3)", marginTop: 1 }}>{timeLabel}</div>}
            </div>
            <RecipientStatus status={r.status} />
          </div>
        );
      })}
    </div>
  );
}

// Per-recipient status as an outline badge, tinted by the delivery state.
function RecipientStatus({ status }: { status: string | null }) {
  const map: Record<string, string> = {
    read: "var(--blue)", delivered: "var(--green-ink)", sent: "var(--green-ink)", queued: "var(--amber-ink)", accepted: "var(--amber-ink)",
    scheduled: "var(--blue)", failed: "var(--red-ink)", undelivered: "var(--red-ink)", canceled: "var(--ink-3)",
  };
  const c = map[status || ""] || "var(--ink-3)";
  return (
    <span className="badge" style={{ color: c, borderColor: c, background: "transparent", flexShrink: 0, marginLeft: 10 }}>
      {status || "-"}
    </span>
  );
}

// Honest, at-a-glance coverage from real WhatsApp receipts (NOT the rollup
// counters, which drift). Of everyone we meant to message: how many reached a
// handset, how many are still in flight, how many failed, how many never sent.
function reach(c: Campaign, f: Funnel | undefined) {
  const total = c.total || 0;
  const delivered = f?.delivered || 0;        // reached a handset (includes read)
  const read = f?.read || 0;
  const failed = f?.failed || 0;
  const acceptedByWa = f?.sent || 0;          // handed to WhatsApp (excl. scheduled), incl. delivered/read
  // Scheduled = queued in our DB, not yet sent. Live from the funnel (the old
  // c.scheduled rollup drifts: it stays at the enqueue total and never drops as
  // the cron sends, which made the header disagree with the per-row statuses).
  const scheduled = f?.scheduled || 0;
  const pending = Math.max(0, acceptedByWa - delivered); // sent, awaiting a delivery receipt
  const notSent = Math.max(0, total - delivered - pending - scheduled - failed);
  // Coverage that matches the "X of Y reached" sentence: delivered / total.
  // (deliveryRate is a different ratio — delivered / accepted — and reads as a
  // contradiction next to "of Y", so it isn't shown there.)
  const reachPct = total ? Math.round((delivered / total) * 100) : 0;
  return { total, delivered, read, failed, scheduled, pending, notSent, reachPct, deliveryRate: f?.deliveryRate || 0 };
}
// Status the user can trust: an old "completed" run that never reached everyone
// is shown as "Incomplete", so the label matches reality.
function displayStatus(c: Campaign, f: Funnel | undefined): { label: string; color: string } {
  if (c.status === "scheduled") return { label: "Scheduled", color: "var(--blue)" };
  if (c.status === "sending") return { label: "Sending", color: "var(--amber-ink)" };
  if (c.status === "canceled") return { label: "Canceled", color: "var(--ink-3)" };
  if (c.status === "incomplete" || (c.status === "completed" && reach(c, f).notSent > 0))
    return { label: "Incomplete", color: "var(--amber-ink)" };
  return { label: "Completed", color: "var(--green-ink)" };
}
function Coverage({ c, f }: { c: Campaign; f: Funnel | undefined }) {
  const r = reach(c, f);
  const w = (n: number) => `${(n / Math.max(1, r.total)) * 100}%`;
  const Legend = ({ n, label, color }: { n: number; label: string; color: string }) =>
    n > 0 ? (
      <span style={{ display: "inline-flex", alignItems: "center", gap: 5 }}>
        <span style={{ width: 8, height: 8, borderRadius: 2, background: color }} />
        <b style={{ color }}>{n.toLocaleString()}</b> {label}
      </span>
    ) : null;
  return (
    <div style={{ marginTop: 14 }}>
      <div style={{ fontSize: 13, marginBottom: 8 }}>
        <b style={{ fontSize: 19, color: "var(--ink)" }}>{r.delivered.toLocaleString()}</b>
        <span style={{ color: "var(--ink-3)" }}> of {r.total.toLocaleString()} reached</span>
        {r.delivered > 0 && <span style={{ color: "var(--ink-3)" }}> · {r.reachPct}%</span>}
      </div>
      <div style={{ display: "flex", height: 9, borderRadius: 20, overflow: "hidden", background: "var(--chip)" }}>
        <div style={{ width: w(r.delivered), background: "var(--green-dot)" }} />
        <div style={{ width: w(r.scheduled), background: "var(--blue)" }} />
        <div style={{ width: w(r.pending), background: "var(--amber-dot)" }} />
        <div style={{ width: w(r.failed), background: "var(--red)" }} />
      </div>
      <div style={{ display: "flex", gap: 14, marginTop: 8, fontSize: 12, color: "var(--ink-2)", flexWrap: "wrap" }}>
        <Legend n={r.delivered} label="delivered" color="var(--green-dot)" />
        <Legend n={r.read} label="read" color="var(--green-ink)" />
        <Legend n={r.scheduled} label="scheduled" color="var(--blue)" />
        <Legend n={r.pending} label="pending" color="var(--amber-dot)" />
        <Legend n={r.failed} label="failed" color="var(--red)" />
        <Legend n={r.notSent} label="not sent" color="var(--border-2)" />
      </div>
    </div>
  );
}
// Why did messages fail? Group the campaign's failures by Twilio error code and
// show them in plain English, worst first — so "40 failed" becomes something you
// can actually act on (dead numbers vs. opt-in vs. Meta marketing cap).
function FailureReasons({ f }: { f: Funnel | undefined }) {
  const reasons = f?.reasons;
  if (!reasons) return null;
  const items = Object.entries(reasons)
    .map(([code, n]) => ({ code, n, cause: code === "unknown" ? "No error code reported by Twilio" : errorCause(code) }))
    .sort((a, b) => b.n - a.n);
  if (items.length === 0) return null;
  return (
    <div style={{ marginTop: 14, padding: "11px 13px", borderRadius: "var(--r)", background: "var(--red-bg)", border: "1px solid var(--red-border)" }}>
      <div style={{ fontSize: 11.5, fontWeight: 600, letterSpacing: ".04em", textTransform: "uppercase", color: "var(--red-ink)", marginBottom: 8 }}>
        Why {items.reduce((s, i) => s + i.n, 0).toLocaleString()} failed
      </div>
      <div style={{ display: "grid", gap: 7 }}>
        {items.map((i) => (
          <div key={i.code} style={{ display: "flex", alignItems: "baseline", gap: 10, fontSize: 12.5, lineHeight: 1.4 }}>
            <b style={{ color: "var(--red-ink)", minWidth: 34, flexShrink: 0 }}>{i.n.toLocaleString()}</b>
            <span style={{ color: "var(--ink-2)", minWidth: 0 }}>
              {i.cause}
              {i.code !== "unknown" && <span style={{ color: "var(--ink-3)", marginLeft: 6 }}>· {i.code}</span>}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}
// Live progress for a time-spread (drip/scheduled) send still in flight: a bar
// over the send window plus a countdown, so you can watch it finish instead of
// blindly waiting. Re-renders every second via the page's heartbeat tick.
function DripTracker({ c, f }: { c: Campaign; f: Funnel | undefined }) {
  if (!(c.status === "scheduled" || c.status === "sending") || !c.finish_at) return null;
  const start = new Date(c.created_at).getTime();
  const end = new Date(c.finish_at).getTime();
  const now = Date.now();
  const span = Math.max(1, end - start);
  const pct = Math.max(0, Math.min(100, ((now - start) / span) * 100));
  const remainMin = Math.max(0, Math.round((end - now) / 60000));
  const done = now >= end;
  const remainLabel = remainMin >= 60 ? `~${Math.floor(remainMin / 60)}h ${remainMin % 60}m left` : `~${remainMin} min left`;
  // Use the real in-flight count from receipts (scheduled + queued, no receipt
  // yet) so this matches the legend above, not the stale c.scheduled rollup.
  const r = reach(c, f);
  const stillScheduled = r.scheduled + r.pending;
  return (
    <div style={{ marginTop: 14 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", fontSize: 12, color: "var(--blue)", marginBottom: 6 }}>
        <span>{done ? "Finishing up…" : remainLabel}{stillScheduled > 0 ? ` · ${stillScheduled.toLocaleString()} still scheduled` : ""}</span>
        <span>finishes {new Date(end).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</span>
      </div>
      <div className="prog-bar" style={{ width: "100%", background: "var(--blue-tint)" }}>
        <div className="prog-fill" style={{ width: `${pct}%`, background: "var(--blue)", transition: "width .6s linear" }} />
      </div>
    </div>
  );
}
