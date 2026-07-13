"use client";
import { useEffect, useState } from "react";
import { PageHead } from "@/lib/ui";
import { formatPhone } from "@/lib/format";

type Health = {
  number: string;
  lane: "utility" | "marketing";
  paused: boolean;
  pausedUntil: string | null;
  pauseReason: string | null;
  last24h: { attempts: number; delivered: number; failed: number; throttle49: number; resolved: number; deliveryRate: number | null; throttleRate: number };
};

// "in 9h 12m" style countdown to when a pause auto-expires.
function untilLabel(iso: string | null): string {
  if (!iso) return "";
  const ms = new Date(iso).getTime() - Date.now();
  if (ms <= 0) return "expired";
  const h = Math.floor(ms / 3600000);
  const m = Math.floor((ms % 3600000) / 60000);
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}

// Delivery-rate colour: green healthy, amber slipping, red bad.
const rateTone = (r: number | null) =>
  r == null ? "var(--ink-3)" : r >= 80 ? "var(--green-ink)" : r >= 55 ? "var(--amber-ink)" : "var(--red-ink, #b42318)";

export default function SenderHealth() {
  const [rows, setRows] = useState<Health[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  async function load() {
    setErr(null);
    try {
      const d = await fetch("/api/senders/health", { cache: "no-store" }).then((r) => r.json());
      if (d.error) throw new Error(d.error);
      setRows(d.senders || []);
    } catch (e: any) { setErr(e.message); setRows([]); }
  }
  useEffect(() => { load(); }, []); // eslint-disable-line

  async function clearPause(h: Health) {
    const ok = confirm(
      `Resume sending from ${formatPhone(h.number)}?\n\n` +
      `This number is paused:\n${h.pauseReason || "(no reason on record)"}\n\n` +
      `Only clear this if quality has recovered. Resuming a number Meta flagged too early risks a ban. Continue?`
    );
    if (!ok) return;
    setBusy(h.number);
    try {
      const d = await fetch("/api/senders/health", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sender: h.number, action: "clear" }),
      }).then((r) => r.json());
      if (d.error) throw new Error(d.error);
      await load();
    } catch (e: any) { setErr(e.message); }
    finally { setBusy(null); }
  }

  return (
    <div className="page">
      <div className="maxw" style={{ maxWidth: 760 }}>
        <PageHead title="Sender health" sub="Each WhatsApp number's lane, pause state, and last-24h delivery quality. Pauses protect a number from a Meta ban — clear one only after quality recovers." />

        {err && <div className="err-box">{err}</div>}
        {rows === null && <div className="hint">Loading…</div>}
        {rows && rows.length === 0 && !err && <div className="hint">No senders configured.</div>}

        <div style={{ display: "flex", flexDirection: "column", gap: 14, marginTop: 8 }}>
          {(rows || []).map((h) => {
            const s = h.last24h;
            return (
              <div key={h.number} className="sect" style={{ margin: 0, borderLeft: `4px solid ${h.paused ? "var(--red-ink, #b42318)" : "var(--green-ink)"}` }}>
                <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
                  <b style={{ fontSize: 16 }}>{formatPhone(h.number)}</b>
                  <span style={{ fontSize: 12, fontWeight: 700, padding: "2px 8px", borderRadius: 6, background: h.lane === "marketing" ? "var(--amber-bg, #fde9c8)" : "var(--green-bg, #dff3e4)", color: h.lane === "marketing" ? "var(--amber-ink)" : "var(--green-ink)" }}>
                    {h.lane === "marketing" ? "Marketing" : "Utility"} lane
                  </span>
                  <span style={{ marginLeft: "auto", fontSize: 12, fontWeight: 700, padding: "2px 8px", borderRadius: 6, background: h.paused ? "var(--red-bg, #fbe3e0)" : "var(--green-bg, #dff3e4)", color: h.paused ? "var(--red-ink, #b42318)" : "var(--green-ink)" }}>
                    {h.paused ? `Paused · clears in ${untilLabel(h.pausedUntil)}` : "Active"}
                  </span>
                </div>

                {h.paused && (
                  <div style={{ marginTop: 8, display: "flex", alignItems: "flex-start", gap: 10, flexWrap: "wrap" }}>
                    <div className="hint" style={{ margin: 0, flex: 1, minWidth: 200 }}>{h.pauseReason}</div>
                    <button className="btn btn-sec btn-sm" disabled={busy === h.number} onClick={() => clearPause(h)}>
                      {busy === h.number ? "Clearing…" : "Clear pause"}
                    </button>
                  </div>
                )}

                <div style={{ display: "flex", gap: 18, flexWrap: "wrap", marginTop: 12 }}>
                  <Stat label="Delivery (24h)" value={s.deliveryRate == null ? "—" : `${s.deliveryRate}%`} tone={rateTone(s.deliveryRate)} sub={`${s.resolved} resolved`} />
                  <Stat label="Sent (24h)" value={String(s.attempts)} sub={`${s.delivered}✓ / ${s.failed}✗`} />
                  <Stat label="Mkt throttle" value={`${s.throttleRate}%`} tone={s.throttleRate > 25 ? "var(--amber-ink)" : "var(--ink-2)"} sub={`${s.throttle49} × 63049`} />
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

function Stat({ label, value, sub, tone }: { label: string; value: string; sub?: string; tone?: string }) {
  return (
    <div style={{ minWidth: 110 }}>
      <div style={{ fontSize: 12, color: "var(--ink-3)" }}>{label}</div>
      <div style={{ fontSize: 22, fontWeight: 700, color: tone || "var(--ink-1, #111827)", lineHeight: 1.2 }}>{value}</div>
      {sub && <div style={{ fontSize: 11, color: "var(--ink-3)" }}>{sub}</div>}
    </div>
  );
}
