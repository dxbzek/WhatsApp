// Strip a leading UTF-8 BOM / stray whitespace that can sneak into env vars
// (e.g. when set from a BOM-encoded file) and break Basic auth / API keys.
export const cleanEnv = (v?: string) => (v || "").replace(/^\uFEFF/, "").trim();

// Minimal Twilio WhatsApp via REST (no SDK needed).
export function twilioCreds() {
  const sid = cleanEnv(process.env.TWILIO_ACCOUNT_SID);
  const token = cleanEnv(process.env.TWILIO_AUTH_TOKEN);
  return {
    sid,
    token,
    authHeader: "Basic " + Buffer.from(`${sid}:${token}`).toString("base64"),
  };
}

// Turn Twilio's terse REST errors into something a human can act on. A blocked
// or wrong credential comes back as HTTP 401 + code 20003 with the bare message
// "Authenticate" - which reads like a button, not a problem. Map the common
// account-level failures to plain guidance; pass everything else through.
export function twilioError(status: number, data: any, fallback: string): Error {
  const code = data?.code;
  if (status === 401 || code === 20003) {
    return new Error(
      "Twilio rejected the credentials. The account is likely suspended, or the API key/token changed. Check the Twilio console."
    );
  }
  if (status === 403 || code === 20005) {
    return new Error("Twilio account is not active (suspended or closed). Open the Twilio console to restore it.");
  }
  return new Error(data?.message || fallback);
}

// Marketing-lane subaccount creds (its own WABA + number, separate from the utility
// lane the console is primarily wired to). Returns a Basic auth header, or null when
// not configured — so the console degrades to the single utility lane instead of
// erroring. Two-lane: utility = default TWILIO_* creds, marketing = TWILIO_MKT_* creds.
export function marketingAuthHeader(): string | null {
  const sid = cleanEnv(process.env.TWILIO_MKT_ACCOUNT_SID);
  const token = cleanEnv(process.env.TWILIO_MKT_AUTH_TOKEN);
  if (!sid || !token) return null;
  return "Basic " + Buffer.from(`${sid}:${token}`).toString("base64");
}

// GET against any Twilio host (api.twilio.com or content.twilio.com).
// `url` may be a full URL or a path beginning with "/". Pass authHeader to target a
// specific (sub)account (e.g. the marketing lane); defaults to the utility creds.
export async function twilioGet(url: string, authHeader?: string) {
  const auth = authHeader || twilioCreds().authHeader;
  const full = url.startsWith("http") ? url : `https://api.twilio.com${url}`;
  const res = await fetch(full, { headers: { Authorization: auth } });
  const data = await res.json();
  if (!res.ok) throw twilioError(res.status, data, `Twilio GET ${res.status}`);
  return data;
}

