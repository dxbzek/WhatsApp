import { NextRequest, NextResponse } from "next/server";
import { ingestMetaLead } from "@/lib/leadIngest";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Ingests Meta Instant Lead Form submissions and routes them to an agent.
//
// Wiring: a Meta Lead Ads -> Webhook bridge (Zapier / Make "Facebook Lead Ads"
// trigger -> POST here) maps the form fields onto the JSON below. We do NOT talk
// to the Meta Graph API directly, so there is no page token to manage.
//
// Secured by LEAD_INGEST_SECRET (sent as the x-lead-secret header, or ?key=).
//
// Accepted JSON (all optional, many aliases tolerated):
//   { name|full_name|first_name+last_name, phone|phone_number|mobile, email,
//     ref|listing_ref|code,                 // the listing/ad code, e.g. CAYAN-BH
//     ad_name|campaign_name|form_name|detail } // used for routing + context
//
// On success: upserts the conversation as a hot lead, logs the lead in-thread,
// and round-robins it to the listing's agent pool (lead_routes). Returns the
// assigned agent name(s).
export async function POST(req: NextRequest) {
  // Auth: require the shared secret so only our Zapier/Make bridge can post leads.
  const secret = (process.env.LEAD_INGEST_SECRET || "").trim();
  if (!secret) return NextResponse.json({ error: "LEAD_INGEST_SECRET not configured" }, { status: 503 });
  const provided = req.headers.get("x-lead-secret") || new URL(req.url).searchParams.get("key") || "";
  if (provided !== secret) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  let b: any = {};
  try { b = await req.json(); } catch { return NextResponse.json({ error: "Invalid JSON" }, { status: 400 }); }
  const pick = (...keys: string[]) => {
    for (const k of keys) {
      const v = b?.[k];
      if (typeof v === "string" && v.trim()) return v.trim();
    }
    return "";
  };

  const name =
    pick("name", "full_name", "fullName", "lead_name") ||
    [pick("first_name", "firstName"), pick("last_name", "lastName")].filter(Boolean).join(" ").trim();
  const rawPhone = pick("phone", "phone_number", "phoneNumber", "mobile", "wa_phone", "whatsapp");
  const email = pick("email", "email_address");
  const ref = pick("ref", "listing_ref", "listingRef", "code", "listing_code");
  const detail =
    pick("detail") ||
    [pick("ad_name", "adName"), pick("campaign_name", "campaignName"), pick("form_name", "formName")]
      .filter(Boolean)
      .join(" · ");
  // The specific ad set / property the lead enquired about, shown in the agent alert.
  const listing = pick("listing", "adset_name", "adsetName", "ad_set_name", "ad_name", "adName");

  // Hand off to the shared ingest (same path the meta-leads cron uses): normalises
  // the phone, upserts the hot lead, routes it, and logs a lead_events row.
  const res = await ingestMetaLead({ name, phone: rawPhone, email, ref, detail, listing });
  if (!res.ok) {
    const status = res.error === "Missing or invalid phone" ? 400 : 500;
    return NextResponse.json({ error: res.error || "Ingest failed" }, { status });
  }
  return NextResponse.json({
    ok: true,
    conversationId: res.conversationId,
    status: res.status,
    assigned: res.assigned,
    routed: res.status === "routed",
    alert: res.alert,
  });
}
