// Send the REAL end-of-day report to one address, with TODAY's live numbers, so the
// format can be reviewed without waiting for 18:00 or mailing the whole list.
//
//   npx tsx scripts/send-daily-report-sample.ts you@erehomes.ae
//
// Reads SMTP config from the environment (LEAD_SMTP_*), same as production. It calls
// the production emailDailyReport(), so what lands in the inbox is what the 18:00 cron
// sends — a hand-built copy of the HTML would drift the moment the template changes.
import { createClient } from "@supabase/supabase-js";
import { emailDailyReport } from "../lib/leadEmail";

const HIDDEN_ROUTE = "Recruitment";

async function main() {
  const to = process.argv[2];
  if (!to) throw new Error("usage: npx tsx scripts/send-daily-report-sample.ts <email>");
  process.env.DAILY_REPORT_TO = to;

  const url = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL || "";
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY || "";
  if (!url || !key) throw new Error("SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY not set");
  const db = createClient(url, key, { auth: { persistSession: false } });

  const since = new Date(Date.now() - 86400_000).toISOString();
  const count = async (build: (q: any) => any): Promise<number> => {
    const { count: n } = await build(db.from("lead_events").select("id", { count: "exact", head: true }));
    return n || 0;
  };
  const newLeads = await count((q) => q.gte("created_at", since));
  const qualified = await count((q) => q.eq("qualification", "qualified").gte("qualification_updated_at", since));
  const awaitingFirst = await count((q) => q.eq("qualification", "new"));
  const awaitingOutcome = await count((q) => q.eq("qualification", "contacted"));

  const { data: waiting } = await db
    .from("conversations")
    .select("assigned_agent_id, assigned_at")
    .not("assigned_agent_id", "is", null)
    .is("lead_stage", null)
    .eq("is_internal", false)
    .eq("lead_status", "hot")
    .not("status", "in", "(blocked,invalid,archived)")
    .or(`source_ref.is.null,source_ref.neq.${HIDDEN_ROUTE}`)
    .limit(2000);

  const ids = Array.from(new Set((waiting || []).map((c: any) => c.assigned_agent_id)));
  const { data: ags } = await db.from("agents").select("id, name").in("id", ids);
  const nameById = new Map((ags || []).map((a: any) => [a.id, a.name]));

  const byAgent = new Map<string, any[]>();
  for (const c of (waiting || []) as any[]) {
    const k = String(c.assigned_agent_id);
    if (!byAgent.has(k)) byAgent.set(k, []);
    byAgent.get(k)!.push(c);
  }
  const perAgent = [...byAgent].map(([id, rows]) => ({
    name: nameById.get(id) || "Unassigned",
    waiting: rows.length,
    oldestHours: rows.reduce((max: number | null, r: any) => {
      if (!r.assigned_at) return max;
      const h = (Date.now() - new Date(r.assigned_at).getTime()) / 3600_000;
      return max === null || h > max ? h : max;
    }, null as number | null),
  })).sort((a, b) => b.waiting - a.waiting);

  const date = new Date().toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "Asia/Dubai" });
  const r = await emailDailyReport({ date, newLeads, qualified, awaitingFirst, awaitingOutcome, perAgent });
  console.log("sent:", r.sent.join(", ") || "(none)", "| error:", r.error);
  if (r.error) process.exit(1);
}

main().catch((e) => { console.error(String(e?.message || e)); process.exit(1); });
