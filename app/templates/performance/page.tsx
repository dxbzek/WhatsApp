"use client";
import { useEffect, useMemo, useState, type ReactNode } from "react";
import Link from "next/link";
import { Icon, IC, PageHead, Skeleton } from "@/lib/ui";
import { TWILIO_ERRORS } from "@/lib/twilioErrors";

// Sort options for the template list. Each picks a value off the stats blob.
const SORTS: { key: string; label: string; val: (s: any) => number }[] = [
  { key: "sent", label: "Most sent", val: (s) => s.sent || 0 },
  { key: "reply", label: "Best reply rate", val: (s) => s.replyRate || 0 },
  { key: "lead", label: "Best lead rate", val: (s) => s.leadRate || 0 },
  { key: "leads", label: "Most leads", val: (s) => s.leads || 0 },
  { key: "delivery", label: "Best delivery", val: (s) => s.deliveryRate || 0 },
];

export default function TemplatePerformance() {
  const [tpls, setTpls] = useState<any[]>([]);
  const [stats, setStats] = useState<Record<string, any> | null>(null);
  const [sort, setSort] = useState("sent");
  const [q, setQ] = useState("");
  const [open, setOpen] = useState<Set<string>>(new Set());

  useEffect(() => {
    fetch("/api/templates").then((r) => r.json()).then((d) => setTpls(d.templates || []));
    fetch("/api/templates/performance").then((r) => r.json()).then((d) => setStats(d.stats || {}));
  }, []);

  // Templates that have actually been sent, then filtered + sorted by the chosen key.
  const rows = useMemo(() => {
    const sorter = SORTS.find((x) => x.key === sort) || SORTS[0];
    const needle = q.trim().toLowerCase();
    return tpls
      .map((t) => ({ ...t, s: stats?.[t.sid] }))
      .filter((t) => t.s && t.s.sent > 0)
      .filter((t) => !needle || (t.name || "").toLowerCase().includes(needle))
      .sort((a, b) => sorter.val(b.s) - sorter.val(a.s));
  }, [tpls, stats, sort, q]);

  // Headline rollups across all sent templates (pure derived view, no extra fetch).
  // Every RATE is of delivered, never of sent — a message that failed/undelivered
  // never reached anyone, so counting it in the denominator fakes the KPI down.
  const totalSent = rows.reduce((n, t) => n + (t.s.sent || 0), 0);
  const totalReplied = rows.reduce((n, t) => n + (t.s.replied || 0), 0);
  const totalDelivered = rows.reduce((n, t) => n + (t.s.delivered || 0), 0);
  const avgReply = totalDelivered ? Math.round((totalReplied / totalDelivered) * 100) : 0;
  const totalLeads = rows.reduce((n, t) => n + (t.s.leads || 0), 0);
  const avgLeadRate = totalDelivered ? Math.round((totalLeads / totalDelivered) * 100) : 0;

  const allOpen = rows.length > 0 && rows.every((t) => open.has(t.sid));
  const toggle = (sid: string) =>
    setOpen((p) => { const n = new Set(p); n.has(sid) ? n.delete(sid) : n.add(sid); return n; });
  const toggleAll = () => setOpen(allOpen ? new Set() : new Set(rows.map((t) => t.sid)));

  return (
    <div className="page"><div className="maxw">
      <PageHead
        title="Template performance"
        sub="How each template performs over the last 90 days. Tap a row to see the full funnel and where recipients drop off."
      >
        <Link href="/templates" className="btn btn-sec"><Icon d={IC.tmpl} s={15} />Templates</Link>
      </PageHead>

      {stats === null && <Skeleton rows={6} />}

      {stats && rows.length === 0 && q.trim() === "" && (
        <div className="empty">
          <div className="ei"><Icon d={IC.trend} s={22} /></div>
          <h4>No template sends yet</h4>
          <div>Run a <Link href="/campaigns" style={{ color: "var(--blue)", fontWeight: 600 }}>campaign</Link> or send a template from the inbox.</div>
        </div>
      )}

      {stats && rows.length > 0 && (
        <>
          <div className="kpis k5">
            <div className="kpi"><div className="kl">Total sent</div><div className="kv">{totalSent.toLocaleString()}</div><div className="ks">last 90 days</div></div>
            <div className="kpi"><div className="kl">Delivered</div><div className="kv">{totalDelivered.toLocaleString()}</div><div className="ks">reached a handset</div></div>
            <div className="kpi"><div className="kl">Replies</div><div className="kv">{totalReplied.toLocaleString()}</div><div className="ks">{avgReply}% of delivered</div></div>
            <div className="kpi"><div className="kl">Leads</div><div className="kv">{totalLeads.toLocaleString()}</div><div className="ks">tapped Interested</div></div>
            <div className="kpi"><div className="kl">Lead rate</div><div className="kv">{avgLeadRate}%</div><div className="ks">of delivered</div></div>
          </div>

          {/* Toolbar: filter by name, sort, expand/collapse all */}
          <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap", marginBottom: 14 }}>
            <div style={{ position: "relative", flex: "1 1 200px", minWidth: 0 }}>
              <span style={{ position: "absolute", left: 11, top: "50%", transform: "translateY(-50%)", color: "var(--ink-3)", pointerEvents: "none" }}><Icon d={IC.search} s={15} /></span>
              <input className="input" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Filter templates" style={{ paddingLeft: 32 }} />
            </div>
            <select className="input" value={sort} onChange={(e) => setSort(e.target.value)} style={{ width: "auto", flex: "0 0 auto" }}>
              {SORTS.map((o) => <option key={o.key} value={o.key}>{o.label}</option>)}
            </select>
            <button className="btn btn-sec" onClick={toggleAll} style={{ flex: "0 0 auto" }}>
              <Icon d={IC.cdown} s={15} />{allOpen ? "Collapse all" : "Expand all"}
            </button>
          </div>

          {rows.map((t) => <TemplateCard key={t.sid} t={t} open={open.has(t.sid)} onToggle={() => toggle(t.sid)} />)}

          {rows.length === 0 && q.trim() !== "" && (
            <div className="hint" style={{ textAlign: "center", padding: 18 }}>No templates match “{q}”.</div>
          )}

          <details className="card" style={{ marginTop: 6 }}>
            <summary style={{ cursor: "pointer", fontSize: 12.5, fontWeight: 700, color: "var(--ink-2)" }}>How to read this</summary>
            <div className="hint" style={{ marginTop: 10 }}>
              Sent counts only messages handed to Twilio (canceled and skipped rows excluded). Failed = undelivered + failed receipts; Delivered and Read come from WhatsApp receipts; reply counts conversations that messaged back after the send. Every rate is a share of delivered, never of sent. Cold-outreach benchmarks: delivery 85%+ of reachable, read 45%+ of delivered, reply 1-3%+, interested 0.3-1%+ of delivered. Dead numbers are a list-quality issue, not a delivery failure.
            </div>
          </details>
        </>
      )}
    </div></div>
  );
}

