import nodemailer from "nodemailer";

// Email lead alerts.
//
// Meta permanently disabled the ERE Management WhatsApp portfolio on 27 Jul 2026, killing
// BOTH lanes (marketing +16592207300 and utility +18316535898) and with them every agent
// lead alert. Leads still arrive at ~8-10/day and still become Pipedrive deals; nobody was
// being told. Email is the replacement notification channel.
//
// Deliberately its own module and not a branch inside distribution.ts: WhatsApp alerting is
// template-shaped (approved SIDs, 5 numbered vars, no newlines) and email is not. Keeping
// them apart means the WhatsApp path can stay exactly as it is for the day a lane comes back.
//
// Config (Vercel env, mirrored in the gitignored Credentials/.env.leadmail.local):
//   LEAD_SMTP_HOST  smtp.gmail.com
//   LEAD_SMTP_PORT  465
//   LEAD_SMTP_USER  marketing@erehomes.ae
//   LEAD_SMTP_PASS  Google App Password (Sensitive)
//   LEAD_ALERT_CC   copied on NEW-lead alerts (default marketing@erehomes.ae)
//   DAILY_REPORT_TO end-of-day report recipients (default marketing@ only)
//   NUDGE_ALERT_CC  copied on NUDGES: stale digest, outcome ask, escalation
//                   (default EMPTY — nobody is copied)
//
// With LEAD_SMTP_PASS unset this module sends NOTHING and says so in its return value. It
// never pretends to have sent, and it never throws into a lead webhook: a failed alert must
// not cost us the lead itself.

export type LeadEmailRecipient = { name: string; email?: string | null };

export type LeadEmailInput = {
  channel: string;              // "Meta" | "Website" | "WhatsApp" | "Recruitment"
  recipients: LeadEmailRecipient[];
  leadName: string;
  leadPhone: string | null;     // null on a website enquiry that left only an email
  leadEmail?: string | null;
  leadRef?: string | null;      // customer-facing lead ref, when we have one
  enquiry?: string | null;      // what they asked about: listing, campaign, answers
  message?: string | null;      // free-text the lead typed (website forms)
  page?: string | null;         // the page they submitted from (website forms)
  adUrl?: string | null;        // permalink to the exact ad creative (Meta)
  replyUrl?: string | null;     // erehomes.ae/r.php one-tap opener
};

export type LeadEmailResult = {
  sent: string[];
  skipped: string[];            // recipient names with no mailbox on file
  error: string | null;         // null when it actually sent
};

function ccList(): string[] {
  // Commas, semicolons or newlines — Vercel's env editor is a textarea, so one address
  // per line is how these actually get typed. Comma-only splitting silently produces a
  // single malformed recipient and the mail reaches nobody.
  return (process.env.LEAD_ALERT_CC || "marketing@erehomes.ae")
    .split(/[,;\s]+/).map((s) => s.trim()).filter(Boolean);
}

// Who gets copied on NUDGES (stale digest, outcome ask, escalation) — a different
// question from who gets copied on a NEW lead, which is what LEAD_ALERT_CC answers.
// Carrying LEAD_ALERT_CC onto every chase put a copy of every agent's nudge into
// marketing@, the inbox Zek reads: ~180 mails on 29 Jul 2026. So this has its OWN env
// var, and it defaults to NOBODY: chasing is the sales manager's job, and Zek asked on
// 29 Jul 2026 not to copy Matthew for now. Set NUDGE_ALERT_CC in Vercel to copy someone
// (same comma/semicolon/newline splitting as LEAD_ALERT_CC).
function nudgeCcList(): string[] {
  return (process.env.NUDGE_ALERT_CC || "")
    .split(/[,;\s]+/).map((s) => s.trim()).filter(Boolean);
}

// Who gets copied on a NEW-lead alert that DID reach an agent. Defaults to NOBODY.
// Zek, 27 Aug 2026: one copy of every lead landing in marketing@ on top of two daily
// reports was too much mail — "this needs to be trimmed like in one report only". The
// leads still appear, by name, in the 17:30 daily report, so nothing is lost by not
// mailing them twice. Deliberately its OWN env var rather than blanking LEAD_ALERT_CC,
// which is still the fallback recipient for the chase list and the daily report.
//
// This does NOT apply when no agent has a mailbox: emailLeadAlert falls back to
// ccList() in that case, so an unroutable lead is still seen by a human rather than
// silently dropped.
function newLeadCcList(): string[] {
  return (process.env.NEW_LEAD_CC || "")
    .split(/[,;\s]+/).map((s) => s.trim()).filter(Boolean);
}

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

// Rows the agent actually acts on, in the order they act on them: who, how to reach
// them, what they want. Empty values are dropped rather than printed as "—" so the
// alert never pads itself with blanks (see the never-render-sample-data rule).
function rows(i: LeadEmailInput): [string, string][] {
  const out: [string, string][] = [
    ["Name", i.leadName],
    ["Phone", i.leadPhone || ""],
  ];
  if (i.leadEmail) out.push(["Email", i.leadEmail]);
  if (i.enquiry) out.push(["Enquiry", i.enquiry]);
  if (i.message) out.push(["Message", i.message]);
  if (i.page) out.push(["Page", i.page]);
  out.push(["Source", i.channel]);
  if (i.leadRef) out.push(["Ref", i.leadRef]);
  return out.filter(([, v]) => String(v || "").trim() !== "");
}

