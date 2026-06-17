"use client";
import { useEffect, useState, type ReactNode } from "react";
import Link from "next/link";
import { Icon, IC, PageHead, Skeleton } from "@/lib/ui";

export default function TemplatePerformance() {
  const [tpls, setTpls] = useState<any[]>([]);
  const [stats, setStats] = useState<Record<string, any> | null>(null);

  useEffect(() => {
    fetch("/api/templates").then((r) => r.json()).then((d) => setTpls(d.templates || []));
    fetch("/api/templates/performance").then((r) => r.json()).then((d) => setStats(d.stats || {}));
  }, []);

  // Show templates that have actually been sent, busiest first.
  const rows = tpls
    .map((t) => ({ ...t, s: stats?.[t.sid] }))
    .filter((t) => t.s && t.s.sent > 0)
    .sort((a, b) => b.s.sent - a.s.sent);

  // Headline rollups across all sent templates (pure derived view, no extra fetch).
  const totalSent = rows.reduce((n, t) => n + (t.s.sent || 0), 0);
  const totalReplied = rows.reduce((n, t) => n + (t.s.replied || 0), 0);
  const avgReply = totalSent ? Math.round((totalReplied / totalSent) * 100) : 0;

  return (
    <div className="page"><div className="maxw">
      <PageHead
        title="Template performance"
        sub="How each template actually performs (last 90 days). Each funnel shows where recipients drop off, with the biggest leak and the next action. Reply rate = share of recipients who messaged back."
      >
        <Link href="/templates" className="btn btn-sec"><Icon d={IC.tmpl} s={15} />Templates</Link>
      </PageHead>

      {stats === null && <Skeleton rows={6} />}

      {stats && rows.length === 0 && (
        <div className="empty">
          <div className="ei"><Icon d={IC.trend} s={22} /></div>
          <h4>No template sends yet</h4>
          <div>Run a <Link href="/campaigns" style={{ color: "var(--blue)", fontWeight: 600 }}>campaign</Link> or send a template from the inbox.</div>
        </div>
      )}

      {rows.length > 0 && (
        <>
          <div className="kpis k4">
            <div className="kpi"><div className="kl">Templates tracked</div><div className="kv">{rows.length}</div><div className="ks">sent · 90d</div></div>
            <div className="kpi"><div className="kl">Total sent</div><div className="kv">{totalSent.toLocaleString()}</div><div className="ks">last 90 days</div></div>
            <div className="kpi"><div className="kl">Replies</div><div className="kv">{totalReplied.toLocaleString()}</div><div className="ks">messaged back</div></div>
            <div className="kpi"><div className="kl">Avg reply rate</div><div className="kv">{avgReply}%</div><div className="ks">across templates</div></div>
          </div>

          {rows.map((t) => <TemplateCard key={t.sid} t={t} />)}

          <div className="hint" style={{ marginTop: 12 }}>
            Sent counts only messages actually handed to Twilio (canceled and skipped rows are excluded). Failed = undelivered + failed
            receipts; Delivered and Read come from WhatsApp receipts; reply counts conversations that messaged back after the send.
            Each bar is a share of how many were sent. Benchmarks: delivery 90%+, read 60%+ of delivered, reply 3%+ (good 10%+).
          </div>
        </>
      )}
    </div></div>
  );
}

// One template = one funnel card: name + reply pill, a stage-by-stage funnel you
// can actually read the drop-off from, and the single biggest leak + next action.
function TemplateCard({ t }: { t: any }) {
  const s = t.s;
  const d = diagnose(s);
  const stages = [
    { label: "Sent", n: s.sent, color: "var(--ink-2)", note: "100%" },
    { label: "Failed", n: s.failed, color: "var(--red-ink)", note: `${s.failedRate}% of sent` },
    { label: "Delivered", n: s.delivered, color: "var(--green-dot)", note: `${s.deliveryRate}% of sent` },
    { label: "Read", n: s.read, color: "var(--blue)", note: `${pct(s.read, s.delivered)}% of delivered` },
    { label: "Replied", n: s.replied, color: "var(--green-ink)", note: `${pct(s.replied, s.delivered)}% of delivered` },
  ];
  const base = Math.max(1, s.sent);
  return (
    <div className="card" style={{ marginBottom: 12 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12, flexWrap: "wrap", marginBottom: 14 }}>
        <div className="cell-name" style={{ minWidth: 0 }}>
          <span className="tkind text"><Icon d={IC.tmpl} s={16} /></span>
          <div className="nm" style={{ minWidth: 0 }}>
            <div className="t" title={t.name} style={{ maxWidth: "none" }}>{t.name}</div>
            <div style={{ fontSize: 12, color: "var(--ink-3)", marginTop: 1 }}>{s.sent.toLocaleString()} sent · {s.replied.toLocaleString()} replied</div>
          </div>
        </div>
        <span className="badge" style={{ color: replyColor(s.replyRate), borderColor: replyColor(s.replyRate), background: "transparent", flexShrink: 0 }}>
          <span className="bd" style={{ background: replyColor(s.replyRate) }} />{s.replyRate}% reply
        </span>
      </div>

      <div style={{ display: "grid", gap: 9 }}>
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

      <div style={{ display: "flex", gap: 9, marginTop: 14, padding: "11px 13px", borderRadius: "var(--r)", background: d.bg, border: `1px solid ${d.border}` }}>
        <Icon d={d.icon} s={16} />
        <div style={{ fontSize: 12.5, lineHeight: 1.5, color: d.color }}>
          <b>{d.leak}.</b> {d.action}
        </div>
      </div>
    </div>
  );
}

const pct = (a: number, b: number) => (b ? Math.round((a / b) * 100) : 0);
// Reply rate is the money metric: green if good (10%+), amber if okay (3%+), grey otherwise.
const replyColor = (r: number) => (r >= 10 ? "var(--green-ink)" : r >= 3 ? "var(--amber-ink)" : "var(--ink-3)");

// Find the first funnel stage that under-performs and return the playbook action for it.
// Order matters: a leak early in the funnel (delivery) must be fixed before a later one.
function diagnose(s: any): { leak: string; color: string; bg: string; border: string; icon: ReactNode; action: string } {
  const readOfDelivered = s.delivered ? Math.round((s.read / s.delivered) * 100) : 0;
  const amber = { color: "var(--amber-ink)", bg: "var(--amber-bg)", border: "var(--amber-border)", icon: IC.bolt };
  const green = { color: "var(--green-ink)", bg: "var(--green-bg)", border: "var(--green-border)", icon: IC.check };
  if (s.deliveryRate < 90)
    return { ...amber, color: "var(--red-ink)", bg: "var(--red-bg)", border: "var(--red-border)", leak: "Delivery low", action: "Likely dead numbers or sender health. Send to clean mobiles only and warm up the number within daily caps." };
  if (readOfDelivered < 50)
    return { ...amber, leak: "Read low", action: "Timing or sender trust. Send 10:00-13:00 or 17:00-20:00 GST, use an image header and the brand name." };
  if (s.replyRate < 3)
    return { ...amber, leak: "Reply low", action: "Weak hook, CTA or targeting. Front-load a value hook, keep one quick-reply CTA, tighten the audience." };
  if (s.replied > 0)
    return { ...green, leak: "Capture replies", action: "Engagement is healthy. Make sure replies route to Pipedrive and an agent calls within minutes." };
  return { ...green, leak: "Healthy", action: "Funnel looks good. Scale within warm-up caps and test one change at a time." };
}
