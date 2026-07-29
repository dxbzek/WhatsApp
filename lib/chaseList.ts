import nodemailer from "nodemailer";

// Daily chase list: leads sitting in Pipedrive with no call ever logged.
//
// Why this exists: on 27 Jul 2026 all 86 Meta-ad deals had ZERO completed activities,
// 32 had been in New Lead / No Answer for 3+ days, and all 21 Closed Lost carried no
// lost reason. Rent's CPQL was 504 AED against Commercial's 47 on the same ads and the
// same follow-up process — the gap was never the media buy. Nobody was ignoring a task;
// there was no task and no list. This is the list.
//
// Pairs with the call activity syncMetaLeadToPipedrive now creates on every new deal:
// that makes ONE lead visible to ONE agent, this makes the backlog visible every morning.
//
// Reuses the LEAD_SMTP_* config lib/leadEmail.ts already runs on. With LEAD_SMTP_PASS
// unset it sends nothing and says so — it never claims a send it did not make.

const CHASE_STAGES: Record<number, string> = { 6: "New Lead", 61: "No Answer", 7: "Contact made" };
const PD_DOMAIN = "erehomesrealestatebrokers.pipedrive.com";

// API VERSION MATTERS HERE. `api/v2/deals` does NOT return done_activities_count at all
// (verified 29 Jul 2026 — the key is simply absent), so a v2-based filter would read
// every deal as unworked and put already-called leads on the chase list. v1 returns
// activities_count / done_activities_count / undone_activities_count. Do not "modernise"
// this to v2 without replacing the signal.
const API = "v1/deals";

export type ChaseRow = {
  dealId: number;
  title: string;
  stage: string;
  ageHours: number;
  ownerName: string;
};

const clean = (v?: string | null) => (v || "").replace(/^﻿/, "").trim();

export async function pd(path: string, params: Record<string, string> = {}) {
  const token = clean(process.env.PIPEDRIVE_API_TOKEN);
  if (!token) throw new Error("pipedrive token missing");
  // Token via URLSearchParams, never interpolated — nothing thrown here can leak it.
  const qs = new URLSearchParams({ ...params, api_token: token });
  const res = await fetch(`https://api.pipedrive.com/${path}?${qs.toString()}`, { method: "GET" });
  const data: any = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`pipedrive GET ${path} -> ${res.status}`);
  return data;
}

// v1 add_time is "YYYY-MM-DD HH:MM:SS" in UTC with no timezone marker, so it needs the
// Z appended or the browser/node parses it as local and the ages come out 4h wrong.
function ageHours(addTime: string): number {
  const t = Date.parse(String(addTime || "").replace(" ", "T") + "Z");
  return Number.isFinite(t) ? (Date.now() - t) / 3600_000 : 0;
}

/**
 * Open deals in the chase stages that nobody has completed an activity on.
 *
 * `done_activities_count` is the honest signal. Stage alone lies: an agent can drag a
 * card to No Answer without ever dialling, which is most of what happened in July.
 *
 * Bounded by maxAgeDays on purpose. Stage 61 alone holds 100+ open deals, most of them
 * legacy telesales rows from months back; dumping those into a daily email makes it
 * unreadable and it stops being actioned. This is a chase list for live leads.
 */
export async function collectChaseRows(
  minAgeHours = 24,
  maxAgeDays = 14,
  cap = 60,
): Promise<{ rows: ChaseRow[]; scanned: number }> {
  const rows: ChaseRow[] = [];
  let scanned = 0;

  for (const stageId of Object.keys(CHASE_STAGES).map(Number)) {
    for (let start = 0; start < 500; start += 100) {
      const d: any = await pd(API, {
        stage_id: String(stageId),
        status: "open",
        limit: "100",
        start: String(start),
      });
      const batch: any[] = d?.data || [];
      scanned += batch.length;

      for (const deal of batch) {
        if ((deal.done_activities_count || 0) > 0) continue;
        const age = ageHours(deal.add_time);
        if (age < minAgeHours || age > maxAgeDays * 24) continue;
        rows.push({
          dealId: deal.id,
          title: clean(deal.title) || `Deal ${deal.id}`,
          stage: CHASE_STAGES[stageId],
          ageHours: Math.round(age),
          ownerName: clean(deal.user_id?.name) || "unassigned",
        });
      }

      // Trust the pagination flag, never an empty page: a full page with more_items
      // false is the last page, and stopping on length<100 alone would truncate.
      if (!d?.additional_data?.pagination?.more_items_in_collection) break;
    }
  }

  rows.sort((a, b) => b.ageHours - a.ageHours);
  return { rows: rows.slice(0, cap), scanned };
}