function textBody(i: LeadEmailInput, to: string[]): string {
  const lines = rows(i).map(([k, v]) => `${k}: ${v}`);
  const digits = (i.leadPhone || "").replace(/[^0-9]/g, "");
  if (digits.length >= 8) {
    lines.push("", `WhatsApp: ${i.replyUrl || `https://wa.me/${digits}`}`);
    lines.push(`Call: tel:${i.leadPhone}`);
  }
  lines.push("", `Assigned to: ${to.join(", ") || "unassigned"}`);
  lines.push("This lead is already in Pipedrive. Log the outcome there.");
  return lines.join("\n");
}

function htmlBody(i: LeadEmailInput, to: string[]): string {
  const digits = (i.leadPhone || "").replace(/[^0-9]/g, "");
  const tr = rows(i).map(([k, v]) =>
    `<tr><td style="padding:6px 16px 6px 0;color:#6b6b6b;font-size:13px;white-space:nowrap;vertical-align:top">${esc(k)}</td>` +
    `<td style="padding:6px 0;color:#111;font-size:15px">${esc(String(v))}</td></tr>`).join("");
  const btn = (href: string, label: string) =>
    `<a href="${esc(href)}" style="display:inline-block;padding:11px 20px;margin:0 8px 8px 0;background:#111;color:#fff;` +
    `text-decoration:none;border-radius:4px;font-size:14px">${esc(label)}</a>`;
  const actions = [
    digits.length >= 8 ? btn(i.replyUrl || `https://wa.me/${digits}`, "WhatsApp them") : "",
    i.leadPhone ? btn(`tel:${i.leadPhone}`, "Call") : "",
    i.adUrl && i.adUrl.startsWith("https://") ? btn(i.adUrl, "See the ad") : "",
  ].filter(Boolean).join("");
  return `<div style="font-family:-apple-system,Segoe UI,Helvetica,Arial,sans-serif;max-width:560px;margin:0 auto;padding:24px">
<p style="margin:0 0 4px;font-size:12px;letter-spacing:.08em;text-transform:uppercase;color:#8a8a8a">${esc(i.channel)} lead</p>
<h1 style="margin:0 0 20px;font-size:22px;font-weight:600;color:#111">${esc(i.leadName)}</h1>
<table style="border-collapse:collapse;width:100%;margin-bottom:20px">${tr}</table>
<div style="margin-bottom:20px">${actions}</div>
<p style="margin:0;font-size:13px;color:#6b6b6b;border-top:1px solid #e6e6e6;padding-top:14px">
Assigned to ${esc(to.join(", ") || "nobody yet")}. Already in Pipedrive — log the outcome there.</p>
</div>`;
}

// ---------------------------------------------------------------------------
// Agent nudges: "you contacted this lead, what happened?" and the manager
// escalation when they don't answer.
//
// Both used to be WhatsApp-only, so both have been DEAD since Meta disabled the
// portfolio on 27 Jul 2026 — and worse than dead: lead-watch bails on a null SID
// (`if (!sid) continue`), so every due lead was re-checked forever and nobody was
// ever chased. This gives them the same email path the first alert already has.
export type NudgeKind = "stale" | "outcome" | "escalation";

export type NudgeInput = {
  kind: NudgeKind;
  to: string[];                 // resolved mailboxes
  agentName: string;            // who owns the lead
  leadName: string;
  leadPhone: string;
  leadRef?: string | null;
  contactedAt?: string | null;  // outcome nudge only
  managerName?: string | null;  // escalation only
};

// ---------------------------------------------------------------------------
// Batched nudges: ONE email per agent per sweep, not one per lead.
//
// 29 Jul 2026: flipping STALE_REMINDERS on swept a 231-lead backlog and sent an
// individual email for every one, each CC'd to marketing@ — ~180 mails into Zek's
// inbox in an afternoon, and the per-lead card carried only name/phone/owner/ref,
// so none of them said what the lead actually wanted. Batching fixes both: an agent
// gets one "4 leads waiting on you" mail listing every lead with its source, what
// it came from, how long it has sat, and one-tap WhatsApp/call links.
export type DigestLead = {
  name: string;
  phone: string;
  ref?: string | null;
  source?: string | null;       // Meta / Website / WhatsApp
  detail?: string | null;       // campaign, listing or route it came from
  message?: string | null;      // last thing the lead said
  waitingHours?: number | null;
  dealId?: string | null;       // Pipedrive deal, when the lead has one
};

export type DigestInput = {
  kind: "stale" | "escalation";
  to: string[];
  agentName: string;            // whose leads these are
  managerName?: string | null;  // escalation only
  leads: DigestLead[];
};

function waitLabel(h?: number | null): string {
  if (!h || h < 1) return "";
  if (h < 48) return `${Math.round(h)}h`;
  return `${Math.round(h / 24)}d`;
}

// One lead per block: headline row (name · waiting), then only the facts that exist,
// then the two actions. Blank fields are dropped rather than printed as "—".
function digestLeadHtml(l: DigestLead): string {
  const digits = (l.phone || "").replace(/[^0-9]/g, "");
  const meta = [l.source, l.detail].filter(Boolean).join(" · ");
  const wait = waitLabel(l.waitingHours);
  const line = (label: string, value: string) =>
    `<div style="font-size:13px;color:#6b6b6b;margin-top:2px">${esc(label)} ${esc(value)}</div>`;
  const link = (href: string, label: string) =>
    `<a href="${esc(href)}" style="font-size:13px;color:#111;text-decoration:underline;margin-right:14px">${esc(label)}</a>`;
  return `<div style="padding:14px 0;border-top:1px solid #ececec">
<div style="font-size:16px;color:#111;font-weight:600">${esc(l.name)}${wait ? `<span style="font-weight:400;color:#8a8a8a;font-size:13px"> · waiting ${esc(wait)}</span>` : ""}</div>
${l.phone ? line("", l.phone) : ""}
${meta ? line("", meta) : ""}
${l.message ? line("Said:", String(l.message).slice(0, 140)) : ""}
${l.ref ? line("Ref", l.ref) : ""}
<div style="margin-top:8px">${[
    digits.length >= 8 ? link(`https://wa.me/${digits}`, "WhatsApp") : "",
    l.phone ? link(`tel:${l.phone}`, "Call") : "",
    l.dealId ? link(`https://erehomesrealestatebrokers.pipedrive.com/deal/${l.dealId}`, "Open in Pipedrive") : "",
  ].filter(Boolean).join("")}</div>
