"use client";
import { useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { RATES } from "@/lib/rates";
import { formatPhone } from "@/lib/format";
import { PageHead } from "@/lib/ui";

type TplButton = { type: string; title: string; url?: string | null; phone?: string | null };
type Tpl = { sid: string; name: string; status: string; body: string | null; variables: Record<string, string>; media?: string | null; footer?: string | null; buttons?: TplButton[] };

const BATCH = 25;
// Named CRM segments are saved locally (single-user console - no backend needed).
const SEG_KEY = "ere_wa_segments";
// CRM fields a template variable can be personalized from.
const CRM_VAR_FIELDS = [
  { id: "first_name", label: "First name" },
  { id: "name", label: "Full name" },
  { id: "community", label: "Community" },
  { id: "building", label: "Building" },
  { id: "unit_number", label: "Unit number" },
  { id: "nationality", label: "Nationality" },
  { id: "tier", label: "Tier" },
];
function recordValue(rec: any, field: string): string {
  if (!rec) return "";
  // Pasted-CSV records carry named columns (first_name, community, ...) directly;
  // use them as-is so a value like "Abdul Aziz" is not truncated to one word.
  if (rec[field] != null && String(rec[field]).trim() !== "") return String(rec[field]).trim();
  if (field === "first_name") return String(rec.name || "").trim().split(/\s+/)[0] || "";
  return rec[field] != null ? String(rec[field]) : "";
}

// Parse a pasted / uploaded CSV that has a header row including a phone column,
// into per-recipient records so its other columns (first_name, community, ...)
// can personalize template variables - not just supply the phone number.
function parsePastedRecords(raw: string): { records: any[]; valueCols: string[] } | null {
  const lines = raw.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  if (lines.length < 2) return null;
  const header = lines[0].split(",").map((h) => h.trim().toLowerCase());
  const phoneIdx = header.findIndex((h) => h.includes("phone") || h === "number" || h === "mobile" || h === "msisdn");
  if (phoneIdx === -1) return null; // no header row -> treat as plain phone list
  const valueCols = header.filter((_, i) => i !== phoneIdx);
  const records: any[] = [];
  for (let i = 1; i < lines.length; i++) {
    const cells = lines[i].split(",");
    const phone = (cells[phoneIdx] || "").replace(/[^0-9]/g, "");
    if (!phone) continue;
    const rec: any = { phone };
    header.forEach((h, idx) => { if (idx !== phoneIdx) rec[h] = (cells[idx] || "").trim(); });
    records.push(rec);
  }
  return records.length ? { records, valueCols } : null;
}
// Warm-up profiles. Meta ramps a sender 250 -> 1K -> 2K -> 10K -> 100K only
// while quality stays high. Each profile sets a safe 24h cap and a drip pace.
const WARMUP = [
  { id: "new", label: "Brand-new", sub: "first few days", cap: 50, batch: 25, interval: 180 },
  { id: "warming", label: "Warming up", sub: "week 1-2", cap: 250, batch: 50, interval: 120 },
  { id: "established", label: "Established", sub: "1,000/day tier", cap: 1000, batch: 100, interval: 60 },
  { id: "scaled", label: "Scaled", sub: "2,000/day tier", cap: 2000, batch: 100, interval: 60 },
] as const;

// Drip pace presets, shown as descriptive cards.
const DRIP_PACES = [
  { id: "gentle", label: "Gentle", batch: 25, interval: 30, sub: "25 every 30 min · safest for a young number" },
  { id: "standard", label: "Standard", batch: 50, interval: 60, sub: "50 every hour · balanced" },
  { id: "fast", label: "Fast", batch: 100, interval: 60, sub: "100 every hour · quickest, safe at the 2,000/day tier" },
] as const;

// Daytime send window: 9:00–20:00 Dubai (GMT+4) = 05:00–16:00 UTC. Owners
// shouldn't get a property message at 2am — it kills replies and looks like spam.
function nextDaytimeUTC(d: Date): Date {
  const x = new Date(d.getTime());
  const h = x.getUTCHours();
  if (h >= 5 && h < 16) return x;       // already inside the window
  if (h >= 16) x.setUTCDate(x.getUTCDate() + 1); // after window -> tomorrow morning
  x.setUTCHours(5, 0, 0, 0);            // 05:00 UTC = 09:00 Dubai
  return x;
}
// One source of truth for drip batch times, shared by the preview summary and
// the actual send (buildPlan). Returns one entry per chunk: null = send now,
// otherwise the scheduled Date. When daytime is on, batches that would land
// overnight are pushed to the next morning and the drip resumes from there.
function planDripTimes(count: number, perBatch: number, intervalMin: number, daytime: boolean): (Date | null)[] {
  const chunks = Math.max(1, Math.ceil(count / Math.max(perBatch, 1)));
  const now = new Date();
  const out: (Date | null)[] = [];
  let cursor = now;
  for (let c = 0; c < chunks; c++) {
    if (c === 0) {
      const t = daytime ? nextDaytimeUTC(now) : now;
      cursor = t;
      out.push(t.getTime() <= now.getTime() + 1000 ? null : t); // within window -> immediate
    } else {
      let t = new Date(cursor.getTime() + intervalMin * 60000);
      if (daytime) t = nextDaytimeUTC(t);
      cursor = t;
      out.push(t);
    }
  }
  return out;
}

export default function Campaigns() {
  const [tpls, setTpls] = useState<Tpl[]>([]);
  const [tplSid, setTplSid] = useState("");
  // Re-entrancy guard for run(): set synchronously so a double-click during the
  // pre-send await/confirm window can't create a second campaign (the button's
  // disabled={running} only kicks in later, after the first await resolves).
  const busyRef = useRef(false);
  const [vars, setVars] = useState<Record<string, string>>({});
  const [varMap, setVarMap] = useState<Record<string, string>>({}); // var -> "fixed" | CRM field id
  const [crmRecips, setCrmRecips] = useState<any[]>([]); // detailed CRM records for personalization
  const [raw, setRaw] = useState("");
  const [mode, setMode] = useState<"now" | "later" | "drip">("now");
  const [sendAt, setSendAt] = useState(""); // for "later"
  const [perBatch, setPerBatch] = useState(50); // drip: recipients per batch
  const [intervalMin, setIntervalMin] = useState(120); // drip: minutes between batches
  const [daytimeOnly, setDaytimeOnly] = useState(true); // drip: pause overnight, send 9am-8pm Dubai
  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState<{ done: number; total: number; sent: number; skipped: number; failed: number } | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [doneMsg, setDoneMsg] = useState<string | null>(null);
  const [redirectIn, setRedirectIn] = useState<number | null>(null);
  const [agents, setAgents] = useState<{ id: string; name: string; wa_number: string }[]>([]);
  const [agentIds, setAgentIds] = useState<string[]>([]);
  const [blurb, setBlurb] = useState("");
  const router = useRouter();

  // Load agents for the lead-distribution picker.
  useEffect(() => {
    fetch("/api/agents").then((r) => r.json()).then((d) => setAgents(d.agents || [])).catch(() => {});
  }, []);

  // After a send completes (doneMsg set), auto-route to the campaign log so the
  // user lands on the live delivery numbers. Counts down so the summary is
  // readable first; cancellable if they want to stay and send another batch.
  useEffect(() => {
    if (!doneMsg) { setRedirectIn(null); return; }
    setRedirectIn(4);
    const tick = setInterval(() => {
      setRedirectIn((n) => {
        if (n === null) return null;
        if (n <= 1) { clearInterval(tick); router.push("/campaigns/history"); return 0; }
        return n - 1;
      });
    }, 1000);
    return () => clearInterval(tick);
  }, [doneMsg, router]);
  const [senders, setSenders] = useState<string[]>([]);
  const [sender, setSender] = useState("");
  const [optIn, setOptIn] = useState(false);
  const [excludeReached, setExcludeReached] = useState(true); // skip contacts already reached
  const [sentToday, setSentToday] = useState<number | null>(null);
  // The ERE sender has been live for weeks, so default to the established tier —
  // the cap warning then only fires on a genuinely large blast, not normal sends.
  const [warmup, setWarmup] = useState<typeof WARMUP[number]["id"]>("established");
  const [testPhone, setTestPhone] = useState("");
  const [testStatus, setTestStatus] = useState<string | null>(null);
  const [sendingTest, setSendingTest] = useState(false);
  const [source, setSource] = useState<"manual" | "crm">("manual");
  const [crmFilters, setCrmFilters] = useState<Record<string, string>>({});
  const [crmLimit, setCrmLimit] = useState(500);
  const [crmLoading, setCrmLoading] = useState(false);
  const [crmMatch, setCrmMatch] = useState<number | null>(null); // live segment size
  const [options, setOptions] = useState<Record<string, any[]>>({});
  const [mobileOnly, setMobileOnly] = useState(true); // WhatsApp delivers to mobiles only
  const [savedSegs, setSavedSegs] = useState<Record<string, { filters: Record<string, string>; mobileOnly: boolean; limit: number }>>({});

  // Filters sent to the API: the dropdown filters plus the mobile-only flag.
  const effFilters = { ...crmFilters, mobile_only: mobileOnly ? "1" : "0" };

  const wu = WARMUP.find((w) => w.id === warmup)!;
  const DAILY_CAP = wu.cap;

  // Lazy-load CRM filter dropdowns the first time the segment tab opens
  useEffect(() => {
    if (source !== "crm" || options.community) return;
    ["community", "nationality", "unit_type", "building"].forEach((col) => {
      fetch(`/api/crm/options?col=${col}`).then((r) => r.json()).then((d) => {
        if (d.values) setOptions((prev) => ({ ...prev, [col]: d.values }));
      });
    });
  }, [source]); // eslint-disable-line

  // Live, approximate segment size - so you can sanity-check the audience
  // before loading it. Debounced; recomputes whenever filters change.
  useEffect(() => {
    if (source !== "crm") return;
    setCrmMatch(null);
    const t = setTimeout(() => {
      fetch("/api/crm/count", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ filters: effFilters }),
      })
        .then((r) => r.json())
        .then((d) => setCrmMatch(typeof d.count === "number" ? d.count : null))
        .catch(() => setCrmMatch(null));
    }, 400);
    return () => clearTimeout(t);
  }, [source, JSON.stringify(crmFilters), mobileOnly]); // eslint-disable-line

  async function loadSegment() {
    setErr(null);
    setCrmLoading(true);
    try {
      const res = await fetch("/api/crm/contacts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ filters: effFilters, limit: crmLimit }),
      });
      const d = await res.json();
      if (!res.ok) throw new Error(d.error || "Failed to load segment");
      const recs = d.recipients || [];
      if (!recs.length) { setErr("No contactable numbers matched that segment."); setRaw(""); setCrmRecips([]); }
      else { setCrmRecips(recs); setRaw(recs.map((r: any) => r.phone).join("\n")); }
    } catch (e: any) {
      setErr(e.message);
    } finally {
      setCrmLoading(false);
    }
  }

  // Load saved segments + test phone once on mount.
  useEffect(() => {
    try { const s = localStorage.getItem(SEG_KEY); if (s) setSavedSegs(JSON.parse(s)); } catch { /* ignore */ }
    try { const p = localStorage.getItem("ere_wa_test_phone"); if (p) setTestPhone(p); } catch { /* ignore */ }
  }, []);
  function persistSegs(next: typeof savedSegs) {
    setSavedSegs(next);
    try { localStorage.setItem(SEG_KEY, JSON.stringify(next)); } catch { /* ignore */ }
  }
  function saveSegment() {
    const name = prompt('Name this segment (e.g. "Palm owners, 2+ properties")')?.trim();
    if (!name) return;
    persistSegs({ ...savedSegs, [name]: { filters: crmFilters, mobileOnly, limit: crmLimit } });
  }
  function applySegment(name: string) {
    const s = savedSegs[name]; if (!s) return;
    setCrmFilters(s.filters || {}); setMobileOnly(s.mobileOnly ?? true); setCrmLimit(s.limit || 500);
  }
  function deleteSegment(name: string) {
    if (!confirm(`Delete saved segment "${name}"?`)) return;
    const next = { ...savedSegs }; delete next[name]; persistSegs(next);
  }

  // Active filters as removable chips, so it's obvious what's narrowing the list.
  function filterChips(): { key: string; label: string }[] {
    const f = crmFilters; const out: { key: string; label: string }[] = [];
    const labels: Record<string, string> = { community: "community", nationality: "nationality", unit_type: "unit type", building: "building", verified_source: "source" };
    for (const k of Object.keys(labels)) if (f[k]) out.push({ key: k, label: `${labels[k]}: ${f[k]}` });
    if (f.number_of_properties) out.push({ key: "number_of_properties", label: `${f.number_of_properties} propert${f.number_of_properties === "1" ? "y" : "ies"}` });
    if (f.value_min) out.push({ key: "value_min", label: `≥ AED ${Number(f.value_min).toLocaleString()}` });
    if (f.value_max) out.push({ key: "value_max", label: `≤ AED ${Number(f.value_max).toLocaleString()}` });
    return out;
  }
  function clearFilter(key: string) { const n = { ...crmFilters }; delete n[key]; setCrmFilters(n); }

  useEffect(() => {
    fetch("/api/templates").then((r) => r.json()).then((d) => {
      setTpls((d.templates || []).filter((t: any) => t.status === "approved"));
    });
    fetch("/api/senders").then((r) => r.json()).then((d) => {
      setSenders(d.senders || []);
      if (d.senders?.length) setSender(d.senders[0]);
    });
    // Outbound messages in the last 24h (for the daily-cap guard)
    const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    fetch(`/api/messages?view=outCount&since=${encodeURIComponent(since)}`)
      .then((r) => r.json())
      .then((d) => setSentToday(d.count ?? 0))
      .catch(() => {});
  }, []);

  const tpl = tpls.find((t) => t.sid === tplSid);
  const tplVars = tpl ? Object.keys(tpl.variables || {}) : [];

  // Structured records from a pasted/uploaded CSV with a header (phone + columns).
  // Parse whenever the text has a phone header, regardless of the source toggle:
  // a plain number list (or a CRM-derived phone list) has no header and parses to
  // null, so this never clashes - it only kicks in for a real headered CSV.
  const pasted = useMemo(() => parsePastedRecords(raw), [raw]);

  // Auto-map template variables to a pasted CSV's columns in order ({{1}}->first
  // column after phone, {{2}}->next, ...) so a headered list personalizes without
  // manual mapping. Derived, NOT stored via an effect: the old effect could fire
  // before the template/CSV were ready and never re-run, leaving the map empty so
  // every send fell back to fixed text (the "Hi there / your Dubai" generic bug).
  // Here varMap[k] (a manual choice) wins, else the CSV column, else fixed text -
  // and this same resolver drives BOTH the preview and the send, so what you see is
  // exactly what goes out.
  const crmFieldIds = useMemo(() => new Set(CRM_VAR_FIELDS.map((f) => f.id)), []);
  function autoCol(i: number): string {
    const col = pasted?.valueCols[i];
    return col && crmFieldIds.has(col) ? col : "";
  }
  function effSrc(k: string, i: number): string {
    return varMap[k] || autoCol(i) || "fixed";
  }

  // Build a personalized preview from the FIRST recipient (CSV row or CRM record),
  // using the same resolver as the send. This is what surfaces a mis-mapped
  // variable: if it reads "Hi {{1}}" or "Hi there" here, it will send that way.
  const sampleRec = pasted?.records?.[0] || crmRecips[0] || null;
  const previewVars: Record<string, string> = {};
  tplVars.forEach((k, i) => {
    const src = effSrc(k, i);
    const val = src === "fixed" ? (vars[k] || "") : (recordValue(sampleRec, src) || vars[k] || "");
    previewVars[k] = val || `{{${k}}}`;
  });

  // Parse phone numbers from pasted text or CSV (first phone-like token per line)
  const numbers = Array.from(
    new Set(
      raw.split(/[\n,;]+/).map((s) => {
        const m = s.match(/\+?\d[\d\s-]{7,}\d/);
        return m ? m[0].replace(/[^0-9+]/g, "") : "";
      }).filter(Boolean)
    )
  );

  const estUsd = numbers.length * RATES.twilioPerMessage;

  // Drip plan summary, daytime-aware. Computed from the same planDripTimes() the
  // real send uses, so the "finishes at" the user sees is exactly what happens.
  const dripTimes = numbers.length ? planDripTimes(numbers.length, perBatch, intervalMin, daytimeOnly) : [];
  const dripLast = dripTimes.length ? dripTimes[dripTimes.length - 1] : null;
  const dripFinishMs = dripLast ? dripLast.getTime() : Date.now();
  const drip = numbers.length
    ? {
        chunks: dripTimes.length,
        fits: dripFinishMs - Date.now() <= 7 * 24 * 60 * 60 * 1000, // Twilio's 7-day schedule limit
        finishLabel: new Date(dripFinishMs).toLocaleString([], { weekday: "short", hour: "numeric", minute: "2-digit", month: "short", day: "numeric" }),
        spansDays: dripTimes.some((t) => t && t.getTime() - Date.now() > 14 * 60 * 60 * 1000),
      }
    : null;

  function onFile(e: React.ChangeEvent<HTMLInputElement>) {
    const f = e.target.files?.[0];
    if (!f) return;
    const reader = new FileReader();
    reader.onload = () => setRaw((prev) => (prev ? prev + "\n" : "") + String(reader.result || ""));
    reader.readAsText(f);
  }

  async function sendTest() {
    if (!tplSid) return setTestStatus("Pick a template first.");
    const phone = testPhone.trim();
    if (!phone) return setTestStatus("Enter your test number.");
    setSendingTest(true);
    setTestStatus(null);
    try {
      const e164raw = phone.replace(/[^0-9+]/g, "");
      const e164 = e164raw.startsWith("+") ? e164raw : `+${e164raw}`;
      // Use the same previewVars the preview shows — exact test of personalization.
      // If any var is still an unfilled placeholder ({{k}}), omit ContentVariables
      // entirely so Twilio falls back to the template's own sample values instead
      // of sending a blank string that triggers error 63024.
      const hasRealVars = tplVars.length > 0 && tplVars.every((k) => previewVars[k] && !previewVars[k].startsWith("{{"));
      const vars = hasRealVars ? previewVars : undefined;
      const body = renderLabel(tpl, previewVars);
      const res = await fetch("/api/campaign/send", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          recipients: [{ phone: e164, vars, body }],
          contentSid: tplSid,
          label: body,
          from: sender || undefined,
        }),
      });
      const d = await res.json();
      if (!res.ok) throw new Error(d.error || "Send failed");
      const r = d.results?.[0];
      if (!r) throw new Error("No result returned from send route");
      if (r.status === "failed") throw new Error(r.error || "Twilio rejected — check variable values");
      if (r.status === "skipped_invalid") throw new Error("Your number is flagged as invalid in the DB — go to the inbox, open your conversation and clear the invalid status, then retry");
      if (r.status === "skipped_blacklist") throw new Error("Your number is blocked (opted out) in the DB");
      setTestStatus(`Sent (${r.status}) · check your WhatsApp. SID: ${r.sid || "—"}`);
    } catch (e: any) {
      setTestStatus(`Failed: ${e.message}`);
    } finally {
      setSendingTest(false);
    }
  }

  async function run() {
    setErr(null);
    setDoneMsg(null);
    if (!tplSid) return setErr("Pick an approved template.");
    if (numbers.length === 0) return setErr("Add at least one recipient.");
    if (!optIn) return setErr("Please confirm these recipients opted in to WhatsApp messages.");
    // Collect every heads-up into ONE final confirm instead of stacking dialogs.
    const notes: string[] = [];
    if (sentToday != null && sentToday + numbers.length > DAILY_CAP) {
      notes.push(`⚠ Over the ${DAILY_CAP}/day cap for a ramping number (puts you at ${sentToday + numbers.length} in 24h) — can hurt quality rating.`);
    }

    // Validate timing per mode
    if (mode === "later") {
      if (!sendAt) return setErr("Pick a date & time.");
      const mins = (new Date(sendAt).getTime() - Date.now()) / 60000;
      if (mins < 15 || mins > 7 * 24 * 60) return setErr("Pick a time between 15 minutes and 7 days from now.");
    }
    if (mode === "drip" && drip && !drip.fits) {
      return setErr(`At ${perBatch} every ${humanInterval(intervalMin)}, this would take longer than Twilio's 7-day limit. Use a bigger batch, a shorter interval, or fewer recipients.`);
    }

    // WhatsApp rejects template params that are empty or contain newlines/tabs/
    // 4+ spaces (error 63024). Clean every value to avoid that.
    const clean = (s: string) => (s || "").replace(/[\r\n\t]+/g, " ").replace(/\s{2,}/g, " ").trim();

    // Build per-recipient variables: fixed text, or pulled from each contact's
    // CRM record (falling back to the fixed text when a field is empty).
    const pastedRecs = pasted?.records || [];
    const recMap = new Map([...crmRecips, ...pastedRecs].map((r) => [String(r.phone).replace(/[^0-9]/g, ""), r]));
    // Ignore a double-click while a send is already in flight (everything past
    // here is async, so the disabled button alone can't prevent re-entry).
    if (busyRef.current) return;
    busyRef.current = true;

    // Skip contacts who already received this (a delivered/read WhatsApp) so a
    // re-send never double-messages anyone. Failed / never-sent numbers are NOT
    // "reached", so they correctly stay in for a retry.
    let sendNumbers = numbers;
    if (excludeReached) {
      try {
        const rr = await fetch("/api/campaign/already-reached", {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ phones: numbers }),
        });
        const rd = await rr.json();
        const reached = new Set<string>((rd.reached || []).map((p: string) => String(p).replace(/[^0-9]/g, "")));
        if (reached.size) {
          const before = sendNumbers.length;
          sendNumbers = sendNumbers.filter((p) => !reached.has(p.replace(/[^0-9]/g, "")));
          const dropped = before - sendNumbers.length;
          if (dropped > 0) notes.push(`${dropped} already received a WhatsApp from ERE — skipped (no double-messaging).`);
        }
      } catch { /* best-effort: if the lookup fails, fall back to sending to all */ }
    }
    if (sendNumbers.length === 0) { busyRef.current = false; return setErr("Everyone on this list has already been reached. Nothing to send."); }

    const hasMapping = tplVars.length > 0;
    let blanks = 0;
    const recipients = sendNumbers.map((p) => {
      // body = the message rendered with THIS recipient's variables, so the inbox
      // shows what they actually received ("Hi Igor"), not a shared generic label.
      if (!hasMapping) return { phone: p, vars: undefined, body: renderLabel(tpl, vars) };
      const rec = recMap.get(p.replace(/[^0-9]/g, ""));
      const v: Record<string, string> = {};
      tplVars.forEach((k, i) => {
        const src = effSrc(k, i);
        const val = clean(src === "fixed" ? (vars[k] || "") : (recordValue(rec, src) || vars[k] || ""));
        if (!val) blanks++;
        v[k] = val;
      });
      return { phone: p, vars: v, body: renderLabel(tpl, v) };
    });

    // Empty variables are the #1 cause of 63024 — note it (don't stack a dialog).
    if (blanks > 0) notes.push(`⚠ ${blanks} variable value(s) are blank — WhatsApp may reject these (error 63024).`);

    const calls = buildPlan(recipients); // [{ batch, sendAt? }]
    const verb = mode === "now" ? "send now" : mode === "later" ? `schedule for ${new Date(sendAt).toLocaleString()}` : `drip ${perBatch} every ${humanInterval(intervalMin)} (finishes ${drip?.finishLabel})`;
    // ONE confirmation that rolls up the action + every heads-up. Shows the REAL
    // count that will send (sendNumbers, after skips), not the raw uploaded total.
    const summary = [
      `This will ${verb} to ${sendNumbers.length} recipient(s) using "${tpl?.name}".`,
      ...notes,
      "Blacklisted contacts are skipped. Continue?",
    ].join("\n\n");
    if (!confirm(summary)) { busyRef.current = false; return; }

    // SERVER-SIDE SEND (drip + now). Both write the recipients as 'scheduled'
    // messages and let /api/cron/dispatch deliver them — there is no browser loop,
    // so the send completes even if you close the tab or navigate away. "Now"
    // queues everyone due immediately (the dispatcher still paces per its cap,
    // which also avoids the 63049 marketing throttle); "drip" spreads across the
    // day. Both stay inside the 9am-8pm Dubai window. Only "later" (Twilio-native
    // scheduling) still uses the inline path below.
    if (mode === "drip" || mode === "now") {
      const isNow = mode === "now";
      setRunning(true);
      setProgress({ done: 0, total: recipients.length, sent: 0, skipped: 0, failed: 0 });
      try {
        const finishIso = isNow ? new Date().toISOString() : new Date(dripFinishMs).toISOString();
        const cr = await fetch("/api/campaign/create", {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ name: tpl?.name, templateSid: tplSid, templateName: tpl?.name, sender, mode, total: recipients.length, finishAt: finishIso, agentIds, distribution: "round_robin", blurb }),
        });
        const cd = await cr.json();
        if (!cr.ok) throw new Error(cd.error || "Could not create the campaign.");
        const campaignId = cd.id;

        // "Now" = one batch, all due immediately. "Drip" = paced per the UI.
        const er = await fetch("/api/campaign/enqueue", {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            campaignId, contentSid: tplSid, sender: sender || undefined, recipients,
            perBatch: isNow ? recipients.length : perBatch,
            intervalMin: isNow ? 1 : intervalMin,
            daytime: isNow ? true : daytimeOnly,
          }),
        });
        const ed = await er.json();
        if (!er.ok) throw new Error(ed.error || (isNow ? "Could not queue the send." : "Could not schedule the drip."));

        // Compile not-in-CRM recipients to the Sheet (best-effort, never blocks).
        let uncrmNote = "";
        try {
          const ex = await fetch("/api/campaign/export-uncrm", {
            method: "POST", headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ campaignId, campaignName: tpl?.name, mode: source, phones: sendNumbers, sentAt: new Date().toISOString() }),
          });
          const exd = await ex.json();
          if (ex.ok && exd.notInCrm > 0) uncrmNote = exd.logged ? ` · ${exd.notInCrm} not in CRM → added to the Sheet.` : ` · ${exd.notInCrm} not in CRM (Sheet not configured).`;
        } catch { /* ignore */ }

        const skipNote = ed.skipped ? ` · skipped ${ed.skipped} (blocked or already queued)` : "";
        setDoneMsg(
          isNow
            ? `Queued ${ed.enqueued} recipient(s) to send now${skipNote}.${uncrmNote} They go out over the next few minutes, paced to stay healthy, inside 9am-8pm Dubai. You can close this tab, sending runs on the server. Track it in the campaign log.`
            : `Scheduled ${ed.enqueued} recipient(s). They send automatically between now and ${drip?.finishLabel}, inside 9am-8pm Dubai${skipNote}.${uncrmNote} You can close this tab, sending runs on the server. Track it in the campaign log.`
        );
      } catch (e: any) {
        setErr(e.message);
      } finally {
        setRunning(false);
        busyRef.current = false;
      }
      return;
    }

    const label = renderLabel(tpl, vars);
    const finishAtIso = mode === "later" ? new Date(sendAt).toISOString() : null;

    setRunning(true);
    let done = 0, sent = 0, scheduled = 0, skipped = 0, failed = 0;
    let campaignId: string | undefined;
    setProgress({ done: 0, total: recipients.length, sent: 0, skipped: 0, failed: 0 });
    try {
      // Record the campaign first so it appears in the log immediately.
      const cr = await fetch("/api/campaign/create", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: tpl?.name, templateSid: tplSid, templateName: tpl?.name, sender, mode, total: recipients.length, finishAt: finishAtIso, agentIds, distribution: "round_robin", blurb }),
      });
      const cd = await cr.json();
      if (cr.ok) campaignId = cd.id;

      let batchErrors = 0;
      for (const call of calls) {
        let d: any = {};
        try {
          const res = await fetch("/api/campaign/send", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ recipients: call.batch, contentSid: tplSid, label, sendAt: call.sendAt, from: sender || undefined, campaignId }),
          });
          d = await res.json();
          if (!res.ok) throw new Error(d.error || "Batch failed");
        } catch {
          // One bad batch must NOT abort the whole send. Count its recipients as
          // failed and keep going through the rest of the list.
          batchErrors++;
          failed += call.batch.length;
          done += call.batch.length;
          setProgress({ done, total: recipients.length, sent: sent + scheduled, skipped, failed });
          continue;
        }
        for (const r of d.results) {
          done++;
          // Any skipped_* (blacklist, invalid/dead, already-reached) is a SKIP,
          // never a send — otherwise the summary claims "queued" for messages
          // that never went out.
          if (typeof r.status === "string" && r.status.startsWith("skipped")) skipped++;
          else if (r.status === "failed" || r.status === "invalid") failed++;
          else if (r.status === "scheduled") scheduled++;
          else sent++;
        }
        setProgress({ done, total: recipients.length, sent: sent + scheduled, skipped, failed });
      }
      // "later" schedules via Twilio; if nothing actually scheduled, Twilio sent
      // immediately (no Messaging Service configured). Say so plainly. (Drip no
      // longer reaches here — it returns early via the server-side queue.)
      const schedNote = mode === "later" && scheduled === 0
        ? " Heads up: scheduling is not configured (Twilio Messaging Service SID), so these went out immediately instead of spreading out."
        : "";
      const batchNote = batchErrors ? ` ${batchErrors} batch(es) errored and were skipped.` : "";
      const tail = "";
      const sch = scheduled ? `, scheduled ${scheduled}` : "";
      // Compile recipients that aren't in the Audience CRM into the Google Sheet,
      // with where they came from, so they can be added. Best-effort - never
      // blocks or fails the send.
      let uncrmNote = "";
      try {
        const ex = await fetch("/api/campaign/export-uncrm", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ campaignId, campaignName: tpl?.name, mode: source, phones: sendNumbers, sentAt: new Date().toISOString() }),
        });
        const ed = await ex.json();
        if (ex.ok && ed.notInCrm > 0) {
          uncrmNote = ed.logged
            ? ` · ${ed.notInCrm} not in CRM → added to the Sheet.`
            : ` · ${ed.notInCrm} not in CRM (Sheet not configured).`;
        }
      } catch { /* ignore - export is best-effort */ }
      setDoneMsg(`Queued ${sent}${sch} to Twilio · skipped ${skipped} (already reached, dead number, or opted out) · failed ${failed}.${batchNote}${schedNote}${tail}${uncrmNote} ${sent > 0 ? "Twilio is delivering now - real delivered/read rates are in Insights." : "Nothing went out - every recipient was skipped."}`);
    } catch (e: any) {
      setErr(e.message);
    } finally {
      // Always record the outcome (even on partial failure) so the log is accurate.
      if (campaignId) {
        await fetch("/api/campaign/finalize", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ id: campaignId, sent, scheduled, failed, skipped, total: recipients.length }),
        }).catch(() => {});
      }
      setRunning(false);
      busyRef.current = false;
    }
  }

  // Build the list of API calls (each <=25 recipients) with per-batch send times.
  function buildPlan(recipients: any[]) {
    const calls: { batch: any[]; sendAt?: string }[] = [];
    const push = (arr: any[], sendAt?: string) => { for (let i = 0; i < arr.length; i += BATCH) calls.push({ batch: arr.slice(i, i + BATCH), sendAt }); };
    if (mode === "now") push(recipients);
    else if (mode === "later") push(recipients, new Date(sendAt).toISOString());
    else {
      // drip: chunk of perBatch per the daytime-aware schedule. Recomputed fresh
      // at send time so the times are accurate to the moment Send is pressed.
      const times = planDripTimes(recipients.length, perBatch, intervalMin, daytimeOnly);
      for (let c = 0, i = 0; i < recipients.length; c++, i += perBatch) {
        const chunk = recipients.slice(i, i + perBatch);
        const t = times[c];
        push(chunk, t ? t.toISOString() : undefined);
      }
    }
    return calls;
  }

  return (
    <div className="page">
      <div className="maxw" style={{ maxWidth: 760 }}>
        <PageHead title="Campaigns" sub="Send an approved template to many contacts at once. Blacklisted contacts are skipped automatically.">
          <Link href="/campaigns/history" className="btn btn-sec btn-sm">Campaign log →</Link>
        </PageHead>

        <div className="sect">
          <div className="sect-t">1 · Template</div>
          <select value={tplSid} onChange={(e) => { setTplSid(e.target.value); setVars({}); setVarMap({}); }} className="input">
            <option value="">Select an approved template…</option>
            {tpls.map((t) => <option key={t.sid} value={t.sid}>{t.name}</option>)}
          </select>
          {tpl && (tpl.body || tpl.media || (tpl.buttons?.length ?? 0) > 0) && (
            <div style={{ marginTop: 12, maxWidth: 360 }}>
              <div className="dlabel" style={{ marginTop: 0 }}>Preview{sampleRec ? " (first recipient)" : ""}</div>
              <div className="wa-bubble" style={{ maxWidth: "100%" }}>
                {tpl.media && <img className="bimg" src={tpl.media} alt="" />}
                {tpl.body && <div className="bbody">{renderLabel(tpl, previewVars)}</div>}
                {tpl.footer && <div className="bfoot">{tpl.footer}</div>}
                {(tpl.buttons?.length ?? 0) > 0 && (
                  <div style={{ marginTop: 6, display: "flex", flexDirection: "column", gap: 4 }}>
                    {tpl.buttons!.map((b, bi) => {
                      const icon = b.type === "URL" ? "🔗" : b.type === "PHONE_NUMBER" ? "📞" : "↩︎";
                      return (
                        <div key={bi} className="wa-reply" style={{ maxWidth: "100%" }}>
                          <span style={{ fontSize: 13 }}>{icon}</span>{b.title}
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            </div>
          )}
          {tplVars.length > 0 && (
            <div style={{ marginTop: 14 }}>
              <div className="hint" style={{ marginTop: 0, marginBottom: 6 }}>Fill each variable with fixed text or a CRM field (personalized per recipient).</div>
              {tplVars.map((k, i) => {
                const src = effSrc(k, i);
                return (
                  <div key={k} style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 8, flexWrap: "wrap" }}>
                    <span className="varkey">{`{{${k}}}`}</span>
                    <select value={src} onChange={(e) => setVarMap({ ...varMap, [k]: e.target.value })} className="input" style={{ width: 160 }}>
                      <option value="fixed">Fixed text</option>
                      {CRM_VAR_FIELDS.map((f) => <option key={f.id} value={f.id}>{f.label}</option>)}
                    </select>
                    <input value={vars[k] || ""} onChange={(e) => setVars({ ...vars, [k]: e.target.value })} placeholder={src === "fixed" ? "value for all recipients" : "fallback if missing"} className="input" style={{ flex: 1, minWidth: 150 }} />
                  </div>
                );
              })}
              {pasted?.valueCols.length ? (
                <div className="hint" style={{ color: "var(--green-ink)" }}>Personalizing from your CSV columns: {pasted.valueCols.join(", ")}.</div>
              ) : Object.values(varMap).some((v) => v !== "fixed") && source !== "crm" && (
                <div className="hint" style={{ color: "var(--amber-ink)" }}>CRM fields only fill for recipients loaded from a CRM segment. A plain pasted number list uses the fallback text. Include a header row (phone,first_name,community) to personalize from a CSV.</div>
              )}
            </div>
          )}

          {tpl && (
            <div style={{ marginTop: 16, paddingTop: 14, borderTop: "1px solid var(--border)" }}>
              <div className="dlabel" style={{ marginTop: 0 }}>Send test</div>
              <div style={{ display: "flex", gap: 8, alignItems: "flex-end", flexWrap: "wrap" }}>
                <div style={{ flex: 1, minWidth: 180 }}>
                  <label className="label">Your number (saved)</label>
                  <input
                    value={testPhone}
                    onChange={(e) => { setTestPhone(e.target.value); try { localStorage.setItem("ere_wa_test_phone", e.target.value); } catch {} }}
                    placeholder="+971XXXXXXXXX"
                    className="input"
                  />
                </div>
                <button
                  onClick={sendTest}
                  disabled={sendingTest || !testPhone.trim()}
                  className="btn btn-sec"
                >
                  {sendingTest ? "Sending…" : "Send test to me →"}
                </button>
              </div>
              <div className="hint">
                Sends the template with the variable values shown in the preview above. Bypasses daily cap and opt-in checks.
              </div>
              {testStatus && (
                testStatus.startsWith("Sent")
                  ? <div className="ok-box">{testStatus}</div>
                  : <div className="err-box">{testStatus}</div>
              )}
            </div>
          )}
        </div>

        <div className="sect">
          <div className="sect-t">2 · Recipients</div>
          <div className="seg" style={{ marginBottom: 12 }}>
            {(["manual", "crm"] as const).map((m) => (
              <button key={m} onClick={() => setSource(m)} className={source === m ? "on" : ""}>
                {m === "manual" ? "Paste / CSV" : "From CRM segment"}
              </button>
            ))}
          </div>

          {source === "manual" && (
            <>
              <textarea value={raw} onChange={(e) => setRaw(e.target.value)} rows={pasted ? 3 : 5} placeholder="Paste numbers, one per line (e.g. +9715XXXXXXXX) — or a CSV with a phone,first_name,… header" className="input" style={{ fontFamily: pasted ? "var(--mono)" : undefined, fontSize: pasted ? 12 : undefined }} />
              <label className="hint" style={{ display: "block", cursor: "pointer", marginTop: 8 }}>
                <input type="file" accept=".csv,text/csv,text/plain" onChange={onFile} style={{ fontSize: 13 }} />
              </label>
              {pasted && <RecipientTable records={pasted.records} valueCols={pasted.valueCols} tplVars={tplVars} />}
            </>
          )}

          {source === "crm" && (
            <div>
              {Object.keys(savedSegs).length > 0 && (
                <div style={{ display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap", marginBottom: 12 }}>
                  <span className="hint" style={{ marginTop: 0 }}>Saved:</span>
                  {Object.keys(savedSegs).map((name) => (
                    <span key={name} className="metric" style={{ marginRight: 0 }}>
                      <button onClick={() => applySegment(name)} title="Load this segment" style={{ padding: 0, fontSize: 12, color: "inherit" }}>{name}</button>
                      <button onClick={() => deleteSegment(name)} title="Delete" style={{ padding: 0, color: "var(--ink-3)" }}>×</button>
                    </span>
                  ))}
                </div>
              )}
              <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(160px,1fr))", gap: 8 }}>
                {(["community", "nationality", "unit_type", "building"] as const).map((col) => (
                  <select key={col} value={crmFilters[col] || ""} onChange={(e) => setCrmFilters({ ...crmFilters, [col]: e.target.value })} className="input">
                    <option value="">{col.replace("_", " ")}: any</option>
                    {(options[col] || []).map((o: any) => <option key={o.val} value={o.val}>{o.val} ({o.n})</option>)}
                  </select>
                ))}
                <select value={crmFilters.number_of_properties || ""} onChange={(e) => setCrmFilters({ ...crmFilters, number_of_properties: e.target.value })} className="input">
                  <option value="">properties: any</option>
                  {["1", "2", "3", "4", "5", "6", "7", "8", "9", "10+"].map((n) => <option key={n} value={n}>{n} {n === "1" ? "property" : "properties"}</option>)}
                </select>
                <select value={crmFilters.verified_source || ""} onChange={(e) => setCrmFilters({ ...crmFilters, verified_source: e.target.value })} className="input">
                  <option value="">source: any</option>
                  {["Property Finder", "Bayut", "AiLookup", "Property Monitor", "Dubizzle"].map((s) => <option key={s} value={s}>{s}</option>)}
                </select>
              </div>
              <div style={{ display: "flex", gap: 8, alignItems: "center", marginTop: 8, flexWrap: "wrap" }}>
                <label className="hint" style={{ marginTop: 0 }}>Value AED
                  <input type="number" value={crmFilters.value_min || ""} min={0} placeholder="min" onChange={(e) => setCrmFilters({ ...crmFilters, value_min: e.target.value })} className="input" style={{ width: 110, marginLeft: 6, display: "inline-block" }} />
                </label>
                <span style={{ color: "var(--ink-3)" }}>to</span>
                <input type="number" value={crmFilters.value_max || ""} min={0} placeholder="max" onChange={(e) => setCrmFilters({ ...crmFilters, value_max: e.target.value })} className="input" style={{ width: 110 }} />
                <label className="hint" style={{ marginTop: 0, display: "flex", alignItems: "center", gap: 6, marginLeft: "auto" }}>
                  <input type="checkbox" checked={mobileOnly} onChange={(e) => setMobileOnly(e.target.checked)} /> Mobile numbers only
                </label>
              </div>
              {filterChips().length > 0 && (
                <div style={{ display: "flex", gap: 6, flexWrap: "wrap", alignItems: "center", marginTop: 10 }}>
                  {filterChips().map((c) => (
                    <button key={c.key} onClick={() => clearFilter(c.key)} title="Remove filter" className="metric" style={{ marginRight: 0 }}>
                      {c.label} <span style={{ color: "var(--ink-3)" }}>×</span>
                    </button>
                  ))}
                  <button onClick={() => setCrmFilters({})} className="btn btn-ghost btn-sm">Clear all</button>
                </div>
              )}
              <div style={{ display: "flex", gap: 8, alignItems: "center", marginTop: 10, flexWrap: "wrap" }}>
                <label className="hint" style={{ marginTop: 0 }}>Max recipients
                  <input type="number" value={crmLimit} min={1} max={5000} onChange={(e) => setCrmLimit(parseInt(e.target.value || "500", 10))} className="input" style={{ width: 90, marginLeft: 6, display: "inline-block" }} />
                </label>
                <button onClick={loadSegment} disabled={crmLoading} className="btn btn-primary">
                  {crmLoading ? "Loading…" : "Load recipients"}
                </button>
                <button onClick={saveSegment} title="Save these filters as a reusable segment" className="btn btn-sec">Save segment</button>
              </div>
              <div style={{ marginTop: 10, padding: "10px 12px", background: "var(--surface-2)", border: "1px solid var(--border)", borderRadius: "var(--r)", color: "var(--ink)" }}>
                {crmMatch == null ? (
                  <span className="hint" style={{ marginTop: 0 }}>Counting matching contacts…</span>
                ) : (
                  <>
                    <div style={{ display: "flex", alignItems: "baseline", gap: 8, flexWrap: "wrap" }}>
                      <b style={{ fontSize: 18 }}>~{crmMatch.toLocaleString()}</b>
                      <span style={{ fontSize: 13 }}>contact{crmMatch === 1 ? "" : "s"} match this segment</span>
                    </div>
                    <div style={{ fontSize: 13, marginTop: 4 }}>
                      You’ll load up to <b>{Math.min(crmLimit, crmMatch).toLocaleString()}</b>{mobileOnly && <span style={{ color: "var(--ink-2)" }}> — fewer after mobile-only filtering</span>}.
                    </div>
                  </>
                )}
              </div>
              <div className="hint" title="Excludes any contact marked do-not-call, uncontactable, or as a switchboard number.">Approximate, before mobile-only filtering. Excludes do-not-call, uncontactable, and switchboards.{mobileOnly && " Mobile-only is on, so the loaded list will be smaller than this count."}</div>
            </div>
          )}

          {(numbers.length > 0 || (source === "manual" && raw.trim() !== "")) && (
            <div style={{ fontSize: 13, color: numbers.length ? "var(--green-ink)" : "var(--ink-3)", fontWeight: 600, marginTop: 10 }}>
              {numbers.length} valid recipient{numbers.length === 1 ? "" : "s"}{source === "crm" && numbers.length > 0 ? " loaded" : ""}
            </div>
          )}
        </div>

        <div className="sect">
          <div className="sect-t">3 · Send from</div>
          <select value={sender} onChange={(e) => setSender(e.target.value)} className="input" style={{ maxWidth: 280 }}>
            {senders.length === 0 && <option value="">(no sender configured)</option>}
            {senders.map((s) => <option key={s} value={s}>{formatPhone(s)}</option>)}
          </select>

        </div>

        <div className="sect">
          <div className="sect-t">Assign leads to</div>
          <div className="hint" style={{ marginTop: 0, marginBottom: 10 }}>
            Pick who gets the leads. Replies split round-robin; each is pinged with the lead’s number. Leave empty to keep unassigned.
          </div>
          {agents.length === 0 ? (
            <div className="hint" style={{ margin: 0 }}>No agents configured yet.</div>
          ) : (
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
              {agents.map((a) => {
                const on = agentIds.includes(a.id);
                return (
                  <div
                    key={a.id}
                    onClick={() => setAgentIds((cur) => on ? cur.filter((x) => x !== a.id) : [...cur, a.id])}
                    className={`pick${on ? " on" : ""}`}
                    style={{ flex: "1 1 140px", marginBottom: 0 }}
                  >
                    <div className="pk-radio" />
                    <div className="pk-main">
                      <div className="pk-t">{a.name}</div>
                      <div className="pk-s">{formatPhone(a.wa_number)}</div>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
          {agentIds.length > 0 && (
            <>
              <div className="hint" style={{ marginBottom: 6 }}>
                {agentIds.length === 1 ? "All leads go to this agent." : `Round-robin across ${agentIds.length} agents.`}
              </div>
              <input
                value={blurb}
                onChange={(e) => setBlurb(e.target.value)}
                className="input"
                maxLength={140}
                placeholder='Heads-up for the agent, e.g. "Buyers for off-market Palm villas under AED 25M"'
              />
              <div className="hint" style={{ marginBottom: 0 }}>One line telling the agent what this campaign is about. It goes in their lead alert. Optional.</div>
            </>
          )}
        </div>

        <div className="sect">
          <div className="sect-t">4 · When to send</div>

          {/* Mode as descriptive cards, not bare toggles */}
          <div style={{ display: "grid", gap: 8 }}>
            {([
              { m: "now", t: "Send now", s: "Everyone at once, right away" },
              { m: "drip", t: "Spread it out", s: "Small batches over the day · safest for your number" },
              { m: "later", t: "Send later", s: "Pick a date & time" },
            ] as const).map(({ m, t, s }) => (
              <div key={m} onClick={() => setMode(m)} className={`pick${mode === m ? " on" : ""}`} style={{ marginBottom: 0 }}>
                <div className="pk-radio" />
                <div className="pk-main">
                  <div className="pk-t">{t}{m === "drip" && <span style={{ marginLeft: 8, fontSize: 11, fontWeight: 700, color: "var(--green-ink)", background: "var(--green-bg)", border: "1px solid var(--green-border)", borderRadius: 20, padding: "1px 8px", verticalAlign: "middle" }}>Recommended</span>}</div>
                  <div className="pk-s">{s}</div>
                </div>
              </div>
            ))}
          </div>

          {mode === "later" && (
            <div style={{ marginTop: 14 }}>
              <input type="datetime-local" value={sendAt} onChange={(e) => setSendAt(e.target.value)} className="input" style={{ maxWidth: 280 }} />
              <div className="hint">Anytime from 15 minutes to 7 days from now.</div>
            </div>
          )}

          {mode === "drip" && (
            <div style={{ marginTop: 14 }}>
              <div className="label" style={{ marginBottom: 8 }}>Pace</div>
              <div style={{ display: "grid", gap: 8 }}>
                {DRIP_PACES.map((x) => (
                  <div key={x.id} onClick={() => { setPerBatch(x.batch); setIntervalMin(x.interval); }} className={`pick${perBatch === x.batch && intervalMin === x.interval ? " on" : ""}`} style={{ marginBottom: 0 }}>
                    <div className="pk-radio" />
                    <div className="pk-main">
                      <div className="pk-t">{x.label}</div>
                      <div className="pk-s">{x.sub}</div>
                    </div>
                  </div>
                ))}
              </div>

              <label className="checkrow" style={{ marginTop: 12 }}>
                <input type="checkbox" checked={daytimeOnly} onChange={(e) => setDaytimeOnly(e.target.checked)} />
                <span>Only send <b>9am–8pm Dubai</b> — pause overnight, resume next morning. (Better replies, protects quality.)</span>
              </label>

              <details style={{ marginTop: 12 }}>
                <summary style={{ fontSize: 12.5, color: "var(--ink-3)", cursor: "pointer", userSelect: "none" }}>Custom pace</summary>
                <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap", fontSize: 14, marginTop: 10 }}>
                  <span style={{ color: "var(--ink-2)" }}>Send</span>
                  <input type="number" value={perBatch} min={1} max={250} onChange={(e) => setPerBatch(parseInt(e.target.value || "50", 10))} className="input" style={{ width: 80 }} />
                  <span style={{ color: "var(--ink-2)" }}>recipients every</span>
                  <select value={intervalMin} onChange={(e) => setIntervalMin(parseInt(e.target.value, 10))} className="input" style={{ width: 130 }}>
                    {[30, 60, 120, 180, 240, 360, 720, 1440].map((m) => <option key={m} value={m}>{humanInterval(m)}</option>)}
                  </select>
                </div>
              </details>
            </div>
          )}

          {/* Live result line — the single source of truth for what will happen */}
          {drip && mode === "drip" && (
            drip.fits ? (
              <div className="ok-box" style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <span style={{ fontWeight: 700 }}>→</span>
                <span>
                  <b>{numbers.length}</b> recipient{numbers.length === 1 ? "" : "s"} · {drip.chunks} batch{drip.chunks === 1 ? "" : "es"}
                  {daytimeOnly && " · daytime only"} · finishes <b>{drip.finishLabel}</b>
                </span>
              </div>
            ) : (
              <div className="err-box">Too slow for this list — it would take over 7 days (Twilio's limit). Pick a faster pace{daytimeOnly ? ", or turn off daytime-only" : ""}.</div>
            )
          )}
        </div>

        {/* Compliance - keeps the number's quality rating healthy */}
        <div className="card">
          <div className="sect-t">Before you send</div>
          <label style={{ fontSize: 14, display: "flex", gap: 8, alignItems: "flex-start", cursor: "pointer", marginBottom: 10 }}>
            <input type="checkbox" checked={optIn} onChange={(e) => setOptIn(e.target.checked)} style={{ marginTop: 3, accentColor: "var(--blue)" }} />
            <span>I confirm these recipients <b>opted in</b> to receive WhatsApp messages from ERE Homes.</span>
          </label>
          <label style={{ fontSize: 14, display: "flex", gap: 8, alignItems: "flex-start", cursor: "pointer", marginBottom: 10 }}>
            <input type="checkbox" checked={excludeReached} onChange={(e) => setExcludeReached(e.target.checked)} style={{ marginTop: 3, accentColor: "var(--blue)" }} />
            <span><b>Skip anyone already reached.</b> Drops contacts who already got a delivered/read message, so a re-send never double-messages them. Failed or never-sent numbers stay in for a retry.</span>
          </label>
          <div style={{ fontSize: 13, background: "var(--amber-bg)", border: "1px solid var(--amber-border)", borderRadius: "var(--r)", padding: "8px 12px", color: "var(--amber-ink)" }}>
            + Make sure this template gives a clear way out (e.g. “Reply STOP to unsubscribe”). When someone replies STOP they’re blacklisted automatically and never messaged again.
          </div>
        </div>

        <div className="card">
          <div style={{ display: "flex", justifyContent: "space-between", fontSize: 14 }}>
            <span style={{ color: "var(--ink-2)" }}>Recipients</span><b>{numbers.length}</b>
          </div>
          <div style={{ display: "flex", justifyContent: "space-between", fontSize: 14, marginTop: 6 }}>
            <span style={{ color: "var(--ink-2)" }}>Est. cost floor (Twilio fee)</span><b>${estUsd.toFixed(2)}</b>
          </div>
          <div className="hint">Plus Meta marketing rate per message (country-specific). Outside the 24h window, template sending is required - which this uses.</div>
        </div>

        {err && <div className="err-box">{err}</div>}
        {doneMsg && <div className="ok-box">{doneMsg}</div>}

        {progress && (
          <div style={{ marginTop: 14, marginBottom: 14 }}>
            <div className="prog-bar" style={{ width: "100%", height: 8 }}>
              <div className="prog-fill" style={{ width: `${(progress.done / progress.total) * 100}%` }} />
            </div>
            <div className="hint">
              {progress.done}/{progress.total} processed · {progress.sent} {mode === "now" ? "queued" : "scheduled"} · {progress.skipped} skipped · {progress.failed} failed
            </div>
          </div>
        )}

        <button onClick={run} disabled={running} className="btn btn-primary" style={{ marginTop: 16 }}>
          {running ? "Working…" : mode === "now" ? "Send campaign" : mode === "later" ? "Schedule campaign" : "Start drip campaign"}
        </button>

        {doneMsg && (
          <div style={{ marginTop: 16, display: "flex", alignItems: "center", gap: 14, flexWrap: "wrap" }}>
            <Link href="/campaigns/history" className="card-link">View campaign log →</Link>
            {redirectIn !== null && redirectIn > 0 && (
              <span className="hint" style={{ margin: 0 }}>
                Taking you to the log in {redirectIn}s ·{" "}
                <button
                  type="button"
                  onClick={() => setRedirectIn(null)}
                  style={{ background: "none", border: "none", padding: 0, color: "var(--brand, #2563eb)", cursor: "pointer", textDecoration: "underline", font: "inherit" }}
                >
                  stay here
                </button>
              </span>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function humanInterval(min: number) {
  if (min % 60 === 0) { const h = min / 60; return `${h} hour${h === 1 ? "" : "s"}`; }
  return `${min} min`;
}
function renderLabel(tpl: Tpl | undefined, vars: Record<string, string>) {
  let s = tpl?.body || (tpl ? `[${tpl.name}]` : "");
  for (const [k, v] of Object.entries(vars)) s = s.replace(new RegExp(`\\{\\{${k}\\}\\}`, "g"), v || `{{${k}}}`);
  return s;
}
// Parsed-CSV preview as a real table (phone + columns), so the user sees a clean
// grid instead of raw comma text. Caps the visible rows to keep the box compact;
// every row is scrollable. A column header shows →{{n}} when it feeds a template
// variable, so personalization wiring is visible at a glance.
function RecipientTable({ records, valueCols, tplVars }: { records: any[]; valueCols: string[]; tplVars: string[] }) {
  const cap = 100;
  const shown = records.slice(0, cap);
  const nicely = (s: string) => s.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
  const cellTd: React.CSSProperties = { whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", maxWidth: 220 };
  return (
    <div className="panel" style={{ marginTop: 12, borderTop: "1px solid var(--border)", borderRadius: "var(--r-lg)" }}>
      <div style={{ maxHeight: 320, overflow: "auto" }}>
        <table className="ttable">
          <thead>
            <tr>
              <th style={{ width: 34, textAlign: "right", color: "var(--muted)" }}>#</th>
              <th>Phone</th>
              {valueCols.map((c, i) => (
                <th key={c}>
                  {nicely(c)}
                  {tplVars[i] && <span style={{ marginLeft: 6, color: "var(--green-ink)", fontWeight: 600, textTransform: "none", letterSpacing: 0 }}>{`→{{${tplVars[i]}}}`}</span>}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {shown.map((r, i) => (
              <tr key={i} className="norow">
                <td style={{ ...cellTd, textAlign: "right", color: "var(--muted)", fontVariantNumeric: "tabular-nums" }}>{i + 1}</td>
                <td className="mono" style={{ ...cellTd, color: "var(--ink-2)" }}>+{String(r.phone).replace(/[^0-9]/g, "")}</td>
                {valueCols.map((c) => <td key={c} style={cellTd} title={r[c] || ""}>{r[c] || <span style={{ color: "var(--muted)" }}>—</span>}</td>)}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div style={{ padding: "8px 16px", background: "var(--surface-2)", borderTop: "1px solid var(--border)", fontSize: 12, color: "var(--ink-2)", display: "flex", justifyContent: "space-between", gap: 8, flexWrap: "wrap" }}>
        <span><b style={{ color: "var(--green-ink)" }}>{records.length}</b> recipient{records.length === 1 ? "" : "s"}{valueCols.length > 0 && <> · {valueCols.length} column{valueCols.length === 1 ? "" : "s"}</>}</span>
        {records.length > cap && <span>showing first {cap}</span>}
      </div>
    </div>
  );
}