// One template = one collapsible row. Collapsed shows name, headline metrics, the
// reply/lead pills and the single biggest leak + next action. Expanding reveals the
// full stage-by-stage funnel and the failure-reason breakdown.
function TemplateCard({ t, open, onToggle }: { t: any; open: boolean; onToggle: () => void }) {
  const s = t.s;
  const d = diagnose(s);
  const stages = [
    { label: "Sent", n: s.sent, color: "var(--ink-2)", note: "100%" },
    { label: "Failed", n: s.failed, color: "var(--red-ink)", note: `${s.failedRate}% of sent` },
    { label: "Delivered", n: s.delivered, color: "var(--green-dot)", note: `${s.deliveryRate}% of reachable` },
    { label: "Read", n: s.read, color: "var(--blue)", note: `${pct(s.read, s.delivered)}% of delivered` },
    { label: "Replied", n: s.replied, color: "var(--green-ink)", note: `${pct(s.replied, s.delivered)}% of delivered` },
    { label: "Leads", n: s.leads || 0, color: "var(--amber-dot)", note: `${s.leadRate || 0}% of delivered` },
  ];
  const base = Math.max(1, s.sent);
  return (
    <div className="card" style={{ marginBottom: 10, padding: open ? undefined : "13px 16px" }}>
      <div onClick={onToggle} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12, flexWrap: "wrap", cursor: "pointer" }}>
        <div className="cell-name" style={{ minWidth: 0, flex: 1 }}>
          <span className="tkind text"><Icon d={IC.tmpl} s={16} /></span>
          <div className="nm" style={{ minWidth: 0 }}>
            <div className="t" title={t.name} style={{ maxWidth: "none" }}>{t.name}</div>
            <div style={{ fontSize: 12, color: "var(--ink-3)", marginTop: 1 }}>{s.sent.toLocaleString()} sent · {s.replied.toLocaleString()} replied · {(s.leads || 0).toLocaleString()} leads</div>
          </div>
        </div>
        <div style={{ display: "flex", gap: 6, flexShrink: 0, alignItems: "center" }}>
          <span className="badge" style={{ color: replyColor(s.replyRate), borderColor: replyColor(s.replyRate), background: "transparent" }}>
            <span className="bd" style={{ background: replyColor(s.replyRate) }} />{s.replyRate}% reply
          </span>
          <span className="badge" style={{ color: leadColor(s.leadRate || 0), borderColor: leadColor(s.leadRate || 0), background: "transparent" }}>
            <span className="bd" style={{ background: leadColor(s.leadRate || 0) }} />{(s.leads || 0).toLocaleString()} leads
          </span>
          <span style={{ color: "var(--ink-3)", transform: open ? "rotate(180deg)" : "none", transition: "transform .18s", display: "inline-flex" }}><Icon d={IC.cdown} s={16} /></span>
        </div>
      </div>

      {/* Always-visible one-line diagnosis: the value of the whole row. */}
      <div style={{ display: "flex", gap: 9, marginTop: 12, padding: "9px 12px", borderRadius: "var(--r)", background: d.bg, border: `1px solid ${d.border}` }}>
        <Icon d={d.icon} s={16} />
        <div style={{ fontSize: 12.5, lineHeight: 1.5, color: d.color }}><b>{d.leak}.</b> {d.action}</div>
      </div>

      {open && (
        <>
          <div style={{ display: "grid", gap: 9, marginTop: 14 }}>
            {stages.map((st) => (
              <div key={st.label} style={{ display: "grid", gridTemplateColumns: "78px 56px 1fr", alignItems: "center", gap: 12 }}>
                <span style={{ fontSize: 12.5, color: "var(--ink-2)" }}>{st.label}</span>
                <span style={{ fontSize: 14, fontWeight: 700, color: "var(--ink)", textAlign: "right" }}>{st.n.toLocaleString()}</span>
                <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                  <div style={{ flex: 1, height: 9, borderRadius: 20, background: "var(--chip)", overflow: "hidden" }}>
                    <div style={{ width: `${(st.n / base) * 100}%`, height: "100%", background: st.color, borderRadius: 20, transition: "width .4s" }} />
                  </div>
                  <span style={{ fontSize: 11.5, color: "var(--ink-3)", width: 108, flexShrink: 0 }}>{st.note}</span>
                </div>
              </div>
            ))}
          </div>

          {s.failed > 0 && topErrors(s.errors).length > 0 && (
            <div style={{ marginTop: 14, padding: "11px 13px", borderRadius: "var(--r)", background: "var(--chip)", border: "1px solid var(--border)" }}>
              <div style={{ fontSize: 12, fontWeight: 700, color: "var(--ink-2)", marginBottom: 7 }}>Why {s.failed.toLocaleString()} didn&apos;t arrive</div>
              <div style={{ display: "grid", gap: 5 }}>
                {topErrors(s.errors).map(([code, n]) => (
                  <div key={code} style={{ display: "flex", justifyContent: "space-between", gap: 12, fontSize: 12.5, color: "var(--ink-2)" }}>
                    <span style={{ minWidth: 0 }}>{code === "none" ? "No reason reported by Twilio" : (TWILIO_ERRORS[code] || `Twilio error ${code}`)}{code !== "none" && <span style={{ color: "var(--ink-3)" }}> · {code}</span>}</span>
                    <b style={{ color: "var(--ink)", flexShrink: 0 }}>{n.toLocaleString()}</b>
                  </div>
                ))}
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}

const pct = (a: number, b: number) => (b ? Math.round((a / b) * 100) : 0);
// Top failure reasons (code -> count), busiest first, for the "why it failed" list.
const topErrors = (errors: Record<string, number> = {}): [string, number][] =>
  Object.entries(errors).sort((a, b) => b[1] - a[1]).slice(0, 4);
// Cold-outreach benchmarks. Reply rate: green 3%+, amber 1%+, grey otherwise.
const replyColor = (r: number) => (r >= 3 ? "var(--green-ink)" : r >= 1 ? "var(--amber-ink)" : "var(--ink-3)");
// Interested (lead) rate of delivered, cold-outreach: green 1%+, amber 0.3%+, grey otherwise.
const leadColor = (r: number) => (r >= 1 ? "var(--green-ink)" : r >= 0.3 ? "var(--amber-ink)" : "var(--ink-3)");

// Find the first funnel stage that under-performs and return the playbook action for it.
// Order matters: a leak early in the funnel (delivery) must be fixed before a later one.
function diagnose(s: any): { leak: string; color: string; bg: string; border: string; icon: ReactNode; action: string } {
  const readOfDelivered = s.delivered ? Math.round((s.read / s.delivered) * 100) : 0;
  const amber = { color: "var(--amber-ink)", bg: "var(--amber-bg)", border: "var(--amber-border)", icon: IC.bolt };
  const green = { color: "var(--green-ink)", bg: "var(--green-bg)", border: "var(--green-border)", icon: IC.check };
  const red = { color: "var(--red-ink)", bg: "var(--red-bg)", border: "var(--red-border)", icon: IC.bolt };
  // List quality first: if dead numbers are a big share of the send, that's the
  // real problem, not delivery — flag it before judging the delivery rate.
  if ((s.deadRate || 0) > 25)
    return { ...amber, leak: "Dirty list", action: `${s.deadRate}% of this send were dead numbers (not on WhatsApp). Clean the list before the next send so delivery and quality rating aren't dragged down.` };
  if (s.deliveryRate < 70) {
    // Name the real dominant reason from the error codes, not a guess.
    const buckets = [
      { n: s.errLocked || 0, leak: "Sender was locked by Meta", action: "Most failures are 63051 - Meta had the sender locked. Confirm the lock is lifted before resending; if not, the sender must be re-registered." },
      { n: s.errThrottled || 0, leak: "Over-messaging live users", action: "Most failures are 63049 - Meta capped these real users for too many marketing messages. Space sends out and stop re-blasting the same list." },
      { n: s.errHold || 0, leak: "Temporary Meta hold", action: "Most failures are 63032 - a short Meta experiment hold on these users. Retry later in small batches." },
    ].sort((a, b) => b.n - a.n);
    const top = buckets[0];
    if (top.n > 0) return { ...red, leak: top.leak, action: top.action };
    return { ...red, leak: "Delivery low", action: "Receipts came back failed with no error code. Open Insights for the raw Twilio reasons, then send to clean mobiles only." };
  }
  if (readOfDelivered < 30)
    return { ...amber, leak: "Read low", action: "Timing or sender trust. Send 10:00-13:00 or 17:00-20:00 GST, use an image header and the brand name." };
  if (s.replyRate < 1)
    return { ...amber, leak: "Reply low", action: "Weak hook, CTA or targeting. Front-load a value hook, keep one quick-reply CTA, tighten the audience." };
  if (s.replied > 0 && (s.leads || 0) === 0)
    return { ...amber, leak: "Replies aren't becoming leads", action: "People reply but none tapped Interested. Sharpen the offer/CTA so a reply turns into real interest, and make sure an agent follows up fast." };
  if (s.replied > 0)
    return { ...green, leak: "Capture leads fast", action: "Engagement is healthy. Interested taps land in the inbox Hot tab and auto-route to agents — make sure someone calls within minutes." };
  return { ...green, leak: "Healthy", action: "Funnel looks good. Scale within warm-up caps and test one change at a time." };
}
