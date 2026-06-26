"use client";
/* Shared icons, helpers and primitives for the ERE × Twilio WhatsApp console.
   Ported from the design handoff (crm-shared.jsx + templates-data.jsx). */
import React, { useEffect, useState } from "react";

/* ── Icon ── */
export function Icon({ d, s = 18, f = "none", w = 1.7 }: { d: React.ReactNode; s?: number; f?: string; w?: number }) {
  return (
    <svg width={s} height={s} viewBox="0 0 24 24" fill={f} stroke="currentColor" strokeWidth={w} strokeLinecap="round" strokeLinejoin="round">
      {d}
    </svg>
  );
}

export const IC: Record<string, React.ReactNode> = {
  dash: <><rect x="3" y="3" width="7" height="9" rx="1.3" /><rect x="14" y="3" width="7" height="5" rx="1.3" /><rect x="14" y="12" width="7" height="9" rx="1.3" /><rect x="3" y="16" width="7" height="5" rx="1.3" /></>,
  inbox: <><path d="M22 12h-6l-2 3h-4l-2-3H2" /><path d="M5.5 5.5 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.5-6.5A2 2 0 0 0 16.7 4H7.3a2 2 0 0 0-1.8 1.5Z" /></>,
  tmpl: <><rect x="3" y="3" width="18" height="18" rx="2" /><path d="M3 9h18M9 21V9" /></>,
  camp: <><path d="m3 11 18-5v12L3 14v-3Z" /><path d="M11.6 16.8a3 3 0 1 1-5.2-3" /></>,
  insights: <><path d="M3 3v18h18" /><path d="m7 14 3-4 3 2 4-6" /></>,
  billing: <><rect x="2" y="5" width="20" height="14" rx="2" /><path d="M2 10h20" /></>,
  search: <><circle cx="11" cy="11" r="7" /><path d="m21 21-4.3-4.3" /></>,
  bell: <><path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9" /><path d="M13.7 21a2 2 0 0 1-3.4 0" /></>,
  help: <><circle cx="12" cy="12" r="10" /><path d="M9.1 9a3 3 0 0 1 5.8 1c0 2-3 3-3 3" /><path d="M12 17h.01" /></>,
  plus: <path d="M12 5v14M5 12h14" />,
  refresh: <><path d="M21 12a9 9 0 1 1-2.6-6.4" /><path d="M21 4v5h-5" /></>,
  reply: <><polyline points="9 17 4 12 9 7" /><path d="M20 18v-2a4 4 0 0 0-4-4H4" /></>,
  copy: <><rect x="9" y="9" width="11" height="11" rx="2" /><path d="M5 15V5a2 2 0 0 1 2-2h10" /></>,
  trash: <><path d="M3 6h18" /><path d="M8 6V4a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v2" /><path d="m6 6 1 14a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1l1-14" /></>,
  bolt: <path d="M13 2 3 14h7l-1 8 10-12h-7z" />,
  chev: <path d="m9 18 6-6-6-6" />,
  cdown: <path d="m6 9 6 6 6-6" />,
  cleft: <path d="m15 18-6-6 6-6" />,
  x: <path d="M18 6 6 18M6 6l12 12" />,
  ext: <><path d="M15 3h6v6" /><path d="M10 14 21 3" /><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" /></>,
  vars: <><path d="M8 3H7a2 2 0 0 0-2 2v4a2 2 0 0 1-2 2 2 2 0 0 1 2 2v4a2 2 0 0 0 2 2h1" /><path d="M16 3h1a2 2 0 0 1 2 2v4a2 2 0 0 0 2 2 2 2 0 0 0-2 2v4a2 2 0 0 1-2 2h-1" /></>,
  hash: <><path d="M4 9h16M4 15h16M10 3 8 21M16 3l-2 18" /></>,
  menu: <><path d="M3 6h18M3 12h18M3 18h18" /></>,
  send: <><path d="m22 2-7 20-4-9-9-4Z" /><path d="M22 2 11 13" /></>,
  dots: <><circle cx="12" cy="5" r="1.4" /><circle cx="12" cy="12" r="1.4" /><circle cx="12" cy="19" r="1.4" /></>,
  cal: <><rect x="3" y="4" width="18" height="18" rx="2" /><path d="M16 2v4M8 2v4M3 10h18" /></>,
  users: <><path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" /><circle cx="9" cy="7" r="4" /><path d="M22 21v-2a4 4 0 0 0-3-3.9" /><path d="M16 3.1A4 4 0 0 1 16 11" /></>,
  trend: <><path d="M22 7 13.5 15.5 8.5 10.5 2 17" /><path d="M16 7h6v6" /></>,
  check: <path d="M20 6 9 17l-5-5" />,
  clock: <><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" /></>,
  dl: <><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" /><path d="M7 10l5 5 5-5" /><path d="M12 15V3" /></>,
  card: <><rect x="2" y="5" width="20" height="14" rx="2" /><path d="M2 10h20" /></>,
  phone: <path d="M22 16.9v3a2 2 0 0 1-2.2 2 19.8 19.8 0 0 1-8.6-3 19.5 19.5 0 0 1-6-6 19.8 19.8 0 0 1-3.1-8.7A2 2 0 0 1 4.1 2h3a2 2 0 0 1 2 1.7c.1.9.4 1.8.7 2.7a2 2 0 0 1-.5 2.1L8.1 9.9a16 16 0 0 0 6 6l1.4-1.2a2 2 0 0 1 2.1-.5c.9.3 1.8.6 2.7.7a2 2 0 0 1 1.7 2Z" />,
  paperclip: <path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48" />,
  building: <><rect x="4" y="2" width="16" height="20" rx="1.5" /><path d="M9 22v-4h6v4M8 6h.01M12 6h.01M16 6h.01M8 10h.01M12 10h.01M16 10h.01M8 14h.01M12 14h.01M16 14h.01" /></>,
  logout: <><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" /><path d="m16 17 5-5-5-5" /><path d="M21 12H9" /></>,
  ban: <><circle cx="12" cy="12" r="10" /><path d="m4.9 4.9 14.2 14.2" /></>,
};

