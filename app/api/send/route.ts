import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase";
import { sendWhatsApp, sendTemplate, sendMediaWhatsApp, getContentMedia, getContentBody, renderTemplateBody } from "@/lib/twilio";
import { logConversationToPipedrive } from "@/lib/pipedriveSync";

// POST free-form: { phone, body }
// POST template:  { phone, contentSid, variables?, label? }  (works outside 24h window)
// POST media:     { phone, mediaUrl, body? }  (image/PDF, within 24h window)
export async function POST(req: NextRequest) {
  try {
    const { phone, body, contentSid, variables, label, from, mediaUrl } = await req.json();
    if (!phone || (!body && !contentSid && !mediaUrl)) {
      return NextResponse.json({ error: "phone and body (or contentSid / mediaUrl) required" }, { status: 400 });
    }
    // What we store/show in the inbox bubble: prefer the template's real rendered
    // text (so it isn't a "[template]" stub), then an explicit label, then the body.
    const templateBody = contentSid ? await getContentBody(contentSid).catch(() => null) : null;
    const displayBody = contentSid
      ? (renderTemplateBody(templateBody, variables) || label || "[template]")
      : (body || (mediaUrl ? "[media]" : ""));
    const e164 = String(phone).replace(/[^0-9+]/g, "");
    const wa = e164.replace("+", "");
    const db = supabaseAdmin();

    // Blacklist guard - never message a contact who opted out (STOP/Unsubscribe)
    const { data: existing } = await db.from("conversations").select("status").eq("wa_phone", wa).maybeSingle();
    if (existing?.status === "blocked") {
      return NextResponse.json({ error: "This contact opted out (blacklisted). Message not sent." }, { status: 403 });
    }

    // upsert conversation
    const { data: conv } = await db
      .from("conversations")
      .upsert({ wa_phone: wa, last_body: displayBody, last_at: new Date().toISOString() }, { onConflict: "wa_phone" })
      .select()
      .single();

    // For template sends, pull the template's header image so the inbox bubble
    // shows the same creative the recipient sees (text templates resolve to null).
    const templateMedia = contentSid ? await getContentMedia(contentSid) : null;

    // send via Twilio (template, media, or free-form)
    const tw = contentSid
      ? await sendTemplate(e164, contentSid, variables, undefined, from)
      : mediaUrl
      ? await sendMediaWhatsApp(e164, mediaUrl, body || undefined, from)
      : await sendWhatsApp(e164, body, from);

    // log outbound message
    await db.from("messages").insert({
      conversation: conv!.id,
      direction: "out",
      body: displayBody,
      status: tw.status,
      twilio_sid: tw.sid,
      content_sid: contentSid || null,
      media_url: mediaUrl || templateMedia || null,
    });

    // denormalize last-message status onto the conversation (for the inbox list)
    await db
      .from("conversations")
      .update({ last_direction: "out", last_status: tw.status, unread: false })
      .eq("id", conv!.id);

    // Keep the Pipedrive transcript note current (best-effort; only if linked).
    await logConversationToPipedrive(conv!.id);

    return NextResponse.json({ ok: true, sid: tw.sid, status: tw.status });
  } catch (e: any) {
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}
