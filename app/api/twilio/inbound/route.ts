import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase";
import { sendWhatsApp } from "@/lib/twilio";
import { verifyTwilioWebhook } from "@/lib/twilioSignature";
import { distributeLead } from "@/lib/distribution";
import { handleAgentReport } from "@/lib/agentReport";

const ok200 = () => new NextResponse("<Response></Response>", { headers: { "Content-Type": "text/xml" } });

// Twilio posts incoming WhatsApp here (form-encoded).
// NOTE: only switch Twilio's inbound webhook to this once you retire Ulgebra inbound.
export async function POST(req: NextRequest) {
  const form = await req.formData();
  const params: Record<string, string> = {};
  for (const [k, v] of form.entries()) params[k] = String(v);

  // Reject forged webhooks (only enforced once TWILIO_ENFORCE_SIGNATURE=1).
  if (!verifyTwilioWebhook(req, params).allow) return new NextResponse("Forbidden", { status: 403 });

  const from = String(form.get("From") || "").replace("whatsapp:", "");
  const body = String(form.get("Body") || "");
  const sid = String(form.get("MessageSid") || "");
  const profileName = String(form.get("ProfileName") || "").trim(); // WhatsApp display name
  const numMedia = parseInt(String(form.get("NumMedia") || "0"), 10) || 0;
  const mediaUrl = numMedia > 0 ? String(form.get("MediaUrl0") || "") : "";
  const phone = from.replace("+", "");
  const displayBody = body || (mediaUrl ? "[media]" : "");
  const db = supabaseAdmin();

  // Idempotency: Twilio retries on any slow/non-2xx response. If we've already
  // logged this MessageSid, ack and stop so we don't duplicate the message or
  // re-fire the auto-reply / Pipedrive lead push.
  if (sid) {
    const { data: dupe } = await db.from("messages").select("id").eq("twilio_sid", sid).maybeSingle();
    if (dupe) return ok200();
  }

  // Agent self-report branch: when one of OUR agents texts this number, it's a
  // status update on a lead they're working (their own WhatsApp chat with the
  // lead is invisible to us), NOT a new lead. Log it to the agent's INTERNAL
  // conversation (kept out of the inbox/lead views) for idempotency + record,
  // then let handleAgentReport move the lead's stage and confirm back.
  {
    const { data: agentRow } = await db.from("agents").select("id").eq("wa_number", from).maybeSingle();
    if (agentRow) {
      const { data: aconv } = await db.from("conversations").upsert(
        { wa_phone: phone, is_internal: true, last_body: displayBody, last_at: new Date().toISOString(), last_direction: "in", last_status: "received", ...(profileName ? { name: profileName } : {}) },
        { onConflict: "wa_phone" }
      ).select().single();
      if (aconv) await db.from("messages").insert({ conversation: aconv.id, direction: "in", body: displayBody, status: "received", twilio_sid: sid, media_url: mediaUrl || null });
      try { await handleAgentReport(from, body); } catch { /* never fail the webhook */ }
      return ok200();
    }
  }

  // upsert conversation + log inbound (capture WhatsApp profile name if present)
  const { data: conv } = await db
    .from("conversations")
    .upsert(
      { wa_phone: phone, last_body: displayBody, last_at: new Date().toISOString(), ...(profileName ? { name: profileName } : {}) },
      { onConflict: "wa_phone" }
    )
    .select()
    .single();
  await db.from("messages").insert({
    conversation: conv!.id, direction: "in", body: displayBody, status: "received", twilio_sid: sid, media_url: mediaUrl || null,
  });
  // mark the conversation unread + last message inbound. `replied` is a sticky
  // flag (never unset) so the inbox Replied tab shows everyone who has ever
  // written back, even after we answer them and the last message flips outbound.
  await db.from("conversations").update({
    unread: true, last_direction: "in", last_status: "received",
    replied: true, last_inbound_at: new Date().toISOString(),
  }).eq("id", conv!.id);

  // Strip trailing punctuation/whitespace so "Blocked!" / "Not interested." match.
  const text = body.trim().toLowerCase().replace(/[\s!.?,]+$/, "");

  // Hard opt-out only. "Stop"/Unsubscribe and explicit "do not contact me" replies
  // suppress the contact so we never message them again. A soft decline like the
  // template's "Not Interested" button (or "No thanks") does NOT block: it just
  // declines this offer. The never-resend guard already stops us re-sending the
  // same template, so a "Not Interested" contact stays reachable for other things.
  // EXACT match only, so "not interested in selling, but buying" is never caught.
  const OPT_OUT = ["stop", "unsubscribe", "unsub", "cancel", "stop promotions", "opt out", "optout", "remove me", "remove", "blocked", "block", "block me", "do not contact", "dont contact", "leave me alone"];
  const isOptOut = OPT_OUT.includes(text);
  // Clear unread too: a suppression isn't an actionable inbox item (it moves to
  // Suppressed), so it must not leave a stuck unread that inflates the badge.
  if (isOptOut) {
    await db.from("conversations").update({ status: "blocked", unread: false }).eq("id", conv!.id);
  }

  // A lead is HOT only when the contact TAPS one of our converting CTA buttons
  // ("I'm Interested", "What's my offer", "Free valuation", "Speak to an agent",
  // "Sell my property", "Rent it out for me", "Send me the details", "I want to
  // join", "MANAGE"). Those are deliberate interest signals. Free text — a
  // business auto-reply ("Thank you for contacting X"), "who is this", a wrong
  // number — is NOT a lead: it must not mark hot or ping an agent. The matching
  // converting-button rule below (push_pipedrive = true) flips this to true;
  // anything that isn't a converting tap stays false (still logged + visible in
  // the Replied tab for a human to read, just never auto-routed).
  let leadHot = false;

  // Button / keyword auto-reply rules (set per-button when creating a template).
  // Match the tapped button text or typed keyword to an enabled rule.
  try {
    const { data: rules } = await db.from("auto_replies").select("*").eq("enabled", true);
    const rule = (rules || []).find((r: any) => (r.trigger || "").trim().toLowerCase() === text);
    if (rule) {
      // A button wired as an interest signal (e.g. "Interested", "Book a
      // viewing") marks the lead hot.
      if (rule.push_pipedrive && !rule.block) leadHot = true;
      if (rule.block) {
        await db.from("conversations").update({ status: "blocked", unread: false, suppressed_at: new Date().toISOString() }).eq("id", conv!.id);
      }
      if (rule.reply) {
        try {
          const tw = await sendWhatsApp(from, rule.reply);
          await db.from("messages").insert({ conversation: conv!.id, direction: "out", body: rule.reply, status: tw.status, twilio_sid: tw.sid });
          await db.from("conversations").update({ last_direction: "out", last_status: tw.status, last_body: rule.reply }).eq("id", conv!.id);
        } catch { /* 24h window may be closed; ignore */ }
      }
    }
  } catch { /* never fail the inbound webhook */ }

  // Surface interested leads as hot so they sit in the inbox Hot tab (the lead
  // list), and route them to an agent. Hot is the top tier, so this only ever
  // upgrades — it never downgrades a manually-set status.
  if (leadHot) {
    try { await db.from("conversations").update({ lead_status: "hot" }).eq("id", conv!.id); } catch { /* non-fatal */ }

    // Auto-distribute: route this lead to one of the agents assigned to the
    // campaign it came from (WhatsApp alert with the lead's number + the
    // campaign heads-up). No-op when the campaign has no agents configured.
    try {
      await distributeLead({
        conversationId: conv!.id,
        contactPhone: from,
        contactName: profileName || undefined,
      });
    } catch { /* non-fatal */ }
  }

  // empty TwiML 200 so Twilio is happy
  return ok200();
}
