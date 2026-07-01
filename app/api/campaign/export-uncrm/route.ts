import { NextRequest, NextResponse } from "next/server";
import { crmContactByPhone } from "@/lib/crm";
import { appendRows, sheetsConfigured } from "@/lib/sheets";
import { isAdminRequest } from "@/lib/auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

// After a campaign finishes, find every recipient that is NOT in the Audience
// CRM and append them to the "not in CRM" Google Sheet, with where they came
// from. These are the people to add to the CRM (pasted numbers, new repliers).
// POST { campaignId?, campaignName?, mode?: "manual"|"crm", phones: string[], sentAt?: string }
export async function POST(req: NextRequest) {
  try {
    // #14: exporting contact data is admin-only. Defaults to allow under the
    // single shared login; restrict via ADMIN_EMAILS when multi-user is added.
    if (!(await isAdminRequest(req))) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    const { campaignName, mode, phones, sentAt } = await req.json();
    if (!Array.isArray(phones) || phones.length === 0)
      return NextResponse.json({ error: "phones required" }, { status: 400 });

    // Dedupe to digit-only keys so we don't double-check / double-log a number.
    const seen = new Set<string>();
    const unique = phones
      .map((p: string) => ({ raw: String(p), key: String(p).replace(/[^0-9]/g, "") }))
      .filter((p) => p.key && !seen.has(p.key) && seen.add(p.key));

    // Check each against the CRM with limited concurrency (the lookup is an
    // indexed equality, but 50 sequential round-trips would be slow).
    const notInCrm: { phone: string }[] = [];
    const POOL = 6;
    for (let i = 0; i < unique.length; i += POOL) {
      const slice = unique.slice(i, i + POOL);
      const matches = await Promise.all(
        slice.map((p) => crmContactByPhone(p.key).catch(() => null))
      );
      matches.forEach((m, j) => {
        if (!m) notInCrm.push({ phone: slice[j].raw.startsWith("+") ? slice[j].raw : `+${slice[j].key}` });
      });
    }

    let logged = false;
    if (notInCrm.length && sheetsConfigured()) {
      const enteredVia = mode === "crm" ? "From CRM segment" : "Paste / CSV";
      const date = (sentAt || new Date().toISOString()).slice(0, 10);
      const rows = notInCrm.map((r) => [
        r.phone,
        "",                       // Name (unknown - not in CRM yet)
        enteredVia,               // How it entered
        campaignName || "",       // Campaign
        date,                     // Date
        "No",                     // Replied?
      ]);
      logged = await appendRows(rows);
    }

    return NextResponse.json({
      checked: unique.length,
      notInCrm: notInCrm.length,
      logged,
      phones: notInCrm.map((r) => r.phone),
    });
  } catch (e: any) {
    return NextResponse.json({ error: e.message || "Export failed" }, { status: 500 });
  }
}