/* Double blue read-check (its own viewBox) */
export const CHECK2 = (
  <svg viewBox="0 0 16 11" width="14" height="11" fill="none" style={{ display: "inline-block", verticalAlign: "middle" }}>
    <path d="M1 6l3.2 3.2L9 2.5" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
    <path d="M6 6l3.2 3.2L14 2.5" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);

/* ── Language list (Dubai-weighted) ── */
export const LANGUAGES = [
  { code: "en", label: "English" },
  { code: "en_GB", label: "English (UK)" },
  { code: "ar", label: "Arabic" },
  { code: "hi", label: "Hindi" },
  { code: "ur", label: "Urdu" },
  { code: "fa", label: "Persian / Farsi" },
  { code: "ru", label: "Russian" },
  { code: "fr", label: "French" },
  { code: "fil", label: "Filipino" },
  { code: "zh_CN", label: "Chinese (Simplified)" },
  { code: "es", label: "Spanish" },
  { code: "de", label: "German" },
];

/* ── Status badge metadata ── */
type StatusMeta = { label: string; fg: string; bg: string; bd: string; dot: string };
export const STATUS_META: Record<string, StatusMeta> = {
  approved: { label: "Approved", fg: "#fff", bg: "var(--green-dot)", bd: "var(--green-dot)", dot: "rgba(255,255,255,.9)" },
  pending: { label: "Pending", fg: "#fff", bg: "var(--amber-dot)", bd: "var(--amber-dot)", dot: "rgba(255,255,255,.9)" },
  received: { label: "In review", fg: "#fff", bg: "var(--amber-dot)", bd: "var(--amber-dot)", dot: "rgba(255,255,255,.9)" },
  rejected: { label: "Rejected", fg: "#fff", bg: "var(--red)", bd: "var(--red)", dot: "rgba(255,255,255,.9)" },
  unsubmitted: { label: "Draft", fg: "#fff", bg: "var(--ink-3)", bd: "var(--ink-3)", dot: "rgba(255,255,255,.9)" },
};
export const sm = (s?: string): StatusMeta => STATUS_META[s || ""] || STATUS_META.unsubmitted;

