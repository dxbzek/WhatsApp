"use client";
import { useEffect, useState } from "react";
import { Icon, IC, PageHead, downloadCSV } from "@/lib/ui";

const TWILIO_BILLING = "https://console.twilio.com/us1/billing/manage-billing/billing-overview";

type Billing = {
  balance: { balance: string; currency: string } | null;
  range: { days: number; since: string };
  spend: { total: number; allTime: number; avgPerDay: number; currency: string };
  byDay: { day: string; spend: number }[];
};

const dash = "—";

export default function Billing() {
  const [d, setD] = useState<Billing | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    fetch("/api/billing?days=30")
      .then((r) => r.json())
      .then((j) => { if (j?.error) setErr(j.error); else setD(j); })
      .catch(() => setErr("Could not reach Twilio billing."));
  }, []);

  const cur = (n: number, c = d?.spend.currency || "USD") => (c === "USD" ? "$" : c + " ") + n.toFixed(2);
  const balanceStr = d?.balance ? cur(parseFloat(d.balance.balance), d.balance.currency) : dash;
  const byDay = (d?.byDay || []).filter((x) => x.spend > 0).slice().reverse();

  const exportStatement = () => {
    if (!d) return;
    const rows: (string | number)[][] = [["Date", `Spend (${d.spend.currency})`]];
    d.byDay.forEach((x) => rows.push([x.day, x.spend.toFixed(4)]));
    rows.push(["Total (30d)", d.spend.total.toFixed(2)]);
    rows.push(["All-time", d.spend.allTime.toFixed(2)]);
    downloadCSV("ere-billing-spend.csv", rows);
  };

  return (
    <div className="page"><div className="maxw">
      <PageHead title="Billing & usage" sub="Live Twilio account balance and actual billed WhatsApp spend. Invoices and payment method are managed in Twilio.">
        <button className="btn btn-sec" onClick={exportStatement} disabled={!d}><Icon d={IC.dl} s={15} />Export spend</button>
        <a className="btn btn-primary" href={TWILIO_BILLING} target="_blank" rel="noreferrer"><Icon d={IC.plus} s={16} />Add funds</a>
      </PageHead>

      {err && <div className="err-box" style={{ marginBottom: 14 }}>{err}</div>}

      <div className="kpis k4">
        <div className="kpi"><div className="kl">Account balance</div><div className="kv">{balanceStr}</div><div className="ks">{d?.balance ? "live Twilio balance" : "prepaid balance unavailable"}</div></div>
        <div className="kpi"><div className="kl">Last 30 days</div><div className="kv">{d ? cur(d.spend.total) : dash}</div><div className="ks">actual billed spend</div></div>
        <div className="kpi"><div className="kl">All-time spend</div><div className="kv">{d ? cur(d.spend.allTime) : dash}</div></div>
        <div className="kpi"><div className="kl">Avg / day</div><div className="kv">{d ? cur(d.spend.avgPerDay) : dash}</div><div className="ks">over last 30 days</div></div>
      </div>

      <div className="grid-2">
        <div className="card">
          <div className="card-head"><div className="card-t">Daily spend</div><div className="card-meta">last 30 days · billed by Twilio</div></div>
          <table className="ttable flush">
            <thead><tr><th>Date</th><th style={{ textAlign: "right" }}>Spend</th></tr></thead>
            <tbody>
              {!d && <tr className="norow"><td colSpan={2} className="tcol-muted">Loading…</td></tr>}
              {d && byDay.length === 0 && <tr className="norow"><td colSpan={2} className="tcol-muted">No billed usage in the last 30 days.</td></tr>}
              {byDay.map((x) => (
                <tr key={x.day} className="norow">
                  <td className="tcol-muted">{new Date(x.day).toLocaleDateString([], { weekday: "short", month: "short", day: "numeric" })}</td>
                  <td style={{ textAlign: "right" }} className="mono">{cur(x.spend)}</td>
                </tr>
              ))}
              {d && byDay.length > 0 && (
                <tr className="totalrow"><td>Total</td><td style={{ textAlign: "right" }} className="mono">{cur(d.spend.total)}</td></tr>
              )}
            </tbody>
          </table>
        </div>

        <div className="card">
          <div className="card-head"><div className="card-t">Invoices & payment</div></div>
          <p style={{ fontSize: 13.5, color: "var(--ink-2)", lineHeight: 1.55, margin: "4px 0 14px" }}>
            Invoices, payment method and auto-recharge are managed in the Twilio console for this project — we don’t store card details or generate invoices here.
          </p>
          <a className="btn btn-sec" href={TWILIO_BILLING} target="_blank" rel="noreferrer">Open Twilio billing <Icon d={IC.ext} s={14} /></a>
          <a className="btn btn-ghost" style={{ marginLeft: 8 }} href="https://www.twilio.com/en-us/whatsapp/pricing" target="_blank" rel="noreferrer">WhatsApp rates <Icon d={IC.ext} s={14} /></a>
        </div>
      </div>
    </div></div>
  );
}