</div>`;
}

export async function emailAgentLeadDigest(i: DigestInput): Promise<{ sent: string[]; error: string | null }> {
  if (i.leads.length === 0) return { sent: [], error: "no leads" };
  const cc = nudgeCcList().filter((a) => !i.to.includes(a));
  if (i.to.length === 0 && cc.length === 0) return { sent: [], error: "no recipient has an email address" };

  const host = process.env.LEAD_SMTP_HOST || "smtp.gmail.com";
  const port = Number(process.env.LEAD_SMTP_PORT || 465);
  const user = process.env.LEAD_SMTP_USER || "marketing@erehomes.ae";
  const pass = process.env.LEAD_SMTP_PASS || "";
  if (!pass) return { sent: [], error: "LEAD_SMTP_PASS not set" };

  const n = i.leads.length;
  const plural = n === 1 ? "lead" : "leads";
  const subject = i.kind === "stale"
    ? `${n} ${plural} waiting on you`
    : `${i.agentName} — ${n} ${plural} with no update`;
  const intro = i.kind === "stale"
    ? `These were assigned to you and still have no update logged. Call them, then log the outcome in Pipedrive.`
    : `${i.agentName} was asked for an outcome on these and has not answered. Reassign them or work them yourself.`;

  const html = `<div style="font-family:-apple-system,Segoe UI,Helvetica,Arial,sans-serif;max-width:600px;margin:0 auto;padding:24px">
