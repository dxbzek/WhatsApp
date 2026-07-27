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
//   LEAD_ALERT_CC   comma-separated always-copied addresses (default marketing@erehomes.ae)
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
  return (process.env.LEAD_ALERT_CC || "marketing@erehomes.ae")
    .split(",").map((s) => s.trim()).filter(Boolean);
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