function esc(s: string): string {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function table(rows: ChaseRow[]): string {
  const th = (t: string) =>
    `<th align="left" style="padding:0 14px 8px 0;font-size:11px;letter-spacing:.08em;text-transform:uppercase;color:#8a8a8a">${t}</th>`;
  const tr = rows.map((r) =>
    `<tr>` +
    `<td style="padding:7px 14px 7px 0;font-size:14px;color:#111">${esc(r.title)}</td>` +
    `<td style="padding:7px 14px 7px 0;font-size:13px;color:#6b6b6b;white-space:nowrap">${esc(r.ownerName)}</td>` +
    `<td style="padding:7px 14px 7px 0;font-size:13px;color:#6b6b6b;white-space:nowrap">${esc(r.stage)}</td>` +
    `<td style="padding:7px 14px 7px 0;font-size:13px;color:#b4462a;white-space:nowrap">${r.ageHours}h</td>` +
    `<td style="padding:7px 0;font-size:13px"><a href="https://${PD_DOMAIN}/deal/${r.dealId}">open</a></td></tr>`).join("");
  return `<table style="border-collapse:collapse;width:100%">
<tr>${th("Lead")}${th("Owner")}${th("Stage")}${th("Waiting")}<th></th></tr>${tr}</table>`;
}

export async function sendChaseList(rows: ChaseRow[], to: string[]): Promise<{ sent: string[]; error: string | null }> {
  const host = process.env.LEAD_SMTP_HOST || "smtp.gmail.com";
  const port = Number(process.env.LEAD_SMTP_PORT || 465);
  const user = process.env.LEAD_SMTP_USER || "marketing@erehomes.ae";
  const pass = process.env.LEAD_SMTP_PASS || "";
  if (!pass) return { sent: [], error: "LEAD_SMTP_PASS not set" };
  if (to.length === 0) return { sent: [], error: "no recipients" };

  const oldest = rows.length ? Math.max(...rows.map((r) => r.ageHours)) : 0;
  const byOwner = new Map<string, number>();
  for (const r of rows) byOwner.set(r.ownerName, (byOwner.get(r.ownerName) || 0) + 1);
  const split = [...byOwner.entries()].sort((a, b) => b[1] - a[1])
    .map(([n, c]) => `${n} ${c}`).join(" · ");

  const html = `<div style="font-family:-apple-system,Segoe UI,Helvetica,Arial,sans-serif;max-width:680px;margin:0 auto;padding:24px">
<p style="margin:0 0 4px;font-size:12px;letter-spacing:.08em;text-transform:uppercase;color:#8a8a8a">Daily chase list</p>
<h1 style="margin:0 0 6px;font-size:22px;font-weight:600;color:#111">${rows.length} lead${rows.length === 1 ? "" : "s"} with no call logged</h1>
<p style="margin:0 0 4px;font-size:14px;color:#6b6b6b">Open, in New Lead / No Answer / Contact made, and nobody has completed an activity on them. Oldest has been waiting ${oldest} hours.</p>
<p style="margin:0 0 20px;font-size:13px;color:#8a8a8a">${esc(split)}</p>
${table(rows)}
<p style="margin:20px 0 0;font-size:13px;color:#6b6b6b;border-top:1px solid #e6e6e6;padding-top:14px">
Log the call in Pipedrive and the lead leaves this list. If it is dead, close it with a lost reason.</p></div>`;

  const text = [
    `${rows.length} leads with no call logged (oldest ${oldest}h)`,
    split,
    "",
    ...rows.map((r) => `${r.title} — ${r.ownerName} — ${r.stage} — ${r.ageHours}h — https://${PD_DOMAIN}/deal/${r.dealId}`),
    "",
    "Log the call in Pipedrive and the lead leaves this list. If it is dead, close it with a lost reason.",
  ].join("\n");

  try {
    const transport = nodemailer.createTransport({ host, port, secure: port === 465, auth: { user, pass } });
    await transport.sendMail({
      from: `ERE Homes Leads <${user}>`,
      to,
      subject: `Chase list — ${rows.length} lead${rows.length === 1 ? "" : "s"} with no call logged`,
      text,
      html,
    });
    return { sent: to, error: null };
  } catch (e: any) {
    return { sent: [], error: String(e?.message || e).slice(0, 200) };
  }
}
