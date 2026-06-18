import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase";
import { distributeMetaLead } from "@/lib/distribution";

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

  // Normalise to E.164. Zapier should pass full international; we still cover a
  // bare UAE local number (leading 0) and a missing +.
  const e164 = normalizePhone(rawPhone);
  if (!e164) return NextResponse.json({ error: "Missing or invalid phone" }, { status: 400 });
  const bare = e164.replace("+", "");

  const db = supabaseAdmin();
  const leadName = name || "New contact";
  const preview = `New lead from Meta ad${detail ? ` — ${detail}` : ""}`;

  // Upsert the conversation as a hot lead, tagged with its Meta source.
  const { data: conv, error: convErr } = await db
    .from("conversations")
    .upsert(
      {
        wa_phone: bare,
        name: leadName,
        last_body: preview,
        last_at: new Date().toISOString(),
        unread: true,
        last_direction: "in",
        last_status: "received",
        last_inbound_at: new Date().toISOString(),
        replied: true,
        lead_status: "hot",
        source: "meta_lead_form",
        source_detail: detail || null,
      },
      { onConflict: "wa_phone" }
    )
    .select("id")
    .single();
  if (convErr || !conv) return NextResponse.json({ error: convErr?.message || "Upsert failed" }, { status: 500 });

  // Log the lead in-thread so the agent sees the context (and email) on open.
  const noteLines = [preview, email ? `Email: ${email}` : "", ref ? `Ref: ${ref}` : ""].filter(Boolean);
  await db.from("messages").insert({
    conversation: conv.id, direction: "in", body: noteLines.join("\n"), status: "received",
  });

  // Round-robin to the listing's agent pool and ping them with the Meta context.
  // Always returns an outcome (never throws) so we can track every lead.
  const dist = await distributeMetaLead({ contactPhone: e164, contactName: leadName, ref, detail });
  const alertStatus = dist.alertOk ? "sent" : dist.fallbackOk ? "fallback" : "none";

  // Denormalise the outcome onto the conversation for at-a-glance inbox context.
  await db.from("conversations").update({
    source_ref: dist.ref ?? (ref || null),
    assigned_agent: dist.assigned[0] ?? null,
    routing_status: dist.status,
  }).eq("id", conv.id);

  // Append a permanent lead-tracking row (never overwritten, unlike the chat).
  await db.from("lead_events").insert({
    conversation: conv.id,
    wa_phone: bare,
    name: leadName,
    ref: dist.ref ?? (ref || null),
    detail: detail || null,
    routing_status: dist.status,
    assigned_agent: dist.assigned[0] ?? null,
    alert_status: alertStatus,
  });

  return NextResponse.json({
    ok: true,
    conversationId: conv.id,
    status: dist.status,
    assigned: dist.assigned,
    routed: dist.status === "routed",
    alert: alertStatus,
  });
}

// Light E.164 normaliser. Keeps a leading +, strips other punctuation; maps a UAE
// local "05xxxxxxxx" to +9715xxxxxxxx; assumes a 9-15 digit string without + is
// already international and just needs the +.
function normalizePhone(raw: string): string | null {
  if (!raw) return null;
  let s = raw.replace(/[^\d+]/g, "");
  if (s.startsWith("00")) s = "+" + s.slice(2);
  if (s.startsWith("0") && s.length === 10) return "+971" + s.slice(1); // UAE local mobile
  if (!s.startsWith("+")) s = "+" + s;
  const digits = s.replace("+", "");
  if (digits.length < 8 || digits.length > 15) return null;
  return s;
}