<p style="margin:0 0 4px;font-size:12px;letter-spacing:.08em;text-transform:uppercase;color:#8a8a8a">${i.kind === "stale" ? "Not actioned yet" : "Escalation"}</p>
<h1 style="margin:0 0 12px;font-size:21px;font-weight:600;color:#111">${esc(String(n))} ${plural} waiting${i.kind === "escalation" ? ` on ${esc(i.agentName)}` : ""}</h1>
<p style="margin:0 0 6px;font-size:15px;color:#444">${esc(intro)}</p>
${i.leads.map(digestLeadHtml).join("")}
<p style="margin:18px 0 0;font-size:13px;color:#6b6b6b;border-top:1px solid #e6e6e6;padding-top:14px">
All of these are already in Pipedrive. You get this list once per lead, not on repeat.</p></div>`;

  const text = [intro, "", ...i.leads.map((l) => {
    const bits = [l.name, l.phone, [l.source, l.detail].filter(Boolean).join(" · "), waitLabel(l.waitingHours) ? `waiting ${waitLabel(l.waitingHours)}` : ""].filter(Boolean);
    return `- ${bits.join(" | ")}`;
  })].join("\n");

  try {
    const transport = nodemailer.createTransport({ host, port, secure: port === 465, auth: { user, pass } });
    await transport.sendMail({
      from: `ERE Homes Leads <${user}>`,
      to: i.to.length ? i.to : cc,
      cc: i.to.length && cc.length ? cc : undefined,
      subject,
      text,
      html,
    });
    return { sent: i.to.length ? i.to : cc, error: null };
  } catch (e: any) {
    return { sent: [], error: String(e?.message || e).slice(0, 200) };
  }
}

// ---------------------------------------------------------------------------
// End-of-day report to the marketing inbox.
//
// 29 Jul 2026: nudges stopped CCing marketing@ (they belong to the agent and their
// manager), so this is what marketing@ gets INSTEAD — one mail at 18:00 Dubai with
// the day's numbers and who is sitting on what. The old daily digest was WhatsApp-only
// and has therefore reached nobody since Meta disabled the portfolio on 27 Jul.
export type DailyReportInput = {
  date: string;                 // "29 Jul 2026", or "27 - 29 Jul 2026" for a range
  days?: number;                // how many days the period covers (1 = a single day)
  newLeads: number;             // real enquiries that arrived in the last 24h
  newPooled?: number;           // deals created into the telesales pool/batch, NOT enquiries
  qualified: number;            // moved to Qualified or beyond in the last 24h
  lost?: number;                // moved to Closed Lost in the last 24h
  awaitingFirst: number;        // open, inside the window, nobody has completed an activity
  awaitingOutcome: number;      // open, inside the window, called at least once, still not moved on
  uncalledToday?: number;       // of today's new leads, how many still have no call logged
  weekAvgNew?: number;          // new enquiries per day, averaged over the last 7 days
  callsToday?: number;          // completed call activities, whole team, today
  notesToday?: number;          // notes added, whole team, today
  activitiesToday?: number;     // all completed activities, last 24h
  speedMedianMins?: number | null;  // median minutes from lead created to first activity
  speedSampled?: number;        // how many of today's leads that median is based on
  sources?: { name: string; count: number }[];
  lostNoReason?: number;        // of today's Closed Lost, how many carry no reason
  perAgent: {
    name: string;
    waiting: number;            // open, never called, inside the window
    oldestHours: number | null;
    newToday?: number;
    uncalledToday?: number;
    calledOpen?: number;
    progressed?: number;
    lost?: number;
    calls?: number;
    otherActivities?: number;
    notes?: number;
    speedMins?: number | null;
  }[];
  olderBacklog?: number;        // uncalled leads older than the window (legacy telesales)
  windowDays?: number;          // how far back "waiting" counts
  // Open deals per stage, board order. Came from the separate telesales daily report,
  // folded in here 27 Aug 2026 when that second mail was switched off.
  board?: { stage: string; held: number }[];
};

// Rendering lives on its own so `scripts/send-daily-report-sample.ts --html` can write the
// EXACT email to a file for review. A separate preview renderer would drift from what the
// cron actually sends, which is the whole point of a preview.
export function renderDailyReport(i: DailyReportInput): { html: string; text: string } {
  const win = i.windowDays || 14;
  const age = (h: number | null) => (!h ? "—" : h < 48 ? `${Math.round(h)}h` : `${Math.round(h / 24)}d`);
  const n = (v?: number) => (v ? String(v) : `<span style="color:#c8c8c8">0</span>`);

  // House style is the ERE Daily Ad Report (01 - Scripts/ere_report_email.py): cream page,
  // 600px white card, dark header with a gold rule, Georgia stat tiles, dark table head.
  // Same palette and the same furniture, so the two daily emails read as one family.
  const DARK = "#1F1C17", GOLD = "#D2B583", INK = "#2B2722", MUTE = "#8A857C", LINE = "#E7E3DB", RED = "#B4462A";
  const A = "Arial,sans-serif";
  const mins = (m?: number | null) => (m === null || m === undefined ? "\u2014" : m < 90 ? `${m}m` : `${Math.round(m / 60)}h`);
  const vsWeek = i.weekAvgNew
    ? ` (7-day average ${i.weekAvgNew}${i.newLeads > i.weekAvgNew ? ", above" : i.newLeads < i.weekAvgNew ? ", below" : ""})`
    : "";

  const stat = (label: string, val: string, gold = false) =>
    `<td style="padding:14px 10px;text-align:center;border:1px solid ${LINE};background:#FBFAF7;">` +
    `<div style="font:700 22px/1.1 Georgia,serif;color:${gold ? GOLD : DARK};">${esc(val)}</div>` +
    `<div style="font:600 11px/1.4 ${A};color:${MUTE};text-transform:uppercase;letter-spacing:.06em;margin-top:5px;">${esc(label)}</div></td>`;

  const hd = (t: string, align = "center", gold = false) =>
    `<td style="padding:9px 8px;font:700 11px ${A};color:${gold ? GOLD : "#FFF"};text-align:${align};text-transform:uppercase;letter-spacing:.05em;">${esc(t)}</td>`;

  const dim = (v?: number) => (v ? String(v) : `<span style="color:#CFCAC1">0</span>`);

  const agentRows = i.perAgent.map((a, idx) => {
    const bg = idx % 2 === 0 ? "#FFFFFF" : "#FBFAF7";
    const cell = (v: string, align = "center", bold = false, color = INK, tint = false) =>
      `<td style="padding:11px 8px;border-bottom:1px solid ${LINE};font:${bold ? 700 : 400} ${bold ? 14 : 13}px ${A};color:${color};text-align:${align};white-space:nowrap;${tint ? "background:#FBFAF7;" : ""}">${v}</td>`;
    return `<tr style="background:${bg};">` +
      `<td style="padding:11px 10px 11px 12px;border-bottom:1px solid ${LINE};font:400 14px ${A};color:${INK};">${esc(a.name)}</td>` +
      cell(dim(a.newToday), "center", true, DARK) +
      cell(dim((a.calls || 0) + (a.notes || 0)), "center", true, DARK) +
      cell(dim(a.progressed), "center", true, DARK, true) +
      cell(dim(a.lost), "center", false, MUTE) +
      cell(a.waiting ? String(a.waiting) : dim(0), "center", true, a.waiting ? RED : INK, true) +
      cell(esc(age(a.oldestHours)), "right", false, MUTE) +
      `</tr>`;
  }).join("");

  const sum = (k: "newToday" | "progressed" | "lost" | "calledOpen" | "calls" | "notes") =>
    i.perAgent.reduce((t, a) => t + (a[k] || 0), 0);
  const tot = (v: string, tint = false) =>
    `<td style="padding:11px 8px;font:700 13px ${A};color:${DARK};text-align:center;${tint ? "background:#FBFAF7;" : ""}">${esc(v)}</td>`;
  const totalRow = `<tr style="border-top:2px solid ${DARK};">` +
    `<td style="padding:11px 10px 11px 12px;font:700 13px ${A};color:${DARK};">Total</td>` +
    tot(String(sum("newToday"))) + tot(String(sum("calls") + sum("notes"))) +
    tot(String(sum("progressed")), true) + tot(String(sum("lost"))) +
    tot(String(i.awaitingFirst), true) + `<td></td></tr>`;

  const sourceLine = (i.sources || []).map((s) => `${esc(s.name)} ${s.count}`).join(" &middot; ");

  // The board, from the telesales daily report this one absorbed on 27 Aug 2026. Empty
  // stages are dropped rather than printed as zeros: Closed Won and Closed Lost are
  // terminal, so an open-deal count for them is always 0 and says nothing.
  const boardRows = (i.board || []).filter((b) => b.held).map((b, idx) =>
    `<tr style="background:${idx % 2 === 0 ? "#FFFFFF" : "#FBFAF7"};">` +
    `<td style="padding:10px 12px;border-bottom:1px solid ${LINE};font:400 14px ${A};color:${INK};">${esc(b.stage)}</td>` +
    `<td style="padding:10px 12px;border-bottom:1px solid ${LINE};font:700 14px ${A};color:${DARK};text-align:right;">${b.held}</td></tr>`).join("");
  const worked = (i.callsToday || 0) + (i.notesToday || 0);

  // One sentence, worst true thing first. This line decides whether the rest gets read, so
  // it never opens with something reassuring that hides a problem.
  const headline = i.newLeads && i.speedSampled === 0
    ? `Nothing has been logged yet against any of the ${i.newLeads} new leads in this period.`
    : i.uncalledToday
      ? `${i.uncalledToday} of the ${i.newLeads} new leads in this period have not been touched.`
      : i.newLeads
        ? `Every one of the ${i.newLeads} new leads in this period has been actioned.`
        : `No new enquiries in this period.`;

  const html = `<!doctype html><html><body style="margin:0;padding:0;background:#EFEbE3;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#EFEbE3;padding:24px 12px;">
<tr><td align="center">
<table role="presentation" width="600" cellpadding="0" cellspacing="0" style="width:600px;max-width:100%;background:#FFFFFF;border-radius:10px;overflow:hidden;border:1px solid ${LINE};">
  <tr><td style="background:${DARK};padding:26px 30px;">
    <div style="font:700 20px/1 ${A};color:#FFFFFF;letter-spacing:.14em;">ERE <span style="color:${GOLD};">HOMES</span></div>
    <div style="font:600 12px/1.4 ${A};color:${GOLD};text-transform:uppercase;letter-spacing:.18em;margin-top:8px;">${(i.days || 1) > 1 ? "Lead Report" : "Daily Lead Report"}</div>
  </td></tr>
  <tr><td style="padding:24px 30px 6px;">
    <div style="font:400 13px ${A};color:${MUTE};">${esc(i.date)} &middot; Asia/Dubai</div>
    <div style="font:400 15px/1.5 ${A};color:${i.uncalledToday || i.speedSampled === 0 ? RED : INK};margin-top:8px;">${esc(headline)}</div>
  </td></tr>
  <tr><td style="padding:12px 30px 4px;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:separate;border-spacing:8px 8px;">
      <tr>${stat("New leads", String(i.newLeads))}${stat((i.days || 1) > 1 ? "Per day" : "7-day average", (i.days || 1) > 1 ? String(Math.round(i.newLeads / (i.days || 1))) : (i.weekAvgNew ? String(i.weekAvgNew) : "-"))}${stat("Calls & notes", String(worked))}</tr>
      <tr>${stat("Moved forward", String(i.qualified), true)}${stat("Closed lost", String(i.lost || 0))}${stat("Never touched", String(i.awaitingFirst), true)}</tr>
    </table>
  </td></tr>
  <tr><td style="padding:22px 30px 4px;">
    <div style="font:700 12px ${A};color:${DARK};text-transform:uppercase;letter-spacing:.1em;border-bottom:2px solid ${GOLD};padding-bottom:7px;">By owner</div>
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin-top:8px;border-collapse:collapse;">
      <tr style="background:${DARK};">
        <td style="padding:9px 10px 9px 12px;font:700 11px ${A};color:#FFF;text-transform:uppercase;letter-spacing:.05em;">Owner</td>
        ${hd("New")}${hd("Worked")}${hd("Forward", "center", true)}${hd("Lost")}${hd("Untouched", "center", true)}${hd("Oldest", "right")}</tr>
      ${agentRows || `<tr><td colspan="7" style="padding:14px 12px;font:400 14px ${A};color:${MUTE};">No activity today.</td></tr>`}
      ${agentRows ? totalRow : ""}
    </table>
  </td></tr>
  ${sourceLine ? `<tr><td style="padding:22px 30px 4px;">
    <div style="font:700 12px ${A};color:${DARK};text-transform:uppercase;letter-spacing:.1em;border-bottom:2px solid ${GOLD};padding-bottom:7px;">Where they came from</div>
    <div style="font:400 14px/1.7 ${A};color:${INK};margin-top:10px;">${sourceLine}</div>
  </td></tr>` : ""}
  ${boardRows ? `<tr><td style="padding:22px 30px 4px;">
    <div style="font:700 12px ${A};color:${DARK};text-transform:uppercase;letter-spacing:.1em;border-bottom:2px solid ${GOLD};padding-bottom:7px;">The board right now</div>
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin-top:8px;border-collapse:collapse;">
      <tr style="background:${DARK};">
        <td style="padding:9px 12px;font:700 11px ${A};color:#FFF;text-transform:uppercase;letter-spacing:.05em;">Stage</td>
        <td style="padding:9px 12px;font:700 11px ${A};color:${GOLD};text-transform:uppercase;letter-spacing:.05em;text-align:right;">Open deals</td></tr>
      ${boardRows}
    </table>
  </td></tr>` : ""}
  <tr><td style="padding:20px 30px 8px;">
    <div style="font:400 12px/1.7 ${A};color:${MUTE};">
      <strong style="color:${INK};">Worked</strong> = calls plus notes logged in this period. Some reps log a call, others write a note, so both count.<br>
      <strong style="color:${INK};">Untouched</strong> = open leads from the last ${win} days with nothing logged on them at all.
      ${i.newPooled ? `<br>${i.newPooled} deals went into the telesales pool in this period. That is allocation, not new enquiries.` : ""}
      ${i.lostNoReason ? `<br>${i.lostNoReason} of the ${i.lost || 0} closed lost have no lost reason recorded.` : ""}
      ${i.olderBacklog ? `<br>${i.olderBacklog} untouched leads are older than ${win} days and sit outside this report.` : ""}
    </div>
  </td></tr>
  <tr><td style="padding:18px 30px 28px;border-top:1px solid ${LINE};">
    <div style="font:400 11px/1.5 ${A};color:${MUTE};">Live from Pipedrive, every day at 18:00 Dubai.<br>ERE Homes Real Estate</div>
  </td></tr>
</table>
</td></tr></table>
</body></html>`;

  const pad = (s: string, w: number) => s.length >= w ? s.slice(0, w) : s + " ".repeat(w - s.length);
  const lpad = (s: string, w: number) => s.length >= w ? s : " ".repeat(w - s.length) + s;
  const text = [
    `Leads — ${i.date} (live from Pipedrive)`, "", headline,
    `${i.newLeads} in${vsWeek} · ${i.callsToday || 0} calls and ${i.notesToday || 0} notes logged · median first response ${i.speedSampled ? mins(i.speedMedianMins) : "not measurable, nothing logged"}`, "",
    `${pad("Owner", 20)}${lpad("In", 4)}${lpad("Calls", 7)}${lpad("1st", 6)}${lpad("Fwd", 5)}${lpad("Lost", 6)}${lpad("Uncalled", 10)}${lpad("Oldest", 8)}`,
    ...(i.perAgent.length
      ? i.perAgent.map((a) => pad(a.name, 20) + lpad(String(a.newToday || 0), 4) + lpad(String(a.calls || 0), 7) +
        lpad(mins(a.speedMins), 6) + lpad(String(a.progressed || 0), 5) + lpad(String(a.lost || 0), 6) +
        lpad(String(a.waiting), 10) + lpad(age(a.oldestHours), 8))
      : ["  no activity to report"]),
    pad("Total", 20) + lpad(String(sum("newToday")), 4) + lpad(String(sum("calls")), 7) +
      lpad(mins(i.speedMedianMins), 6) + lpad(String(sum("progressed")), 5) +
      lpad(String(sum("lost")), 6) + lpad(String(i.awaitingFirst), 10),
    "",
    ...(sourceLine ? [`Where today's ${i.newLeads} came from: ${sourceLine.replace(/<[^>]+>/g, "")}`, ""] : []),
    ...((i.board || []).some((b) => b.held)
      ? ["The board right now:",
         ...(i.board || []).filter((b) => b.held).map((b) => `  ${pad(b.stage, 20)}${lpad(String(b.held), 6)}`),
         ""]
      : []),
    `Never called = open in New Lead / No Answer / Contact made with no completed activity.`,
    `Calls and Notes are both counted: some reps log a call activity, others write a note. Both at 0 is the finding.`,
    `1st = median minutes from the lead landing to the first completed activity.`,
    `Forward = reached Qualified or beyond today.`,
    ...(i.lostNoReason ? [`${i.lostNoReason} of today's ${i.lost || 0} closed lost carry no lost reason.`] : []),
    ...(i.newPooled ? [`${i.newPooled} more deals were created into the telesales pool today (allocation, not enquiries).`] : []),
    ...(i.olderBacklog ? [`A further ${i.olderBacklog} uncalled leads are older than ${win} days, excluded above.`] : []),
  ].join("\n");

  return { html, text };
}

