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
// Config (Vercel env, mirrored in the gitignored .env.leadmail.local):
//   LEAD_SMTP_HOST  smtp.gmail.com
//   LEAD_SMTP_PORT  465
//   LEAD_SMTP_USER  marketing@erehomes.ae
//   LEAD_SMTP_PASS  Google App Password (Sensitive)
//   LEAD_ALERT_CC   copied on NEW-lead alerts (default marketing@erehomes.ae)
//   DAILY_REPORT_TO end-of-day report recipients (default marketing@ + matthew@)
//   NUDGE_ALERT_CC  copied on NUDGES: stale digest, outcome ask, escalation
//                   (default matthew@erehomes.ae — the sales manager, NOT marketing@)
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
// var. Chasing agents is the sales manager's job, so the default here is MATTHEW, not
// marketing@ — set NUDGE_ALERT_CC in Vercel to change or clear it (same
// comma/semicolon/newline splitting as LEAD_ALERT_CC; set it to " " for nobody).
function nudgeCcList(): string[] {
  return (process.env.NUDGE_ALERT_CC || "matthew@erehomes.ae")
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
  date: string;                 // "29 Jul 2026"
  newLeads: number;             // real enquiries that arrived in the last 24h
  newPooled?: number;           // deals created into the telesales pool/batch, NOT enquiries
  qualified: number;            // moved to Qualified or beyond in the last 24h
  lost?: number;                // moved to Closed Lost in the last 24h
  awaitingFirst: number;        // open, inside the window, nobody has completed an activity
  awaitingOutcome: number;      // open, inside the window, called at least once, still not moved on
  uncalledToday?: number;       // of today's new leads, how many still have no call logged
  perAgent: {
    name: string;
    waiting: number;            // open, never called, inside the window
    oldestHours: number | null;
    newToday?: number;
    uncalledToday?: number;
    calledOpen?: number;
    progressed?: number;
    lost?: number;
  }[];
  olderBacklog?: number;        // uncalled leads older than the window (legacy telesales)
  windowDays?: number;          // how far back "waiting" counts
};

