import { supabaseAdmin } from "./supabase";
import { crmEnrichForDeal } from "./crm";

// Mirror a Meta ad lead into Pipedrive the moment it arrives: person (matched on
// PHONE, the only reliable key in this CRM — 13 emails across 77k records), a deal
// in Deals -> New Lead owned by the same agent the WhatsApp route picked, and a
// note carrying the ad's headline, caption and Instagram permalink.
//
// Deliberately NOT stage 63 (Leads Pool): that stage's Make auto-claim webhook fires
// on write, which is how 28 live leads got assigned to the API user on 22 Jul 2026.
//
// Env-gated like crmSync: no token, no-op. Best-effort and never throws — a
// Pipedrive hiccup must never fail lead routing or the agent's WhatsApp alert.
//   PIPEDRIVE_API_TOKEN         company token (already used by lib/pipedrive.ts)
//   PIPEDRIVE_FALLBACK_USER_ID  deal owner when the routed agent has no mapping
const PIPELINE_ID = 2;
const STAGE_ID = 6;                                              // "New Lead"
// Recruitment applicants are not a sales lead and must not sit in the Deals pipeline,
// but they DO need a record with an owner — June 2026 proved the alternative: 306 paid
// applicants arrived, none reached Pipedrive, and not one was ever contacted.
// Pipeline 9 "Recruitment" / stage 65 "New Applicant", created 04 Aug 2026.
const RECRUITMENT_PIPELINE_ID = 9;
const RECRUITMENT_STAGE_ID = 65;
export const RECRUITMENT_SOURCE = "Recruitment";
const F_SOURCE = "be1b1fe6b64aad751a7a9649876a671db3f03215";     // Source (varchar)
const F_AD_LINK = "2792c6f093bf199246857ed30572a12c931f886d";    // Meta Ad Inquiry
const F_AD_CAPTION = "78341167f6364a09aefeac6652e3db3e38434ae8"; // Ad Caption
const SOURCE_VALUE = "Meta Ad";
// CRM-enrichment deal fields (populated from the audience CRM by phone match).
const F_COMMUNITY = "93034ed33eaaff8c96f76021426615b77590d525";   // Community (enum)
const F_LOCATION = "20acccdecb7dd7fb70cb10164d72a118ee2dfa87";    // Location (varchar, fallback for unmatched community)
const F_SUBCOMM = "920091727520dd34a784025992434b0ee5fc1e73";     // Sub Community (varchar)
const F_UNITNO = "8f6334f0e0480c40762b88cb9297ad3a6d6cbe40";      // Unit Number (varchar)
const F_NATION = "d5d2f154cff4ad48a51052dd29a51715785eee2a";      // Nationality (varchar)
const F_TIER = "5dc3f1f8d17c28042afd47b9cc7828a2a770dd79";        // CRM Tier (varchar)

const clean = (v?: string | null) => (v || "").replace(/^﻿/, "").trim();