export function renderDailyReportHtml(i: DailyReportInput): string {
  return renderDailyReport(i).html;
}

export async function emailDailyReport(i: DailyReportInput): Promise<{ sent: string[]; error: string | null }> {
  // Everyone who used to get the separate telesales daily report, plus marketing@. This
  // is now the ONE daily mail: the telesales report (Supabase fn `telesales-daily-report`)
  // was switched off on 27 Aug 2026 and its board folded in above, so this list has to
  // carry its readers or the desk quietly loses a report it was using.
  //
  // Read from DAILY_REPORT_RECIPIENTS, deliberately a NEW env name. The old
  // DAILY_REPORT_TO is set on Vercel to marketing@ alone, and no Vercel API token exists
  // in this repo — editing the default under a name that already has a stored value would
  // have shipped a change that does nothing. Set DAILY_REPORT_RECIPIENTS to override.
  // The five below are the exact TELESALES_REPORT_TO list off the retired function
  // (see memory project_telesales_daily_report), NOT addresses guessed from a name:
  // Gmail's SMTP answers 250 to any @erehomes.ae recipient, real or not, so a guessed
  // address fails silently as an async bounce nobody reads.
  const to = (process.env.DAILY_REPORT_RECIPIENTS ||
      "marketing@erehomes.ae, telesales@erehomes.ae, matthew@erehomes.ae, zek@erehomes.ae, akf@erehomes.ae, kyle@erehomes.ae")
    .split(/[,;\s]+/).map((s) => s.trim()).filter(Boolean);
  if (to.length === 0) to.push(...ccList());
  if (to.length === 0) return { sent: [], error: "no recipient" };

  const host = process.env.LEAD_SMTP_HOST || "smtp.gmail.com";
  const port = Number(process.env.LEAD_SMTP_PORT || 465);
  const user = process.env.LEAD_SMTP_USER || "marketing@erehomes.ae";
  const pass = process.env.LEAD_SMTP_PASS || "";
  if (!pass) return { sent: [], error: "LEAD_SMTP_PASS not set" };

  const { html, text } = renderDailyReport(i);

  try {
    const transport = nodemailer.createTransport({ host, port, secure: port === 465, auth: { user, pass } });
    await transport.sendMail({ from: `ERE Homes Leads <${user}>`, to, subject: `Leads — ${i.date}`, text, html });
    return { sent: to, error: null };
  } catch (e: any) {
    return { sent: [], error: String(e?.message || e).slice(0, 200) };
  }
}

