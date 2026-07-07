import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase";
import { sendTemplate, getContentMedia, getContentBody, renderTemplateBody, cleanEnv } from "@/lib/twilio";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

// Send one batch of a campaign. The client loops batches so each request
// stays short. Template-only (works outside 24h), skips blacklisted, throttled.
// POST { recipients:[{phone,vars?}], contentSid, label, sendAt? }
export async function POST(req: NextRequest) {
  try {
    const { recipients, contentSid, label, sendAt, from, campaignId } = await req.json();
    if (!contentSid) return NextResponse.json({ error: "contentSid required" }, { status: 400 });
    if (!Array.isArray(recipients) || recipients.length === 0)
      return NextResponse.json({ error: "recipients required" }, { status: 400 });
    if (recipients.length > 25)
      return NextResponse.json({ error: "Max 25 recipients per batch" }, { status: 400 });

    const db = supabaseAdmin();

    // The lane this batch actually goes out from — stamped on each conversation
    // so the inbox can show which of our numbers the thread lives on.
    const ourNumber = String(from || cleanEnv(process.env.TWILIO_WHATSAPP_FROM) || "").replace(/^whatsapp:/, "") || null;

    // Resolve the template's header image once (constant for the whole batch) so
    // every logged message shows the creative in our inbox, not just text.
    const templateMedia = await getContentMedia(contentSid);
    const templateBody = await getContentBody(contentSid).catch(() => null);

    // Skip opted-out (blocked), dead (invalid), and anyone we've ALREADY REACHED
    // (or have in-flight) with this template. A send that only FAILED on our side
    // (sender locked 63051, throttled 63049, rate-limited 90010, etc.) did NOT
    // reach the contact, so it must NOT block a resend — that was the whole point
    // of the post-restriction resend. Sends that bounced because the number isn't
    // on WhatsApp (63024/63003) stay blocked, since resending just bounces again
    // and hurts the sender's quality rating.
    const REACHED = new Set(["delivered", "read", "sent"]);
    const INFLIGHT = new Set(["queued", "sending", "scheduled", "accepted"]);
    const DEAD_ERR = new Set(["63024", "63003"]); // number not on WhatsApp — never resend
    const phones = recipients.map((r: any) => String(r.phone).replace(/[^0-9+]/g, "").replace("+", ""));
    const { data: convRows } = await db.from("conversations").select("id, wa_phone, status").in("wa_phone", phones);
    const idByPhone = new Map<string, string>();
    const blockedSet = new Set<string>();
    const invalidSet = new Set<string>();
    for (const c of convRows || []) {
      idByPhone.set((c as any).wa_phone, (c as any).id);
      if ((c as any).status === "blocked") blockedSet.add((c as any).wa_phone);
      if ((c as any).status === "invalid") invalidSet.add((c as any).wa_phone);
    }
    const convIdList = Array.from(idByPhone.values());
    // Only conversations actually reached / in-flight / proven-dead get blocked.
    const skipConvIds = new Set<string>();
    for (let i = 0; i < convIdList.length; i += 300) {
      const { data } = await db.from("messages").select("conversation, status, error_code")
        .eq("direction", "out").eq("content_sid", contentSid).in("conversation", convIdList.slice(i, i + 300));
      for (const m of data || []) {
        const st = (m as any).status as string;
        const ec = (m as any).error_code != null ? String((m as any).error_code) : null;
        if (REACHED.has(st) || INFLIGHT.has(st) || (ec && DEAD_ERR.has(ec))) skipConvIds.add((m as any).conversation);
      }
    }
    const alreadySentSet = new Set<string>();
    for (const [wa, id] of idByPhone) if (skipConvIds.has(id)) alreadySentSet.add(wa);

    // Marketing frequency guard. Meta caps a user who receives too many MARKETING
    // messages in a short window (error 63049 — the #1 Nima failure, 17 of 25). The
    // per-template already-sent check above does NOT catch this: a contact who got a
    // DIFFERENT campaign recently still gets blasted and Meta throttles them. So skip
    // anyone who received ANY broadcast in the last COOLDOWN_DAYS. Same-contact
    // cooldown only, so a daily ramp to NEW contacts is unaffected. 0 = disable.
    const COOLDOWN_DAYS = Number(process.env.MARKETING_COOLDOWN_DAYS || 7);
    const recentSet = new Set<string>();
    if (COOLDOWN_DAYS > 0 && convIdList.length) {
      const since = new Date(Date.now() - COOLDOWN_DAYS * 86400000).toISOString();
      for (let i = 0; i < convIdList.length; i += 300) {
        const { data } = await db.from("messages").select("conversation")
          .eq("direction", "out").not("campaign", "is", null).gte("created_at", since)
          .in("conversation", convIdList.slice(i, i + 300));
        for (const m of data || []) recentSet.add((m as any).conversation);
      }
    }
    const recentSentSet = new Set<string>();
    for (const [wa, id] of idByPhone) if (recentSet.has(id)) recentSentSet.add(wa);

    const results: any[] = [];
    for (const r of recipients) {
      const e164raw = String(r.phone).replace(/[^0-9+]/g, "");
      const e164 = e164raw.startsWith("+") ? e164raw : `+${e164raw}`;
      const wa = e164.replace("+", "");
      if (!wa || wa.length < 8) { results.push({ phone: r.phone, status: "invalid" }); continue; }
      if (blockedSet.has(wa)) { results.push({ phone: e164, status: "skipped_blacklist" }); continue; }
      if (invalidSet.has(wa)) { results.push({ phone: e164, status: "skipped_invalid" }); continue; }
      if (alreadySentSet.has(wa)) { results.push({ phone: e164, status: "skipped_already_sent" }); continue; }
      if (recentSentSet.has(wa)) { results.push({ phone: e164, status: "skipped_recent" }); continue; }

      try {
        const tw = await sendTemplate(e164, contentSid, r.vars || undefined, sendAt || undefined, from || undefined);
        // Trust Twilio's REAL status. A requested sendAt does not guarantee a
        // scheduled message: with no Messaging Service configured, Twilio sends
        // immediately and returns "queued"/"accepted". Never fake "scheduled".
        const realStatus = tw.status || (sendAt ? "scheduled" : "queued");
        // Prefer the per-recipient rendered body so the inbox shows what THIS
        // contact actually received ("Hi Igor"), not a shared generic label.
        const body = renderTemplateBody(templateBody, r.vars) || r.body || label || "[template]";
        const { data: conv } = await db
          .from("conversations")
          .upsert({ wa_phone: wa, last_body: body, last_at: new Date().toISOString(), ...(ourNumber ? { our_number: ourNumber } : {}) }, { onConflict: "wa_phone" })
          .select()
          .single();
        const { data: msg } = await db.from("messages").insert({ conversation: conv!.id, direction: "out", body, status: realStatus, twilio_sid: tw.sid, campaign: campaignId || null, content_sid: contentSid || null, media_url: templateMedia }).select("id").single();
        await db.from("conversations").update({ last_direction: "out", last_status: realStatus }).eq("id", conv!.id);
        // Best-effort: stamp the planned send time when Twilio actually scheduled.
        // Wrapped so a missing scheduled_at column never breaks the send.
        if (realStatus === "scheduled" && sendAt && msg?.id) {
          await db.from("messages").update({ scheduled_at: sendAt }).eq("id", msg.id).then(() => {}, () => {});
        }
        results.push({ phone: e164, status: realStatus, sid: tw.sid });
      } catch (e: any) {
        results.push({ phone: e164, status: "failed", error: e.message });
      }
      // gentle throttle
      await new Promise((res) => setTimeout(res, 250));
    }

    const sent = results.filter((r) => ["queued", "sent", "scheduled", "accepted"].includes(r.status)).length;
    return NextResponse.json({ results, sent, skipped: results.filter((r) => r.status === "skipped_blacklist").length });
  } catch (e: any) {
    return NextResponse.json({ error: e.message || "Campaign send failed" }, { status: 500 });
  }
}
