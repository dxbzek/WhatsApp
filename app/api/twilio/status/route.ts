import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase";
import { verifyTwilioWebhook } from "@/lib/twilioSignature";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Error codes that mean the number is permanently unusable on WhatsApp
// (not a marketing throttle). We suppress these so campaigns skip them.
const INVALID_NUMBER_CODES = ["63024", "63003", "21211", "21614"];

// Forward-only delivery ladder. Twilio callbacks aren't guaranteed in order, so
// a late/duplicate "sent" must never overwrite a later "delivered"/"read".
const RANK: Record<string, number> = { queued: 1, accepted: 1, sending: 1, sent: 2, delivered: 3, read: 4 };

// Twilio StatusCallback - fires as an outbound message moves through
// queued -> sent -> delivered -> read (or failed/undelivered).
// Reachable from Twilio via the Vercel automation-bypass query param.
export async function POST(req: NextRequest) {
  try {
    const form = await req.formData();
    const params: Record<string, string> = {};
    for (const [k, v] of form.entries()) params[k] = String(v);
    if (!verifyTwilioWebhook(req, params).allow) return new NextResponse("Forbidden", { status: 403 });

    const sid = String(form.get("MessageSid") || form.get("SmsSid") || "");
    const status = String(form.get("MessageStatus") || form.get("SmsStatus") || "");
    const errorCode = String(form.get("ErrorCode") || "");
    if (sid && status) {
      const db = supabaseAdmin();

      // Agent lead-alerts are sent straight via Twilio (not logged in `messages`),
      // so reconcile their TRUE delivery onto lead_events here. This is what makes
      // alert_delivery honest: "delivered"/"read" vs "undelivered" + the error code
      // (e.g. 63049 marketing throttle), instead of the optimistic "sent" attempt.
      {
        const { data: le } = await db.from("lead_events").select("id, alert_delivery").eq("alert_sid", sid).maybeSingle();
        if (le) {
          const isFail = status === "undelivered" || status === "failed";
          const newRank = RANK[status] ?? 0;
          const curRank = RANK[(le as any).alert_delivery || ""] ?? 0;
          const apply = isFail ? curRank < 3 : newRank >= curRank;
          if (apply) {
            await db.from("lead_events").update({ alert_delivery: status, alert_error: errorCode || null }).eq("id", (le as any).id);
          }
        }
      }

      const { data: cur } = await db.from("messages").select("id, status, conversation").eq("twilio_sid", sid).maybeSingle();
      if (cur) {
        const isFail = status === "undelivered" || status === "failed";
        const newRank = RANK[status] ?? 0;
        const curRank = RANK[(cur as any).status || ""] ?? 0;
        // Apply success states only if they move forward; apply a failure only if
        // the message hasn't already reached the handset (delivered/read).
        const apply = isFail ? curRank < 3 : newRank >= curRank;
        if (apply) {
          await db.from("messages").update({ status, error_code: errorCode || null }).eq("id", (cur as any).id);
          if ((cur as any).conversation) {
            await db.from("conversations").update({ last_status: status, last_direction: "out" }).eq("id", (cur as any).conversation);
            // Auto-suppress dead WhatsApp numbers (don't override an opt-out block).
            if (isFail && INVALID_NUMBER_CODES.includes(errorCode)) {
              await db.from("conversations").update({ status: "invalid" }).eq("id", (cur as any).conversation).neq("status", "blocked");
            }
          }
        }
      }
    }
  } catch {
    // never fail the callback - Twilio would just retry
  }
  return new NextResponse(null, { status: 204 });
}