export async function emailAgentNudge(i: NudgeInput): Promise<{ sent: string[]; error: string | null }> {
  const cc = nudgeCcList().filter((a) => !i.to.includes(a));
  if (i.to.length === 0 && cc.length === 0) return { sent: [], error: "no recipient has an email address" };

  const host = process.env.LEAD_SMTP_HOST || "smtp.gmail.com";
  const port = Number(process.env.LEAD_SMTP_PORT || 465);
  const user = process.env.LEAD_SMTP_USER || "marketing@erehomes.ae";
  const pass = process.env.LEAD_SMTP_PASS || "";
  if (!pass) return { sent: [], error: "LEAD_SMTP_PASS not set" };

  const when = i.contactedAt
    ? new Date(i.contactedAt).toLocaleDateString("en-GB", { day: "numeric", month: "short", timeZone: "Asia/Dubai" })
    : "recently";
  const digits = (i.leadPhone || "").replace(/[^0-9]/g, "");

  const subject = i.kind === "stale"
    ? `${i.leadName} is still waiting`
    : i.kind === "outcome"
      ? `What happened with ${i.leadName}?`
      : `${i.agentName} has not updated ${i.leadName}`;
  const lead = i.kind === "stale"
    ? `${i.leadName} was assigned to you and there is still no update logged.`
    : i.kind === "outcome"
      ? `You contacted ${i.leadName} on ${when} and the outcome is still not logged.`
      : `${i.agentName} was asked twice for an outcome on ${i.leadName} and has not answered.`;
  const ask = i.kind === "escalation"
    ? "Reassign it or work it yourself. It is still sitting unresolved."
    : "Log the call in Pipedrive and move the stage, or close it with a lost reason.";

  const rowsHtml = ([
    ["Lead", i.leadName],
    ["Phone", i.leadPhone],
    ["Owner", i.agentName],
    ["Ref", i.leadRef || ""],
  ] as [string, string][])
    .filter(([, v]) => String(v).trim() !== "")
    .map(([k, v]) =>
      `<tr><td style="padding:6px 16px 6px 0;color:#6b6b6b;font-size:13px;white-space:nowrap">${esc(k)}</td>` +
      `<td style="padding:6px 0;color:#111;font-size:15px">${esc(v)}</td></tr>`).join("");

  const html = `<div style="font-family:-apple-system,Segoe UI,Helvetica,Arial,sans-serif;max-width:560px;margin:0 auto;padding:24px">
<p style="margin:0 0 4px;font-size:12px;letter-spacing:.08em;text-transform:uppercase;color:#8a8a8a">${i.kind === "stale" ? "Not actioned yet" : i.kind === "outcome" ? "Outcome needed" : "Escalation"}</p>
<h1 style="margin:0 0 14px;font-size:21px;font-weight:600;color:#111">${esc(i.leadName)}</h1>
<p style="margin:0 0 18px;font-size:15px;color:#444">${esc(lead)}</p>
<table style="border-collapse:collapse;width:100%;margin-bottom:18px">${rowsHtml}</table>
${digits.length >= 8 ? `<div style="margin-bottom:18px"><a href="https://wa.me/${digits}" style="display:inline-block;padding:11px 20px;margin-right:8px;background:#111;color:#fff;text-decoration:none;border-radius:4px;font-size:14px">WhatsApp them</a><a href="tel:${esc(i.leadPhone)}" style="display:inline-block;padding:11px 20px;background:#111;color:#fff;text-decoration:none;border-radius:4px;font-size:14px">Call</a></div>` : ""}
<p style="margin:0;font-size:13px;color:#6b6b6b;border-top:1px solid #e6e6e6;padding-top:14px">${esc(ask)}</p></div>`;

  const text = [lead, "", `Lead: ${i.leadName}`, `Phone: ${i.leadPhone}`, `Owner: ${i.agentName}`,
    i.leadRef ? `Ref: ${i.leadRef}` : "", "", ask].filter(Boolean).join("\n");

  try {
    const transport = nodemailer.createTransport({ host, port, secure: port === 465, auth: { user, pass } });
    await transport.sendMail({
      from: `ERE Homes Leads <${user}>`,
      to: i.to.length ? i.to : cc,
      cc: i.to.length ? cc : undefined,
      subject,
      text,
      html,
    });
    return { sent: i.to.length ? i.to : cc, error: null };
  } catch (e: any) {
    return { sent: [], error: String(e?.message || e).slice(0, 200) };
  }
}

