import { NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase";
import { DEAD_NUMBER_CODES } from "@/lib/twilioErrors";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

// Per-template performance from our own message log (last 90 days):
// sent / delivered / read / failed + reply rate (a conversation "replied" if an
// inbound message arrived after a template send). Keyed by content_sid so the
// client can merge in template names. GET -> { stats: { [sid]: {...} } }
export async function GET() {
  try {
    const db = supabaseAdmin();
    const since = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString();

    // Page through outbound template messages.
    const out: { content_sid: string; conversation: string; status: string | null; created_at: string; error_code: string | null }[] = [];
    for (let from = 0; ; from += 1000) {
      const { data, error } = await db
        .from("messages")
        .select("content_sid, conversation, status, created_at, error_code")
        .not("content_sid", "is", null)
        .eq("direction", "out")
        // Only count messages Twilio actually attempted to send. Three statuses were
        // never transmitted to a recipient and must NOT count as "Sent":
        //   scheduled — drip queue rows pre-created, not yet handed to Twilio
        //   canceled  — killed before send (e.g. the account-suspension abort)
        //   skipped   — auto-skipped because the number was already reached
        // Counting them inflates the denominator and makes delivery rate read far
        // lower than reality, and leaves ghost recipients unaccounted in the funnel.
        .not("status", "in", "(scheduled,canceled,skipped)")
        .gte("created_at", since)
        .order("created_at", { ascending: true })
        .range(from, from + 999);
      if (error) throw error;
      out.push(...(data as any[]));
      if (!data || data.length < 1000) break;
    }

    // Inbound messages grouped by conversation (for reply detection).
    const inbound: Record<string, number[]> = {};
    for (let from = 0; ; from += 1000) {
      const { data, error } = await db
        .from("messages")
        .select("conversation, created_at")
        .eq("direction", "in")
        .gte("created_at", since)
        .order("created_at", { ascending: true })
        .range(from, from + 999);
      if (error) throw error;
      for (const m of data as any[]) (inbound[m.conversation] ||= []).push(new Date(m.created_at).getTime());
      if (!data || data.length < 1000) break;
    }

    // Lead conversations = pushed to Pipedrive. This is the real outcome we care
    // about (delivered -> reached a person, but LEAD = it actually turned into
    // something an agent can work). Set of conversation ids that became a lead.
    const leadConvs = new Set<string>();
    for (let from = 0; ; from += 1000) {
      const { data, error } = await db
        .from("conversations")
        .select("id")
        .not("pipedrive_lead_id", "is", null)
        .range(from, from + 999);
      if (error) throw error;
      for (const c of data as any[]) leadConvs.add(c.id);
      if (!data || data.length < 1000) break;
    }

    const stats: Record<string, any> = {};
    // Track distinct conversations + replied conversations per template.
    const convsSeen: Record<string, Set<string>> = {};
    const convsReplied: Record<string, Set<string>> = {};

    for (const m of out) {
      const sid = m.content_sid;
      const s = (stats[sid] ||= { sent: 0, delivered: 0, read: 0, failed: 0, errors: {} as Record<string, number> });
      convsSeen[sid] ||= new Set();
      convsReplied[sid] ||= new Set();
      s.sent++;
      if (m.status === "read") { s.read++; s.delivered++; }
      else if (m.status === "delivered") s.delivered++;
      else if (m.status === "failed" || m.status === "undelivered") {
        s.failed++;
        // Tally the real Twilio/Meta reason so the card explains WHY it failed
        // (sender lock vs over-messaging vs dead number) instead of guessing.
        const code = m.error_code ? String(m.error_code) : "none";
        s.errors[code] = (s.errors[code] || 0) + 1;
      }

      convsSeen[sid].add(m.conversation);
      const t = new Date(m.created_at).getTime();
      const replies = inbound[m.conversation];
      if (replies && replies.some((rt) => rt > t)) convsReplied[sid].add(m.conversation);
    }

    for (const sid of Object.keys(stats)) {
      const seen = convsSeen[sid].size;
      stats[sid].conversations = seen;
      stats[sid].replied = convsReplied[sid].size;
      // Leads = distinct conversations that got this template AND are now a
      // Pipedrive lead. Rate is of DELIVERED (the real conversion: of everyone
      // who actually received it, how many turned into a lead).
      let leads = 0;
      for (const cid of convsSeen[sid]) if (leadConvs.has(cid)) leads++;
      stats[sid].leads = leads;
      stats[sid].leadRate = stats[sid].delivered ? Math.round((leads / stats[sid].delivered) * 100) : 0;
      stats[sid].deliveryRate = stats[sid].sent ? Math.round((stats[sid].delivered / stats[sid].sent) * 100) : 0;
      stats[sid].failedRate = stats[sid].sent ? Math.round((stats[sid].failed / stats[sid].sent) * 100) : 0;
      stats[sid].readRate = stats[sid].sent ? Math.round((stats[sid].read / stats[sid].sent) * 100) : 0;
      // Bucket the failure reasons the same way the Insights page does, so both
      // screens tell the same story: locked sender, marketing throttle, or dead.
      const e: Record<string, number> = stats[sid].errors;
      stats[sid].errLocked = e["63051"] || 0;
      stats[sid].errThrottled = e["63049"] || 0;
      stats[sid].errHold = e["63032"] || 0;
      stats[sid].errDead = Object.keys(e).filter((c) => DEAD_NUMBER_CODES.has(c)).reduce((n, c) => n + e[c], 0);
      stats[sid].replyRate = seen ? Math.round((stats[sid].replied / seen) * 100) : 0;
    }

    return NextResponse.json({ stats });
  } catch (e: any) {
    return NextResponse.json({ error: e.message || "Failed to compute performance" }, { status: 500 });
  }
}