async function pd(method: string, path: string, params: Record<string, string> = {}, body?: unknown) {
  const token = clean(process.env.PIPEDRIVE_API_TOKEN);
  if (!token) throw new Error("pipedrive token missing");
  // Token goes through URLSearchParams, never string interpolation, so nothing
  // thrown or logged from here can carry the credential.
  const qs = new URLSearchParams({ ...params, api_token: token });
  const res = await fetch(`https://api.pipedrive.com/${path}?${qs.toString()}`, {
    method,
    headers: body ? { "Content-Type": "application/json" } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  const data: any = await res.json().catch(() => ({}));
  if (!res.ok || data?.success === false) throw new Error(`pipedrive ${method} ${path} -> ${res.status}`);
  return data;
}

// Community is an enum field; map a CRM community NAME to its Pipedrive option id.
// Cached per process (the option set rarely changes) so the hot path adds no call.
let _communityOpts: Map<string, number> | null = null;
async function communityOptionId(label: string): Promise<number | null> {
  const key = clean(label).toLowerCase();
  if (!key) return null;
  if (!_communityOpts) {
    try {
      const d: any = await pd("GET", "v1/dealFields", { limit: "500" });
      const f = (d?.data || []).find((x: any) => x.key === F_COMMUNITY);
      _communityOpts = new Map(((f?.options) || []).map((o: any) => [String(o.label || "").trim().toLowerCase(), o.id]));
    } catch { _communityOpts = new Map(); }
  }
  return _communityOpts.get(key) ?? null;
}

// lead_events/distribution carry the agent's NAME; agents.pipedrive_user_id holds the
// mapping. An unmapped agent falls back rather than creating an ownerless deal.
async function ownerFor(agentName?: string | null): Promise<number | null> {
  const fallback = Number(clean(process.env.PIPEDRIVE_FALLBACK_USER_ID)) || null;
  if (!agentName) return fallback;
  const { data } = await supabaseAdmin()
    .from("agents").select("pipedrive_user_id").eq("name", agentName).maybeSingle();
  return (data?.pipedrive_user_id as number | null) || fallback;
}

function noteHtml(o: {
  name: string; e164: string; kind?: string; detail?: string; adsetName?: string; adName?: string;
  headline?: string; caption?: string; adUrl?: string; answers?: Record<string, string>;
}): string {
  // Person first: the name and number are what the caller needs before anything else.
  return [
    `<b>${o.name}</b> — ${o.e164}`,
    `<b>${o.kind || "Meta ad lead"}</b>`,
    o.detail ? `Campaign: ${o.detail}` : "",
    o.adsetName ? `Ad set: ${o.adsetName}` : "",
    o.adName ? `Ad: ${o.adName}` : "",
    o.headline ? `<b>Ad headline:</b> ${o.headline}` : "",
    o.caption ? `<b>Ad caption:</b> ${o.caption}` : "",
    o.adUrl ? `Ad post: ${o.adUrl}` : "",
    ...Object.entries(o.answers || {}).map(([k, v]) => `${k}: ${v}`),
  ].filter(Boolean).join("<br>");
}

// Retry every lead that never made it into Pipedrive. Called from the meta-leads cron
// (every 2 minutes, round the clock) so a transient failure — a 429 from a bulk import,
// a timeout, a deploy — costs minutes, not the lead. 23 Jul 2026: a real lead was lost
// exactly this way and only surfaced because Zek went looking for it.
//
// Claims are idempotent: a row is only picked up while pipedrive_deal_id is null, and
// the id is written the moment the deal exists. MAX_ATTEMPTS stops a permanently broken
// row (bad phone, deleted field) from being retried forever.
const MAX_ATTEMPTS = 8;
const RETRY_WINDOW_DAYS = 7;

export async function retryPipedriveBacklog(limit = 10): Promise<{ retried: number; created: number }> {
  if (!clean(process.env.PIPEDRIVE_API_TOKEN)) return { retried: 0, created: 0 };
  const db = supabaseAdmin();
  const since = new Date(Date.now() - RETRY_WINDOW_DAYS * 86400_000).toISOString();

  const { data: rows } = await db
    .from("lead_events")
    .select("id, name, wa_phone, detail, ad_id, adset_name, ad_name, preview_url, assigned_agent, answers, matched_route, pipedrive_attempts")
    .is("pipedrive_deal_id", null)
    .gte("created_at", since)
    .lt("pipedrive_attempts", MAX_ATTEMPTS)
    .order("created_at", { ascending: true })
    .limit(limit);
  if (!rows || rows.length === 0) return { retried: 0, created: 0 };

  let created = 0;
  for (const r of rows as any[]) {
    // Recruitment applicants used to be dropped here ("skipped_recruitment"). They now
    // go to the Recruitment pipeline instead — they were never junk, they just had
    // nowhere to land, which is how 306 paid applicants went uncontacted in June 2026.
    const isRec = (r.matched_route || "") === "Recruitment";
    const res = await syncMetaLeadToPipedrive({
      isRecruitment: isRec,
      name: r.name === "New contact" ? "" : r.name,
      e164: "+" + String(r.wa_phone || "").replace("+", ""),
      detail: r.detail || undefined,
      adId: r.ad_id || undefined,
      adsetName: r.adset_name || undefined,
      adName: r.ad_name || undefined,
      previewUrl: r.preview_url || undefined,
      assignedAgent: r.assigned_agent,
      answers: (r.answers as Record<string, string>) || undefined,
    });
    await db.from("lead_events").update({
      pipedrive_deal_id: res.dealId ?? null,
      pipedrive_status: res.ok ? "created" : (res.skipped || res.error || "failed"),
      pipedrive_attempts: (r.pipedrive_attempts || 0) + 1,
    }).eq("id", r.id);
    if (res.ok) created++;
  }
  return { retried: rows.length, created };
}

export async function syncMetaLeadToPipedrive(opts: {
  name?: string;
  e164: string;
  email?: string;
  detail?: string;
  adId?: string;
  adsetName?: string;
  adName?: string;
  previewUrl?: string;
  assignedAgent?: string | null;
  answers?: Record<string, string>;
  // Set by non-Meta callers (e.g. a WhatsApp campaign reply) so the deal is
  // attributed to the right channel instead of masquerading as a Meta ad lead.
  sourceValue?: string;   // Source field, e.g. "WhatsApp Campaign"
  kind?: string;          // note heading, e.g. "WhatsApp campaign lead"
  titlePrefix?: string;   // deal title prefix, e.g. "WhatsApp"
  // Route an agent APPLICANT to the Recruitment pipeline instead of Deals. Set by
  // leadIngest when the lead's route/ref is recruitment.
  isRecruitment?: boolean;
}): Promise<{ ok: boolean; skipped?: string; dealId?: number; error?: string; activityId?: number; activityError?: string }> {
  if (!clean(process.env.PIPEDRIVE_API_TOKEN)) return { ok: false, skipped: "pipedrive_unconfigured" };
  const e164 = clean(opts.e164);
  if (!e164) return { ok: false, skipped: "no_phone" };
  const name = clean(opts.name) || e164;

  try {
    const owner = await ownerFor(opts.assignedAgent);

    // Enrich from the audience CRM (matched by phone). Best-effort: a CRM miss or
    // error must never block the deal. Property-specific fields + the real name are
    // only used when the phone resolves to ONE owner (crmEnrichForDeal guards the
    // switchboard / multi-owner case); nationality is used whenever all matches agree.
    const enrich = await crmEnrichForDeal(e164).catch(() => null);
    const displayName = (enrich?.singleOwner && enrich.name) ? enrich.name : name;
    const crmCf: Record<string, unknown> = {};
    if (enrich) {
      if (enrich.nationality) crmCf[F_NATION] = enrich.nationality;
      if (enrich.subCommunity) crmCf[F_SUBCOMM] = enrich.subCommunity;
      if (enrich.unitNumber) crmCf[F_UNITNO] = enrich.unitNumber;
      if (enrich.tier) crmCf[F_TIER] = enrich.tier;
      if (enrich.community) {
        const oid = await communityOptionId(enrich.community);
        if (oid) crmCf[F_COMMUNITY] = oid; else crmCf[F_LOCATION] = enrich.community;
      }
    }

    // Creative copy is already cached by the alert path (lib/adCreatives), so read
    // it back rather than hitting Meta again.
    let headline = "", caption = "";
    let adUrl = clean(opts.previewUrl);
    if (clean(opts.adId)) {
      const { data: c } = await supabaseAdmin()
        .from("ad_creatives").select("headline, body, ig_permalink")
        .eq("ad_id", clean(opts.adId)).maybeSingle();
      headline = clean(c?.headline as string);
      caption = clean(c?.body as string);
      adUrl = adUrl || clean(c?.ig_permalink as string);
    }

    const found: any = await pd("GET", "api/v2/persons/search", { term: e164, fields: "phone", limit: "5" });
    let personId: number | undefined = found?.data?.items?.[0]?.item?.id;
    if (!personId) {
      const created: any = await pd("POST", "api/v2/persons", {}, {
        name: displayName,
        owner_id: owner,
        phones: [{ value: e164, primary: true, label: "mobile" }],
        ...(clean(opts.email) ? { emails: [{ value: clean(opts.email), primary: true, label: "work" }] } : {}),
      });
      personId = created?.data?.id;
    }
    if (!personId) return { ok: false, error: "no person id" };

    const isRec = opts.isRecruitment === true;
    const deal: any = await pd("POST", "api/v2/deals", {}, {
      title: `${clean(opts.titlePrefix) || (isRec ? "Applicant" : "Meta Ad")} — ${displayName}`,
      person_id: personId,
      owner_id: owner,
      pipeline_id: isRec ? RECRUITMENT_PIPELINE_ID : PIPELINE_ID,
      stage_id: isRec ? RECRUITMENT_STAGE_ID : STAGE_ID,
      // Pipedrive REJECTS an empty string on a text custom field ("Expected non-empty
      // 'string' ... use null to clear") and fails the whole deal with a 400. A Meta lead
      // always carries an ad link and caption; a WEBSITE lead never does, which is why
      // every website enquiry created a person and then no deal (25 Jul 2026). Omit them.
      custom_fields: {
        [F_SOURCE]: clean(opts.sourceValue) || (isRec ? RECRUITMENT_SOURCE : SOURCE_VALUE),
        ...(adUrl ? { [F_AD_LINK]: adUrl } : {}),
        ...(([headline, caption].filter(Boolean).join(" — ")) ?
          { [F_AD_CAPTION]: [headline, caption].filter(Boolean).join(" — ") } : {}),
        ...crmCf,
      },
    });
    const dealId: number | undefined = deal?.data?.id;
    if (!dealId) return { ok: false, error: "no deal id" };

    await pd("POST", "v1/notes", {}, {
      deal_id: dealId,
      content: noteHtml({
        name: displayName, e164, kind: clean(opts.kind),
        detail: clean(opts.detail), adsetName: clean(opts.adsetName), adName: clean(opts.adName),
        headline, caption, adUrl, answers: opts.answers,
      }),
    });

    // A call activity due in 2 hours, owned by the same agent as the deal.
    //
    // Why: on 27 Jul 2026 all 86 Meta deals had ZERO completed activities and 32 sat
    // in New/No Answer for 3+ days. Nobody was ignoring a task — there was no task.
    // An unworked lead was invisible until someone went looking. With this, it shows
    // up overdue on the agent's board and in Pipedrive's own reminders, which is the
    // difference between a policy and an enforced one.
    //
    // Best-effort on purpose: the deal already exists and matters more than its task,
    // so a failure here is logged into the return value, never thrown.
    let activityId: number | undefined;
    try {
      const due = new Date(Date.now() + 2 * 3600_000);           // Pipedrive expects UTC
      const act: any = await pd("POST", "v1/activities", {}, {
        subject: `Call ${displayName} — new ${clean(opts.sourceValue) || SOURCE_VALUE} lead`,
        type: "call",
        deal_id: dealId,
        person_id: personId,
        user_id: owner,
        due_date: due.toISOString().slice(0, 10),
        due_time: due.toISOString().slice(11, 16),
        duration: "00:15",
        note: `${e164}${clean(opts.detail) ? ` · ${clean(opts.detail)}` : ""}`,
        done: false,
      });
      activityId = act?.data?.id;
    } catch (e: any) {
      return { ok: true, dealId, activityError: String(e?.message || e).slice(0, 120) };
    }
    return { ok: true, dealId, activityId };
  } catch (e: any) {
    return { ok: false, error: String(e?.message || e).slice(0, 200) };
  }
}
