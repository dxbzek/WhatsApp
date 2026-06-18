import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Create a campaign row before sending starts, so it shows in the log
// immediately (and messages can link to it). Returns { id }.
// POST { name, templateSid, templateName, sender, mode, total, finishAt?, agentIds?, distribution? }
export async function POST(req: NextRequest) {
  try {
    const b = await req.json();
    const agentIds = Array.isArray(b.agentIds) ? b.agentIds.filter((x: any) => typeof x === "string") : [];
    const { data, error } = await supabaseAdmin()
      .from("campaigns")
      .insert({
        name: b.name || b.templateName || "Campaign",
        template_sid: b.templateSid || null,
        template_name: b.templateName || null,
        sender: b.sender || null,
        mode: b.mode || "now",
        total: b.total || 0,
        status: b.mode === "now" ? "sending" : "scheduled",
        finish_at: b.finishAt || null,
        agent_ids: agentIds,
        distribution: b.distribution === "all" ? "all" : "round_robin",
        blurb: typeof b.blurb === "string" && b.blurb.trim() ? b.blurb.trim() : null,
      })
      .select("id")
      .single();
    if (error) throw error;
    return NextResponse.json({ id: data.id });
  } catch (e: any) {
    return NextResponse.json({ error: e.message || "Failed to create campaign" }, { status: 500 });
  }
}