export const kindOf = (t?: string | null): "card" | "qr" | "text" => {
  const v = (t || "").toLowerCase();
  return v.includes("card") ? "card" : v.includes("quick") ? "qr" : "text";
};
export const TYPE_LABEL = (t?: string | null) => ({ card: "Card", qr: "Quick reply", text: "Text" })[kindOf(t)];
export const LANG_LABEL = (c?: string | null) => LANGUAGES.find((l) => l.code === c)?.label || (c || "").toUpperCase();
export const isRTL = (c?: string | null) => ["ar", "ur", "fa"].includes(c || "");

export function renderVars(text?: string | null): React.ReactNode[] {
  return (text || "").split(/(\{\{\d+\}\})/g).map((p, i) =>
    /^\{\{\d+\}\}$/.test(p) ? <span key={i} className="var">{p}</span> : <React.Fragment key={i}>{p}</React.Fragment>
  );
}

export function fmtUpdated(iso?: string | null): string {
  try {
    return new Date(iso || "").toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" });
  } catch {
    return iso || "";
  }
}

/* ── Primitives ── */
export function Badge({ status }: { status?: string }) {
  const s = sm(status);
  return (
    <span className="badge" style={{ color: s.fg, background: s.bg, borderColor: s.bd }}>
      <span className="bd" style={{ background: s.dot }} />
      {s.label}
    </span>
  );
}

export function Avatar({ name, size = 38, tone }: { name?: string; size?: number; tone?: string }) {
  const init = (name || "?").split(/\s+/).map((w) => w[0]).slice(0, 2).join("").toUpperCase();
  const tones = ["#3D7BD9", "#0F9B6C", "#B8742B", "#8455C7", "#C0455E", "#2A8FA8"];
  let h = 0;
  for (const ch of name || "") h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  const bg = tone || tones[h % tones.length];
  return (
    <span className="avatar" style={{ width: size, height: size, background: bg, fontSize: size * 0.36 }}>
      {init}
    </span>
  );
}

export function PageHead({ title, sub, children }: { title: string; sub?: string; children?: React.ReactNode }) {
  return (
    <div className="page-head">
      <div className="hm">
        <div className="h1">{title}</div>
        {sub && <div className="page-sub">{sub}</div>}
      </div>
      {children && <div className="head-actions">{children}</div>}
    </div>
  );
}

export function Skeleton({ rows = 6 }: { rows?: number }) {
  return (
    <div className="skel-wrap">
      {Array.from({ length: rows }).map((_, i) => (
        <div className="skel-row" key={i}>
          <div className="skel-av" />
          <div className="skel-lines">
            <div className="skel-l" style={{ width: "38%" }} />
            <div className="skel-l" style={{ width: "66%" }} />
          </div>
        </div>
      ))}
    </div>
  );
}

/* ── CSV download (BOM + CRLF, quoted) ── */
export function downloadCSV(filename: string, rows: (string | number)[][]) {
  const esc = (v: string | number) => {
    const s = String(v == null ? "" : v);
    return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  };
  const csv = rows.map((r) => r.map(esc).join(",")).join("\r\n");
  const blob = new Blob(["﻿" + csv], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/* Trigger a text-file download (used for simple invoice exports). */
export function downloadText(filename: string, text: string, type = "text/plain") {
  const blob = new Blob([text], { type: `${type};charset=utf-8;` });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/* ── OS-aware keyboard hint (⌘K vs Ctrl K), hidden on touch ── */
export function useModCombo() {
  const [combo, setCombo] = useState<string | null>(null);
  useEffect(() => {
    const isMac = /Mac|iPhone|iPad|iPod/i.test(navigator.platform || navigator.userAgent || "");
    const isTouch = "ontouchstart" in window || (navigator.maxTouchPoints || 0) > 0;
    setCombo(isTouch ? null : isMac ? "⌘K" : "Ctrl K");
  }, []);
  return combo;
}

/* ── Tiny ephemeral toast ── */
export function Toast({ kind = "good", children, onDone, ms = 3200 }: { kind?: "good" | "bad" | "ink"; children: React.ReactNode; onDone?: () => void; ms?: number }) {
  useEffect(() => {
    if (!onDone) return;
    const t = setTimeout(onDone, ms);
    return () => clearTimeout(t);
  }, [onDone, ms]);
  return <div className={`toast ${kind === "good" ? "good" : kind === "bad" ? "bad" : ""}`}>{children}</div>;
}
