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
  if (!arg) throw new Error("usage: npx tsx scripts/send-daily-report-sample.ts <email>|--dry");

  const report = await collectDailyReport();
  console.log(JSON.stringify(report, null, 2));
  if (arg === "--dry") return;

  process.env.DAILY_REPORT_TO = arg;
  const r = await emailDailyReport(report);
  console.log("sent:", r.sent.join(", ") || "(none)", "| error:", r.error);
  if (r.error) process.exit(1);
}

main().catch((e) => { console.error(String(e?.message || e)); process.exit(1); });
