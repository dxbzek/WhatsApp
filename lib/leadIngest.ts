import { supabaseAdmin } from "@/lib/supabase";
import { distributeMetaLead } from "@/lib/distribution";
import { syncLeadToCrm } from "@/lib/crmSync";
import { syncMetaLeadToPipedrive } from "@/lib/metaLeadPipedrive";
import { dispatchFreshLeadCall } from "@/lib/aiCallerDispatch";
import { resolveAdPreview } from "@/lib/adCreatives";

// Shared ingest for a single Meta Instant-Form lead, regardless of how it arrived
// (the Zapier bridge POSTing to /api/leads/meta, or the meta-leads cron pulling it
// straight from the Graph API). Upserts the conversation as a hot lead, logs the
// context in-thread, round-robins it to the listing's agent pool (lead_routes),
// and appends a permanent lead_events row. Best-effort: never throws.
export type IngestResult = {
  ok: boolean;
  conversationId?: string;
  status?: string;       // routed | no_route | no_active_agents | alert_failed | error
  assigned?: string[];
  alert?: string;        // sent | fallback | none
  error?: string;
};

export async function ingestMetaLead(opts: {
  name?: string;
  phone: string;         // raw or E.164; normalised here
  email?: string;
  ref?: string;          // listing/ad code, e.g. CAYAN-BH (usually blank for cron)
  detail?: string;       // campaign name — drives routing
  listing?: string;      // specific property (ad set/ad), shown in the agent alert
  adId?: string;         // exact Meta ad — resolves the creative preview link + attribution
  adsetId?: string;
  campaignId?: string;
  adsetName?: string;
  adName?: string;       // exact ad name — more specific than the campaign
  metaLeadId?: string;   // Meta leadgen id (15-17 digit) — the CRM attribution key for CAPI
  answers?: Record<string, string>; // the form's qualifying answers, label -> value
}): Promise<IngestResult> {
  const e164 = normalizePhone(opts.phone || "");
  if (!e164) return { ok: false, error: "Missing or invalid phone" };
  const bare = e164.replace("+", "");
  const name = (opts.name || "").trim();
  const email = (opts.email || "").trim();
  const ref = (opts.ref || "").trim();
  const detail = (opts.detail || "").trim();

  const db = supabaseAdmin();
  const leadName = name || "New contact";
  const headline = `New lead from Meta ad${detail ? ` — ${detail}` : ""}`;

  // The qualifying answers are the useful part — what they want and where — so
  // they lead the inbox row. The row is narrow and the source is already shown
  // by the Meta tag, so "New lead from Meta ad — <campaign>" wasted every
  // visible character. Falls back to the headline for forms that ask nothing
  // beyond name/phone/email.
  const answers = opts.answers || {};
  const answerLine = Object.entries(answers).map(([k, v]) => `${k}: ${v}`);
  const summary = Object.values(answers).filter(Boolean).join(" · ");
  const preview = summary ? `New lead · ${summary}` : headline;

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
  if (convErr || !conv) return { ok: false, error: convErr?.message || "Upsert failed" };

  // Log the lead in-thread so the agent has the full picture on open: which ad
  // produced it, how to reach them, and every answer they gave on the form.
  const adName = (opts.adName || "").trim();
  const noteLines = [
    headline,
    adName && adName !== detail ? `Ad: ${adName}` : "",
    email ? `Email: ${email}` : "",
    ref ? `Ref: ${ref}` : "",
    ...answerLine,
  ].filter(Boolean);
  await db.from("messages").insert({
    conversation: conv.id, direction: "in", body: noteLines.join("\n"), status: "received",
  });

  // Resolve a stable public preview link for the exact ad (Instagram permalink,
  // FB permalink fallback) so the agent can tap to see the ad. Real-time: a cache
  // hit is instant; a never-seen ad is fetched live from Meta and cached on the fly.
  const adId = (opts.adId || "").trim();
  const previewUrl = adId ? await resolveAdPreview(adId) : "";

  // Round-robin to the listing's agent pool and ping them with the Meta context.
  const dist = await distributeMetaLead({
    conversationId: conv.id,
    contactPhone: e164, contactName: leadName, ref, detail,
    listing: (opts.listing || "").trim(), email, previewUrl, answers,
  });
  const alertStatus = dist.alertOk ? "sent" : dist.fallbackOk ? "fallback" : "none";

  // Denormalise the outcome onto the conversation for at-a-glance inbox context.
  // assigned_agent is the NAME; assigned_agent_id is the real uuid FK the inbox and the
  // stale-lead watcher both filter on. Writing only the name left every Meta lead reading
  // as unassigned in the console (caught 23 Jul 2026) and invisible to lead-watch.
  await db.from("conversations").update({
    source_ref: dist.ref ?? (ref || null),
    assigned_agent: dist.assigned[0] ?? null,
    ...(dist.ownerId ? { assigned_agent_id: dist.ownerId, assigned_at: new Date().toISOString() } : {}),
    routing_status: dist.status,
  }).eq("id", conv.id);

  // Mirror real property enquiries into the owner/audience CRM as a Buyer Lead so
  // they sit alongside owner records. Recruitment applicants are deliberately kept
  // OUT of the CRM (different audience - must never receive owner/seller sends).
  // Best-effort: a CRM hiccup must never fail lead routing.
  // Recorded on the lead_events row below so a failed Pipedrive create is VISIBLE and
  // retryable (retryPipedriveBacklog) instead of silently losing the lead.
  let pdResult: { ok: boolean; dealId?: number; skipped?: string; error?: string } | null = null;
  const isRecruitment = /recruit/i.test(detail) || /recruit/i.test(ref);

  // Every lead reaches Pipedrive, recruitment included — applicants go to the
  // Recruitment pipeline (9 / New Applicant) owned by the recruiter the route picked,
  // property leads to Deals. Before 05 Aug 2026 recruitment was skipped entirely, so
  // June's 306 paid applicants landed nowhere and none was ever called.
  try {
    pdResult = await syncMetaLeadToPipedrive({
      name, e164, email, detail,
      adId, adsetName: (opts.adsetName || "").trim(), adName,
      previewUrl, assignedAgent: dist.assigned[0] ?? null,
      answers: answerLine.length ? answers : undefined,
      isRecruitment,
    });
  } catch (e: any) { pdResult = { ok: false, error: String(e?.message || e).slice(0, 120) }; }

  if (!isRecruitment) {
    // The audience CRM stays property-only: an applicant must NEVER end up on an
    // owner/seller send list. This is the one thing recruitment is still excluded from.
    try { await syncLeadToCrm({ name, e164, email, detail }); } catch { /* non-fatal */ }

    // Fire the AI caller at the fresh lead. OFF by default (AI_CALLER_AUTODIAL);
    // when disabled it only logs the intent. A dial must never break ingest, so
    // it is awaited inside its own try and its result is not fatal.
    try {
      const dialRes = await dispatchFreshLeadCall({
        name, e164, detail, source: "Meta Ad", isRecruitment,
      });
      if (dialRes.dialed) console.log("[aiCaller] placed", e164, dialRes.conversationId);
    } catch { /* non-fatal */ }
  }

  // Append a permanent lead-tracking row (never overwritten, unlike the chat).
  // alert_status = our send attempt; alert_delivery (set later by the Twilio status
  // callback, keyed on alert_sid) = the TRUE handset outcome (delivered/undelivered).
  await db.from("lead_events").insert({
    conversation: conv.id,
    wa_phone: bare,
    name: leadName,
    ref: dist.ref ?? (ref || null),
    detail: detail || null,
    routing_status: dist.status,
    matched_route: dist.ref ?? null,
    assigned_agent: dist.assigned[0] ?? null,
    alert_status: alertStatus,
    alert_sid: dist.alertSid ?? null,
    alert_error: dist.alertError ?? null,
    ad_id: adId || null,
    adset_id: (opts.adsetId || "").trim() || null,
    campaign_id: (opts.campaignId || "").trim() || null,
    adset_name: (opts.adsetName || "").trim() || null,
    ad_name: adName || null,
    // Meta leadgen id — the attribution key for the Qualified Lead CRM CAPI event
    // (sent as user_data.lead_id). Without it a qualification can't be tied back to
    // the ad, so the Ads Manager Qualified Lead / CPQL column stays blank.
    leadgen_id: (opts.metaLeadId || "").trim() || null,
    // Raw qualifying answers, kept for reporting (e.g. rent vs sell split by
    // campaign) without re-querying Meta.
    answers: answerLine.length ? answers : null,
    preview_url: previewUrl || null,
    pipedrive_deal_id: pdResult?.dealId ?? null,
    // Recruitment is NO LONGER skipped (05 Aug 2026) — record its real outcome like any
    // other lead. The old `skipped_recruitment` / attempts 99 pair was left behind by the
    // fix and lied twice: it reported a created applicant deal as skipped, and 99 attempts
    // permanently excluded a genuinely FAILED recruitment create from retryPipedriveBacklog.
    pipedrive_status: pdResult
      ? (pdResult.ok ? "created" : (pdResult.skipped || pdResult.error || "failed")) : null,
    pipedrive_attempts: pdResult ? 1 : 0,
  });

  return { ok: true, conversationId: conv.id, status: dist.status, assigned: dist.assigned, alert: alertStatus };
}

// Light E.164 normaliser. Keeps a leading +, strips other punctuation; maps a UAE
// local "05xxxxxxxx" to +9715xxxxxxxx; assumes a 9-15 digit string without + is
// already international and just needs the +.
export function normalizePhone(raw: string): string | null {
  if (!raw) return null;
  let s = raw.replace(/[^\d+]/g, "");
  if (s.startsWith("00")) s = "+" + s.slice(2);
  if (s.startsWith("0") && s.length === 10) return "+971" + s.slice(1); // UAE local mobile
  if (!s.startsWith("+")) s = "+" + s;
  const digits = s.replace("+", "");
  if (digits.length < 8 || digits.length > 15) return null;
  return s;
}
