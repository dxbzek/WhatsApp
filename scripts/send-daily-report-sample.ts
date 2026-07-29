// Send the REAL end-of-day report to one address, with TODAY's live Pipedrive numbers, so
// the format can be reviewed without waiting for 18:00 or mailing the whole list.
//
//   npx tsx scripts/send-daily-report-sample.ts you@erehomes.ae        # send it
//   npx tsx scripts/send-daily-report-sample.ts --dry                  # print, send nothing
//
// Needs PIPEDRIVE_API_TOKEN and (unless --dry) the LEAD_SMTP_* config. It calls the same
// collectDailyReport() + emailDailyReport() the 18:00 cron calls, so what lands in the
// inbox is what the cron sends — a hand-built copy would drift the moment either changes.
import { collectDailyReport } from "../lib/dailyReport";
import { emailDailyReport } from "../lib/leadEmail";

async function main() {
  const arg = process.argv[2];
  if (!arg) throw new Error("usage: npx tsx scripts/send-daily-report-sample.ts <email>|--dry|--html <path>");

  // Optional Dubai date range: --from 2026-07-27 --to 2026-07-29 (both inclusive).
  const flag = (k: string) => {
    const idx = process.argv.indexOf(k);
    return idx > -1 ? process.argv[idx + 1] : "";
  };
  const fromArg = flag("--from"), toArg = flag("--to");
  const range = fromArg
    ? {
      from: Date.parse(`${fromArg}T00:00:00+04:00`),
      // --to is INCLUSIVE, so the window runs to midnight at the END of that day.
      to: Date.parse(`${toArg || fromArg}T00:00:00+04:00`) + 86400_000,
    }
    : {};

  const report = await collectDailyReport(range);
  if (arg !== "--html") console.log(JSON.stringify(report, null, 2));

  // --html writes the exact email body to a file so the layout can be reviewed in a browser
  // without sending anything. Reuses the production renderer, so the file IS the email.
  if (arg === "--html") {
    const out = process.argv[3];
    if (!out) throw new Error("usage: --html <path>");
    const { renderDailyReportHtml } = await import("../lib/leadEmail");
    await (await import("node:fs/promises")).writeFile(out, renderDailyReportHtml(report), "utf8");
    console.log("wrote", out);
    return;
  }
  if (arg === "--dry") return;

  process.env.DAILY_REPORT_TO = arg;
  const r = await emailDailyReport(report);
  console.log("sent:", r.sent.join(", ") || "(none)", "| error:", r.error);
  if (r.error) process.exit(1);
}

main().catch((e) => { console.error(String(e?.message || e)); process.exit(1); });