export async function emailLeadAlert(i: LeadEmailInput): Promise<LeadEmailResult> {
  const to = i.recipients.map((r) => (r.email || "").trim()).filter(Boolean);
  const skipped = i.recipients.filter((r) => !(r.email || "").trim()).map((r) => r.name);
  // An alert that reached an agent copies nobody (see newLeadCcList). One that reached
  // NO agent still copies marketing@, or the lead would be sent to an empty recipient
  // list and lost with a cheerful "ok" — the exact silent-drop shape the honeypot bug had.
  const cc = (to.length ? newLeadCcList() : ccList()).filter((a) => !to.includes(a));
  if (to.length === 0 && cc.length === 0) {
    return { sent: [], skipped, error: "no recipient has an email address" };
  }

  const host = process.env.LEAD_SMTP_HOST || "smtp.gmail.com";
  const port = Number(process.env.LEAD_SMTP_PORT || 465);
  const user = process.env.LEAD_SMTP_USER || "marketing@erehomes.ae";
  const pass = process.env.LEAD_SMTP_PASS || "";
  if (!pass) return { sent: [], skipped, error: "LEAD_SMTP_PASS not set" };

  try {
    const transport = nodemailer.createTransport({ host, port, secure: port === 465, auth: { user, pass } });
    const names = i.recipients.map((r) => r.name).filter(Boolean).join(", ");
    await transport.sendMail({
      // From the real authenticated mailbox so SPF/DKIM align — the exact thing that
      // broke the site's old mail() alerts (see project_website_lead_alerts).
      from: `ERE Homes Leads <${user}>`,
      to: to.length ? to : cc,
      cc: to.length ? cc : undefined,
      // Replying goes to the lead, not to the marketing inbox.
      replyTo: i.leadEmail || undefined,
      subject: `New ${i.channel} lead — ${i.leadName}${i.leadPhone ? ` — ${i.leadPhone}` : ""}`,
      text: textBody(i, i.recipients.map((r) => r.name)),
      html: htmlBody(i, i.recipients.map((r) => r.name)),
      headers: names ? { "X-ERE-Assigned": names } : undefined,
    });
    return { sent: to.length ? to : cc, skipped, error: null };
  } catch (e: any) {
    return { sent: [], skipped, error: String(e?.message || e).slice(0, 200) };
  }
}