// Resolve a template's header media URL (image / PDF / video) from its Content
// SID, so outbound template messages render the creative in our own inbox just
// like the recipient sees on WhatsApp. Returns null for text-only templates and
// for variable media placeholders ("{{1}}") that aren't real URLs.
export async function getContentMedia(contentSid: string): Promise<string | null> {
  try {
    const data: any = await twilioGet(`https://content.twilio.com/v1/Content/${contentSid}`);
    const types = data?.types || {};
    for (const key of Object.keys(types)) {
      const m = types[key]?.media;
      const url = Array.isArray(m) ? m[0] : m;
      if (typeof url === "string" && /^https?:\/\//i.test(url)) return url;
    }
    return null;
  } catch {
    return null; // never block a send on media lookup
  }
}

// Resolve a template's body TEXT from its Content SID, so logged messages show the
// real message in our inbox instead of a bare "[template]" placeholder. Returns
// null for templates with no text body (pure-media).
export async function getContentBody(contentSid: string): Promise<string | null> {
  try {
    const data: any = await twilioGet(`https://content.twilio.com/v1/Content/${contentSid}`);
    const types = data?.types || {};
    for (const key of Object.keys(types)) {
      const b = types[key]?.body;
      if (typeof b === "string" && b.trim()) return b;
    }
    return null;
  } catch {
    return null; // never block a send on a body lookup
  }
}

// Substitute {{1}},{{2}},... placeholders in a template body with content variables
// (keyed "1","2",...). Unknown placeholders are left as-is. Empty input -> "".
export function renderTemplateBody(body: string | null, vars?: Record<string, string> | null): string {
  if (!body) return "";
  if (!vars) return body;
  return body.replace(/\{\{\s*(\d+)\s*\}\}/g, (m, n) => (vars[n] != null ? String(vars[n]) : m));
}

// Read a message's current status from Twilio. Used to reconcile rows whose SID
// was created via Twilio's own scheduler (our cron never sends those, so their DB
// status would otherwise freeze at 'scheduled' even after Twilio sends/fails/cancels).
export async function getMessageStatus(messageSid: string): Promise<{ status: string | null; errorCode: string | null } | null> {
  try {
    const { sid } = twilioCreds();
    const data: any = await twilioGet(`/2010-04-01/Accounts/${sid}/Messages/${messageSid}.json`);
    return { status: data?.status || null, errorCode: data?.error_code ? String(data.error_code) : null };
  } catch {
    return null; // never let a reconcile lookup break the cron
  }
}

// JSON POST against content.twilio.com (Content API). Pass authHeader to create on a
// specific lane (e.g. marketing); defaults to the utility creds.
export async function twilioContentPost(path: string, body: any, authHeader?: string) {
  const auth = authHeader || twilioCreds().authHeader;
  const res = await fetch(`https://content.twilio.com${path}`, {
    method: "POST",
    headers: { Authorization: auth, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw twilioError(res.status, data, `Twilio POST ${res.status}`);
  return data;
}

// DELETE against content.twilio.com (Content API). 204 = success, no body.
export async function twilioContentDelete(path: string, authHeader?: string) {
  const auth = authHeader || twilioCreds().authHeader;
  const res = await fetch(`https://content.twilio.com${path}`, {
    method: "DELETE",
    headers: { Authorization: auth },
  });
  if (!res.ok && res.status !== 204) {
    const data = await res.json().catch(() => ({}));
    throw twilioError(res.status, data, `Twilio DELETE ${res.status}`);
  }
}

// Delivery-status callback URL; bypass param lets Twilio through Vercel protection.
function statusCallbackUrl() {
  const base =
    cleanEnv(process.env.PUBLIC_BASE_URL) ||
    (process.env.VERCEL_PROJECT_PRODUCTION_URL ? `https://${cleanEnv(process.env.VERCEL_PROJECT_PRODUCTION_URL)}` : "");
  if (!base) return "";
  const bypass = cleanEnv(process.env.VERCEL_AUTOMATION_BYPASS_SECRET);
  // Bypass as a query param only — NOT x-vercel-set-bypass-cookie=true, which
  // would (a) 307-redirect the callback and (b) let a leaked URL mint a durable
  // project-wide bypass cookie.
  return `${base}/api/twilio/status${bypass ? `?x-vercel-protection-bypass=${bypass}` : ""}`;
}

// Messaging Service SID - required for Twilio's native scheduled sends.
const MESSAGING_SERVICE_SID = () => cleanEnv(process.env.TWILIO_MESSAGING_SERVICE_SID);

// Available WhatsApp sender numbers. Comma-separated TWILIO_WHATSAPP_SENDERS
// overrides; falls back to the single TWILIO_WHATSAPP_FROM.
export function whatsappSenders(): string[] {
  const list = cleanEnv(process.env.TWILIO_WHATSAPP_SENDERS);
  const items = (list ? list.split(",") : [cleanEnv(process.env.TWILIO_WHATSAPP_FROM)])
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => (s.startsWith("whatsapp:") ? s : `whatsapp:${s}`));
  return Array.from(new Set(items));
}

// Normalise a WhatsApp sender to bare digits (+ allowed) for comparison.
const bareNumber = (s?: string) => cleanEnv(s).replace(/^whatsapp:/, "").replace(/[^\d+]/g, "");

// Resolve the Twilio account creds for a given WhatsApp sender number. Each number
// belongs to exactly ONE (sub)account: the marketing number -> the marketing account,
// anything else -> the utility/default account. A send FROM the marketing number MUST
// use the marketing creds, else Twilio rejects it (the utility account does not own
// that number). Falls back to utility when the marketing lane is not configured, so a
// mismatched marketing template simply fails to send rather than going out wrong-lane.
export function credsForSender(from?: string): { sid: string; token: string } {
  const f = bareNumber(from);
  const mktFrom = bareNumber(process.env.TWILIO_MKT_WHATSAPP_FROM);
  const mktSid = cleanEnv(process.env.TWILIO_MKT_ACCOUNT_SID);
  const mktToken = cleanEnv(process.env.TWILIO_MKT_AUTH_TOKEN);
  const utilFrom = bareNumber(process.env.TWILIO_WHATSAPP_FROM);
  const mktConfigured = !!(mktSid && mktToken);
  // A WhatsApp number belongs to exactly ONE (sub)account, so a send FROM a number
  // MUST auth with that number's account or Twilio rejects the (foreign) ContentSid
  // with the misleading 21656 "Content Variables parameter is invalid". Route to the
  // marketing lane when the chosen sender is the configured marketing number, OR -
  // as a self-healing fallback when TWILIO_MKT_WHATSAPP_FROM is unset - whenever a
  // NON-utility sender is chosen and the marketing lane is configured. This keeps the
  // marketing send working even if the marketing-FROM env var was never set.
  if (f && mktConfigured && (f === mktFrom || (utilFrom && f !== utilFrom)))
    return { sid: mktSid, token: mktToken };
  return { sid: cleanEnv(process.env.TWILIO_ACCOUNT_SID), token: cleanEnv(process.env.TWILIO_AUTH_TOKEN) };
}

// Resolve the Twilio creds of the (sub)account that OWNS a Content template. Each
// approved template lives on exactly ONE account; only that account can send it, else
// Twilio rejects with the misleading 21656 "Content Variables parameter is invalid".
// Probe the marketing lane first (a cheap GET), fall back to utility. This makes a
// marketing send work off the marketing creds alone - no dependence on the
// TWILIO_*_WHATSAPP_FROM env vars, which is what kept breaking the send test.
export async function credsForContent(contentSid: string): Promise<{ sid: string; token: string }> {
  const mktSid = cleanEnv(process.env.TWILIO_MKT_ACCOUNT_SID);
  const mktToken = cleanEnv(process.env.TWILIO_MKT_AUTH_TOKEN);
  const mktAuth = marketingAuthHeader();
  if (mktAuth && mktSid && mktToken) {
    try {
      const res = await fetch(`https://content.twilio.com/v1/Content/${contentSid}`, { headers: { Authorization: mktAuth } });
      if (res.ok) return { sid: mktSid, token: mktToken };
    } catch { /* fall through to utility */ }
  }
  return { sid: cleanEnv(process.env.TWILIO_ACCOUNT_SID), token: cleanEnv(process.env.TWILIO_AUTH_TOKEN) };
}

async function postMessage(form: URLSearchParams, opts?: { sendAt?: string; from?: string; creds?: { sid: string; token: string } }) {
  // Resolve the sender we actually want this message to go out from: the caller's
  // chosen number, else the default TWILIO_WHATSAPP_FROM.
  const resolvedFrom = opts?.from
    ? (opts.from.startsWith("whatsapp:") ? opts.from : `whatsapp:${opts.from}`)
    : cleanEnv(process.env.TWILIO_WHATSAPP_FROM);

  // Auth with the account that OWNS this message: an explicit override (e.g. the
  // account that owns the Content template) wins, else infer from the sender number.
  const { sid, token } = opts?.creds || credsForSender(resolvedFrom);

  // Scheduled sends require a Messaging Service + ScheduleType=fixed. BUT we must
  // ALSO set From: without it Twilio picks any number from the MS sender pool, so
  // a scheduled marketing broadcast could go out from an UNINTENDED number (wrong
  // brand identity, and it breaks per-number quality tracking). Twilio accepts From
  // together with MessagingServiceSid and honours the explicit From, so we always
  // pin the resolved sender. Immediate sends just use From.
  if (opts?.sendAt && MESSAGING_SERVICE_SID()) {
    form.set("MessagingServiceSid", MESSAGING_SERVICE_SID());
    form.set("ScheduleType", "fixed");
    form.set("SendAt", opts.sendAt);
    if (resolvedFrom) form.set("From", resolvedFrom); // pin the chosen number
  } else {
    form.set("From", resolvedFrom);
  }
  const cb = statusCallbackUrl();
  if (cb) form.set("StatusCallback", cb);
  const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`, {
    method: "POST",
    headers: {
      Authorization: "Basic " + Buffer.from(`${sid}:${token}`).toString("base64"),
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: form,
  });
  const data = await res.json();
  if (!res.ok) throw twilioError(res.status, data, "Twilio send failed");
  return data; // includes sid, status
}

// Cancel a still-scheduled message. Twilio only allows this while the message
// is in the "scheduled" state (before SendAt); otherwise it 400s.
export async function cancelMessage(messageSid: string) {
  const sid = cleanEnv(process.env.TWILIO_ACCOUNT_SID);
  const token = cleanEnv(process.env.TWILIO_AUTH_TOKEN);
  const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages/${messageSid}.json`, {
    method: "POST",
    headers: {
      Authorization: "Basic " + Buffer.from(`${sid}:${token}`).toString("base64"),
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({ Status: "canceled" }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw twilioError(res.status, data, `Cancel failed (${res.status})`);
  return data;
}

const waTo = (toE164: string) => (toE164.startsWith("whatsapp:") ? toE164 : `whatsapp:${toE164}`);

// Free-form message (only valid inside the 24h customer-service window).
export async function sendWhatsApp(toE164: string, body: string, from?: string) {
  return postMessage(new URLSearchParams({ To: waTo(toE164), Body: body }), from ? { from } : undefined);
}

// Free-form media message (image / PDF / etc.) with an optional caption.
// Also only valid inside the 24h window.
export async function sendMediaWhatsApp(toE164: string, mediaUrl: string, body?: string, from?: string) {
  const form = new URLSearchParams({ To: waTo(toE164), MediaUrl: mediaUrl });
  if (body) form.set("Body", body);
  return postMessage(form, from ? { from } : undefined);
}

// Approved template message (works outside the 24h window). Pass sendAt (ISO)
// to schedule it via Twilio (15 min to 7 days out), and/or a from sender.
export async function sendTemplate(toE164: string, contentSid: string, variables?: Record<string, string>, sendAt?: string, from?: string) {
  const form = new URLSearchParams({ To: waTo(toE164), ContentSid: contentSid });
  if (variables && Object.keys(variables).length) form.set("ContentVariables", JSON.stringify(variables));
  // Auth with the account that owns the template, not just the sender's inferred lane.
  const creds = await credsForContent(contentSid);
  return postMessage(form, { sendAt, from, creds });
}
