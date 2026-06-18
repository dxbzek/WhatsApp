import { NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// List active agents for the campaign lead-distribution picker.
export async function GET() {
  try {
    const { data, error } = await supabaseAdmin()
      .from("agents")
      .select("id, name, wa_number, active")
      .eq("active", true)
      .order("name");
    if (error) throw error;
    return NextResponse.json({ agents: data || [] });
  } catch (e: any) {
    return NextResponse.json({ error: e.message || "Failed to load agents" }, { status: 500 });
  }
}
