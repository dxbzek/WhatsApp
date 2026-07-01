import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase";
import { sendWhatsApp } from "@/lib/twilio";
import { verifyTwilioWebhook } from "@/lib/twilioSignature";
import { distributeLead } from "@/lib/distribution";
import { handleAgentReport } from "@/lib/agentReport";

const ok200 = () => new NextResponse("<Response></Response>", { headers: { "Content-Type": "text/xml" } });

// Postgres unique-violation error code (via PostgREST). We rely on the UNIQUE
// partial index on messages.twilio_sid (lib/migration_bugfixes.sql) so a Twilio
// webhook RETRY that re-inserts the same MessageSid fails here instead of
// double-processing (double auto-reply / double lead distribution).
const isDupeInsert = (error: any) => error?.code === "23505";

// Twilio posts incoming WhatsApp here (form-encoded).
// NOTE: only switch Twilio's inbound webhook to this once you retire Ulgebra inbound.
export async function POST(req: NextRequest) {
  const form = await req.formData();
  const params: Record<string, string> = {};
  for (const [k, v] of form.entries()) params[k] = String(v);

  // Reject forged webhooks (only enforced once TWILIO_ENFORCE_SIGNATURE=1).
  if (!verifyTwilioWebhook(req, params).allow) return new NextResponse("Forbidden", { status: 403 });

  const from = String(form.get("From") || "").replace("whatsapp:", "");
  // The ERE number that RECEIVED this message (utility vs marketing lane). Auto-replies
  // must go back out FROM this same number/lane, else a marketing contact would get a
  // reply from the utility number (wrong identity, and it fails outside its 24h window).
  const toNumber = String(form.get("To") || "").replace("whatsapp:", "");
  const body = String(form.get("Body") || "");
  const sid = String(form.get("MessageSid") || "");
  // Present when the inbound is a quick-reply BUTTON tap on one of our messages —
  // lets us correlate an agent's bare status ("Contacted") to the exact lead alert.
  const originalSid = String(form.get("OriginalRepliedMessageSid") || "").trim() || null;
  const profileName = String(form.get("ProfileName") || "").trim(); // WhatsApp display name
  const numMedia = parseInt(String(form.get("NumMedia") || "0"), 10) || 0;
  const mediaUrl = numMedia > 0 ? String(form.get("MediaUrl0") || "") : "";
  const phone = from.replace("+", "");
  const displayBody = body || (mediaUrl ? "[media]" : "");
  const db = supabaseAdmin();

  // Idempotency: Twilio retries on any slow/non-2xx response. If we've already
  // logged this MessageSid, ack and stop so we don't duplicate the message or
  // re-fire the auto-reply / lead distribution. This is a fast-path check; the
  // UNIQUE index + insert-error check below is the real guarantee under a race.
  if (sid) {
    const { data: dupe } = await db.from("messages").select("id").eq("twilio_sid", sid).maybeSingle();
    if (dupe) return ok200();
  } else {
    // No MessageSid means we cannot dedupe this inbound — process it, but warn so
    // a flood of duplicates is visible in the logs.
    // eslint-disable-next-line no-console
    console.warn("[twilio-inbound] missing MessageSid; cannot dedupe this inbound");
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
      if (aconv) {
        const { error: insErr } = await db.from("messages").insert({ conversation: aconv.id, direction: "in", body: displayBody, status: "received", twilio_sid: sid || null, media_url: mediaUrl || null });
        // A unique violation means this exact webhook already ran (Twilio retry) —
        // stop before re-processing the agent status report.
        if (isDupeInsert(insErr)) return ok200();
      }
      // Pass the replied-to alert SID so a button tap maps to the exact lead.
      try { await handleAgentReport(from, body, originalSid); } catch { /* never fail the webhook */ }
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
  const { error: mainInsErr } = await db.from("messages").insert({
    conversation: conv!.id, direction: "in", body: displayBody, status: "received", twilio_sid: sid || null, media_url: mediaUrl || null,
  });
  // Duplicate webhook (Twilio retry raced past the fast-path check above): the
  // UNIQUE twilio_sid index rejects the second insert. Ack and STOP before the
  // auto-reply / lead distribution so we never fire those twice.
  if (isDupeInsert(mainInsErr)) return ok200();
  // mark the conversation unread + last message inbound. `replied` is a sticky
  // flag (never unset) so the inbox Replied tab shows everyone who has ever
  // written back, even after we answer them and the last message flips outbound.
  await db.from("conversations").update({
    unread: true, last_direction: "in", last_status: "received",
    replied: true, last_inbound_at: new Date().toISOString(),
  }).eq("id", conv!.id);

  // Strip trailing punctuation/whitespace so "Blocked!" / "Not interested." match.
  const text = body.trim().toLowerCase().replace(/[\s!.?,]+$/, "");

  // Button / keyword auto-reply rules (set per-button when creating a template).
  // Fetched once: used both to detect buying intent and to send the matched reply.
  let rules: any[] = [];
  try {
    const { data } = await db.from("auto_replies").select("*").eq("enabled", true);
    rules = data || [];
  } catch { /* never fail the inbound webhook */ }
  const rule = rules.find((r: any) => (r.trigger || "").trim().toLowerCase() === text);

  // Hard opt-out only. "Stop"/Unsubscribe and explicit "do not contact me" replies
  // suppress the contact so we never message them again. A soft decline like the
  // template's "Not Interested" button (or "No thanks") does NOT block: it just
  // declines this offer. The never-resend guard already stops us re-sending the
  // same template, so a "Not Interested" contact stays reachable for other things.
  // EXACT match only, so "not interested in selling, but buying" is never caught.
  const OPT_OUT = ["stop", "unsubscribe", "unsub", "cancel", "stop promotions", "opt out", "optout", "remove me", "remove", "blocked", "block", "block me", "do not contact", "dont contact", "leave me alone"];
  const isOptOut = OPT_OUT.includes(text);
  // #9: a CLEAR opt-out — an exact opt-out phrase, or one used as the FIRST token
  // (e.g. "stop messaging me") — must always suppress and can NEVER be rescued by
  // the buying-intent heuristic below. WhatsApp/Meta treat ignoring a clear "stop"
  // as a serious violation, so an unambiguous opt-out wins outright.
  const firstToken = text.split(/\s+/)[0] || "";
  const STANDALONE_OPT_OUT = ["stop", "unsubscribe", "unsub", "optout", "remove", "blocked", "block"];
  const isHardOptOut = isOptOut || STANDALONE_OPT_OUT.includes(firstToken);

  // Buying-intent detection. Twilio delivers each quick-reply tap as its OWN
  // inbound webhook, so a contact who taps "Send me photos" AND "Stop
  // promotions" seconds apart reaches us as two unrelated calls — and the
  // opt-out would otherwise silently suppress a warm lead (this lost Basheer KP,
  // Jun 2026: tapped Stop + "Send me photos" + "What is the land area", got the
  // goodbye). An intent signal is a converting button (a push_pipedrive rule) or
  // a concrete buying question. We look back a short window so the order of the
  // taps does not matter.
  const INTENT_WINDOW_MS = 60 * 60 * 1000;
  const intentTriggers = new Set(
    rules.filter((r: any) => r.push_pipedrive && !r.block).map((r: any) => (r.trigger || "").trim().toLowerCase())
  );
  const INTENT_KEYWORDS = ["photo", "viewing", "land area", "price", "how much", "floor plan", "brochure", "sqft", "square f", "payment plan"];
  const looksLikeIntent = (s: string) => {
    const t = (s || "").trim().toLowerCase().replace(/[\s!.?,]+$/, "");
    if (!t || OPT_OUT.includes(t)) return false;
    return intentTriggers.has(t) || INTENT_KEYWORDS.some((k) => t.includes(k));
  };
  const recentIntent = async () => {
    const since = new Date(Date.now() - INTENT_WINDOW_MS).toISOString();
    const { data } = await db.from("messages").select("body")
      .eq("conversation", conv!.id).eq("direction", "in").gte("created_at", since);
    return (data || []).some((m: any) => looksLikeIntent(m.body));
  };

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
  let flaggedConflict = false; // opt-out + buying intent in one session -> human, not silent suppress

  // Decide suppression. A hard opt-out keyword or a block rule wants to suppress.
  // But if the same contact also showed buying intent in the window, DON'T
  // suppress — surface them as a hot lead for a human and skip the goodbye.
  const wantsBlock = isOptOut || !!(rule && rule.block);
  if (wantsBlock) {
    // A hard/standalone opt-out is never rescued by buying intent (#9): suppress.
    if (!isHardOptOut && await recentIntent()) {
      flaggedConflict = true;
      leadHot = true;
      // Keep them open + unread so they sit in the Hot tab for a human to read.
      await db.from("conversations").update({ status: "open", unread: true }).eq("id", conv!.id);
    } else {
      // Clear unread too: a suppression isn't an actionable inbox item (it moves
      // to Suppressed), so it must not leave a stuck unread that inflates the badge.
      await db.from("conversations").update({ status: "blocked", unread: false, suppressed_at: new Date().toISOString() }).eq("id", conv!.id);
    }
  }

  // Matched-rule reply + hot routing.
  if (rule) {
    // A button wired as an interest signal (e.g. "Interested", "Book a
    // viewing") marks the lead hot.
    if (rule.push_pipedrive && !rule.block) leadHot = true;
    // Send the rule's auto-reply, EXCEPT the opt-out goodbye when we flagged a
    // conflict — we must not tell an interested lead we have removed them.
    if (rule.reply && !(rule.block && flaggedConflict)) {
      try {
        const tw = await sendWhatsApp(from, rule.reply, toNumber || undefined);
        await db.from("messages").insert({ conversation: conv!.id, direction: "out", body: rule.reply, status: tw.status, twilio_sid: tw.sid });
        await db.from("conversations").update({ last_direction: "out", last_status: tw.status, last_body: rule.reply }).eq("id", conv!.id);
      } catch { /* 24h window may be closed; ignore */ }
    }
  }

  // Reverse order: a buying-intent message arriving right after an opt-out
  // already suppressed the conversation. Un-suppress and flag for a human.
  if (!wantsBlock && !isHardOptOut && looksLikeIntent(body)) {
    const { data: c } = await db.from("conversations").select("status, suppressed_at").eq("id", conv!.id).maybeSingle();
    const recentlySuppressed = c?.suppressed_at && (Date.now() - new Date(c.suppressed_at).getTime() < INTENT_WINDOW_MS);
    if (c?.status === "blocked" && recentlySuppressed) {
      flaggedConflict = true;
      leadHot = true;
      await db.from("conversations").update({ status: "open", unread: true, suppressed_at: null }).eq("id", conv!.id);
    }
  }

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
