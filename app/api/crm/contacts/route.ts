import { NextRequest, NextResponse } from "next/server";
import { crmContacts } from "@/lib/crm";
import { isAdminRequest } from "@/lib/auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

// POST { filters: {community?, nationality?, unit_type?, building?, tier?}, limit }
// -> { count, recipients:[{phone,name,community,building,unit_number,...}], phones }
// (contactable only: has phone, not do-not-call, not uncontactable, not a switchboard)
export async function POST(req: NextRequest) {
  try {
    // #14: pulling raw contact rows (phone numbers) is admin-only. Defaults to
    // allow under the single shared login; restrict via ADMIN_EMAILS if set.
    if (!(await isAdminRequest(req))) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    const { filters, limit } = await req.json();
    const recipients = await crmContacts(filters || {}, limit || 500);
    return NextResponse.json({ count: recipients.length, recipients, phones: recipients.map((r: any) => r.phone) });
  } catch (e: any) {
    return NextResponse.json({ error: e.message || "Failed to load contacts" }, { status: 500 });
  }
}
