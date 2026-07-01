import { NextRequest, NextResponse } from "next/server";
import { crmCount } from "@/lib/crm";
import { isAdminRequest } from "@/lib/auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// POST { filters } -> { count } (approximate; planner estimate, fast)
export async function POST(req: NextRequest) {
  try {
    // #14: admin-only, consistent with the other CRM routes. Aggregate count only
    // (no PII), but gated the same way. Defaults to allow under the single login.
    if (!(await isAdminRequest(req))) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    const { filters } = await req.json();
    const count = await crmCount(filters || {});
    return NextResponse.json({ count });
  } catch (e: any) {
    return NextResponse.json({ error: e.message || "Failed to count" }, { status: 500 });
  }
}
