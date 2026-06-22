import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase";
import { pingAgent } from "@/lib/distribution";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

// A lead is "stale" once it's been assigned to an agent for this long with no
// status update logged (stage still null = never actioned/reported). On a phone
// the agent owns we can't see if they actually replied, so this also doubles as
// a nudge to self-report.
const STALE_HOURS = 2;
const CAP = 40; // most we nudge per run, so a backlog can't blow the 60s wall

// Nudge agents sitting on un-actioned leads. Claims assigned-but-unmoved leads
// older than STALE_HOURS that we haven't nudged yet, pings the owning agent's
// WhatsApp, and stamps stale_alerted_at so each lead is nudged once. Secured by
// CRON_SECRET (pg_cron passes it as a header), same as the dispatch cron.
async function run(req: NextRequest) {
  const secret = process.env.CRON_SECRET;
  if (!secret) return NextResponse.json({ error: "CRON_SECRET not configured" }, { status: 503 });
  const provided = req.headers.get("x-cron-secret") || new URL(req.url).searchParams.get("key") || "";
  if (provided !== secret) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const db = supabaseAdmin();
  const cutoff = new Date(Date.now() - STALE_HOURS * 3600_000).toISOString();

  const { data: stale, error } = await db
    .from("conversations")
    .select("id, name, wa_phone, assigned_agent_id, assigned_at")
    .not("assigned_agent_id", "is", null)
    .is("lead_stage", null)
    .eq("is_internal", false)
    .eq("lead_status", "hot")
    .not("status", "in", "(blocked,invalid)")
    .is("stale_alerted_at", null)
    .lt("assigned_at", cutoff)
    .order("assigned_at", { ascending: true })
    .limit(CAP);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  if (!stale || stale.length === 0) return NextResponse.json({ ok: true, nudged: 0 });

  // Resolve the owning agents' WhatsApp numbers in one read.
  const ids = Array.from(new Set(stale.map((c) => c.assigned_agent_id))) as string[];
  const { data: agents } = await db.from("agents").select("id, name, wa_number").in("id", ids);
  const byId = new Map((agents || []).map((a: any) => [a.id, a]));

  let nudged = 0;
  for (const c of stale) {
    const agent = byId.get(c.assigned_agent_id as string);
    if (!agent?.wa_number) continue;
    const hrs = c.assigned_at ? Math.max(1, Math.round((Date.now() - new Date(c.assigned_at).getTime()) / 3600_000)) : STALE_HOURS;
    const leadName = c.name && c.name !== ("+" + c.wa_phone) ? c.name : "New contact";
    const about = `REMINDER: assigned to you ~${hrs}h ago, still no update. Reach out now, then reply here with a status: contacted, viewing, won or lost.`;
    const ok = await pingAgent(agent.wa_number, leadName, "+" + c.wa_phone, about);
    // Stamp regardless so we don't re-nudge in a tight loop; if the send truly
    // failed the lead still surfaces as stale on the board.
    await db.from("conversations").update({ stale_alerted_at: new Date().toISOString() }).eq("id", c.id);
    if (ok) nudged++;
  }
  return NextResponse.json({ ok: true, nudged, scanned: stale.length });
}

export async function GET(req: NextRequest) { return run(req); }
export async function POST(req: NextRequest) { return run(req); }
