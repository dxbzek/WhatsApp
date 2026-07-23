import { supabaseAdmin } from "./supabase";

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
const F_SOURCE = "be1b1fe6b64aad751a7a9649876a671db3f03215";     // Source (varchar)
const F_AD_LINK = "2792c6f093bf199246857ed30572a12c931f886d";    // Meta Ad Inquiry
const F_AD_CAPTION = "78341167f6364a09aefeac6652e3db3e38434ae8"; // Ad Caption
const SOURCE_VALUE = "Meta Ad";

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
    // Recruitment applicants are not a sales pipeline — mark them settled so they do not
    // sit in the backlog forever being retried.
    if ((r.matched_route || "") === "Recruitment") {
      await db.from("lead_events").update({ pipedrive_status: "skipped_recruitment", pipedrive_attempts: MAX_ATTEMPTS }).eq("id", r.id);
      continue;
    }
    const res = await syncMetaLeadToPipedrive({
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
}): Promise<{ ok: boolean; skipped?: string; dealId?: number; error?: string }> {
  if (!clean(process.env.PIPEDRIVE_API_TOKEN)) return { ok: false, skipped: "pipedrive_unconfigured" };
  const e164 = clean(opts.e164);
  if (!e164) return { ok: false, skipped: "no_phone" };
  const name = clean(opts.name) || e164;

  try {
    const owner = await ownerFor(opts.assignedAgent);

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
        name,
        owner_id: owner,
        phones: [{ value: e164, primary: true, label: "mobile" }],
        ...(clean(opts.email) ? { emails: [{ value: clean(opts.email), primary: true, label: "work" }] } : {}),
      });
      personId = created?.data?.id;
    }
    if (!personId) return { ok: false, error: "no person id" };

    const deal: any = await pd("POST", "api/v2/deals", {}, {
      title: `${clean(opts.titlePrefix) || "Meta Ad"} — ${name}`,
      person_id: personId,
      owner_id: owner,
      pipeline_id: PIPELINE_ID,
      stage_id: STAGE_ID,
      custom_fields: {
        [F_SOURCE]: clean(opts.sourceValue) || SOURCE_VALUE,
        [F_AD_LINK]: adUrl || "",
        [F_AD_CAPTION]: [headline, caption].filter(Boolean).join(" — "),
      },
    });
    const dealId: number | undefined = deal?.data?.id;
    if (!dealId) return { ok: false, error: "no deal id" };

    await pd("POST", "v1/notes", {}, {
      deal_id: dealId,
      content: noteHtml({
        name, e164, kind: clean(opts.kind),
        detail: clean(opts.detail), adsetName: clean(opts.adsetName), adName: clean(opts.adName),
        headline, caption, adUrl, answers: opts.answers,
      }),
    });
    return { ok: true, dealId };
  } catch (e: any) {
    return { ok: false, error: String(e?.message || e).slice(0, 200) };
  }
}