export async function emailDailyReport(i: DailyReportInput): Promise<{ sent: string[]; error: string | null }> {
  // marketing@ (this is its ONE daily mail) plus the sales manager, who acts on the
  // per-agent list. Override with DAILY_REPORT_TO; falls back to LEAD_ALERT_CC's
  // marketing inbox if that env is ever set to something empty.
  const to = (process.env.DAILY_REPORT_TO || "marketing@erehomes.ae, matthew@erehomes.ae")
    .split(/[,;\s]+/).map((s) => s.trim()).filter(Boolean);
  if (to.length === 0) to.push(...ccList());
  if (to.length === 0) return { sent: [], error: "no recipient" };

  const host = process.env.LEAD_SMTP_HOST || "smtp.gmail.com";
  const port = Number(process.env.LEAD_SMTP_PORT || 465);
  const user = process.env.LEAD_SMTP_USER || "marketing@erehomes.ae";
  const pass = process.env.LEAD_SMTP_PASS || "";
  if (!pass) return { sent: [], error: "LEAD_SMTP_PASS not set" };

  const win = i.windowDays || 14;
  const age = (h: number | null) => (!h ? "—" : h < 48 ? `${Math.round(h)}h` : `${Math.round(h / 24)}d`);
  const n = (v?: number) => (v ? String(v) : `<span style="color:#c8c8c8">0</span>`);

  // ONE table, one row per rep — the sales-manager view. Two tiers of column: what happened
  // today (in / forward / lost) and what is stuck (never called, oldest, called-still-open),
  // so a glance down the "never called" column names who to talk to.
  const th = (t: string, align = "left", sub = "") =>
    `<th align="${align}" style="padding:0 0 9px 10px;font-size:11px;letter-spacing:.06em;text-transform:uppercase;color:#8a8a8a;font-weight:400;border-bottom:1px solid #dcdcdc;vertical-align:bottom">` +
    `${esc(t)}${sub ? `<div style="font-size:10px;letter-spacing:0;text-transform:none;color:#b0b0b0">${esc(sub)}</div>` : ""}</th>`;
  const td = (v: string, align = "right", extra = "") =>
    `<td align="${align}" style="padding:10px 0 10px 10px;font-size:15px;color:#111;border-bottom:1px solid #f0f0f0;${extra}">${v}</td>`;

  // Red only where it means "act on this": leads nobody has called. Everything else stays
  // neutral so the one colour on the page keeps its meaning.
  const agentRows = i.perAgent.map((a) =>
    `<tr>${td(esc(a.name), "left", "white-space:nowrap")}` +
    td(n(a.newToday)) +
    td(n(a.progressed)) +
    td(n(a.lost)) +
    td(a.waiting ? `<strong style="color:#b4462a">${a.waiting}</strong>` : n(0)) +
    td(`<span style="font-size:14px;color:#6b6b6b">${esc(age(a.oldestHours))}</span>`) +
    td(n(a.calledOpen)) +
    `</tr>`).join("");

  const sum = (k: "newToday" | "progressed" | "lost" | "calledOpen") =>
    i.perAgent.reduce((t, a) => t + (a[k] || 0), 0);
  const totalRow = `<tr>` +
    `<td style="padding:10px 0 0 10px;font-size:14px;color:#6b6b6b">Total</td>` +
    [sum("newToday"), sum("progressed"), sum("lost"), i.awaitingFirst, "", sum("calledOpen")]
      .map((v) => `<td align="right" style="padding:10px 0 0 10px;font-size:14px;color:#6b6b6b">${v}</td>`).join("") +
    `</tr>`;

  // The one line a head of sales reads first: today's leads that nobody has phoned.
  const headline = i.uncalledToday
    ? `${i.uncalledToday} of today's ${i.newLeads} new leads still have no call logged.`
    : i.newLeads
      ? `Every one of today's ${i.newLeads} new leads has a call logged.`
      : `No new enquiries in the last 24 hours.`;

  const html = `<div style="font-family:-apple-system,Segoe UI,Helvetica,Arial,sans-serif;max-width:660px;margin:0 auto;padding:28px 24px;color:#111">
<p style="margin:0 0 4px;font-size:11px;letter-spacing:.1em;text-transform:uppercase;color:#8a8a8a">End of day</p>
<h1 style="margin:0 0 6px;font-size:24px;font-weight:600">Leads — ${esc(i.date)}</h1>
<p style="margin:0 0 22px;font-size:15px;color:${i.uncalledToday ? "#b4462a" : "#444"}">${esc(headline)}</p>

<div style="overflow-x:auto">
<table style="border-collapse:collapse;width:100%;min-width:520px">
<tr>${th("Owner")}${th("In", "right", "today")}${th("Forward", "right", "today")}${th("Lost", "right", "today")}${th("Never called", "right", `open, ${win}d`)}${th("Oldest", "right", "of those")}${th("Called, open", "right", `${win}d`)}</tr>
${agentRows || `<tr><td colspan="7" style="padding:14px 0;font-size:15px;color:#444">No activity to report.</td></tr>`}
${agentRows ? totalRow : ""}
</table>
</div>

<p style="margin:22px 0 0;font-size:13px;color:#6b6b6b;line-height:1.55">
<strong style="color:#111">Never called</strong> is an open deal in New Lead, No Answer or Contact made with no completed activity on it. Stage alone is not the test: a card can be dragged to No Answer without anyone dialling, so this reads the activity log.<br>
<strong style="color:#111">Forward</strong> means it reached Qualified or beyond today.
${i.newPooled ? `<br>${i.newPooled} more deals were created into the telesales pool today. That is allocation, not enquiries, so it is not in the In column.` : ""}
${i.olderBacklog ? `<br>A further ${i.olderBacklog} uncalled leads are older than ${win} days, mostly legacy telesales rows. Excluded so the daily numbers stay actionable.` : ""}
</p>
<p style="margin:16px 0 0;font-size:12px;color:#8a8a8a;border-top:1px solid #e6e6e6;padding-top:12px">
Live from Pipedrive. Owners are chased directly by email; this is the summary only.</p></div>`;

  const pad = (s: string, w: number) => s.length >= w ? s.slice(0, w) : s + " ".repeat(w - s.length);
  const lpad = (s: string, w: number) => s.length >= w ? s : " ".repeat(w - s.length) + s;
  const text = [
    `Leads — ${i.date} (live from Pipedrive)`, "", headline, "",
    `${pad("Owner", 20)}${lpad("In", 4)}${lpad("Fwd", 5)}${lpad("Lost", 6)}${lpad("Uncalled", 10)}${lpad("Oldest", 8)}${lpad("Open", 6)}`,
    ...(i.perAgent.length
      ? i.perAgent.map((a) => pad(a.name, 20) + lpad(String(a.newToday || 0), 4) + lpad(String(a.progressed || 0), 5) +
        lpad(String(a.lost || 0), 6) + lpad(String(a.waiting), 10) + lpad(age(a.oldestHours), 8) + lpad(String(a.calledOpen || 0), 6))
      : ["  no activity to report"]),
    pad("Total", 20) + lpad(String(sum("newToday")), 4) + lpad(String(sum("progressed")), 5) +
      lpad(String(sum("lost")), 6) + lpad(String(i.awaitingFirst), 10) + lpad("", 8) + lpad(String(sum("calledOpen")), 6),
    "",
    `Never called = open in New Lead / No Answer / Contact made with no completed activity.`,
    `Forward = reached Qualified or beyond today.`,
    ...(i.newPooled ? [`${i.newPooled} more deals were created into the telesales pool today (allocation, not enquiries).`] : []),
    ...(i.olderBacklog ? [`A further ${i.olderBacklog} uncalled leads are older than ${win} days, excluded above.`] : []),
  ].join("\n");

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
  const cc = ccList().filter((a) => !to.includes(a));
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
