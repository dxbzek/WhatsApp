// Meta Graph API helpers for pulling Instant-Form leads directly (no Zapier).
// Uses a long-lived system-user token (META_SYSTEM_TOKEN) that has leads_retrieval
// + pages_show_list + pages_read_engagement, derives the Page token from it, then
// lists the Page's lead forms and reads each form's leads.
//
// Env:
//   META_SYSTEM_TOKEN  - system-user token with the scopes above
//   META_PAGE_ID       - the ERE Homes Page id (e.g. 423270230859064)
//   META_API_VERSION   - optional, defaults to v21.0

const V = () => (process.env.META_API_VERSION || "v21.0").trim();
const GRAPH = () => `https://graph.facebook.com/${V()}`;
const sysToken = () => (process.env.META_SYSTEM_TOKEN || "").trim();
const pageId = () => (process.env.META_PAGE_ID || "").trim();

export type MetaLead = {
  id: string;            // leadgen_id (dedupe key)
  created_time: string;
  name: string;
  phone: string;
  email: string;
  detail: string;        // campaign name — what routing matches on
  listing: string;       // cleaned ad-set/ad name — the specific property, for the alert
};

// Turn a pipe-named ad asset ("ERE | Marina Residences 1 | Palm Jumeirah | 24 Jun
// 2026") into a human listing label ("Marina Residences 1 · Palm Jumeirah") by
// dropping the ERE prefix and the trailing date stamp.
function cleanLabel(s: string): string {
  if (!s) return "";
  return s
    .split("|")
    .map((p) => p.trim())
    .filter(Boolean)
    .filter((p) => p.toUpperCase() !== "ERE")
    .filter((p) => !/^\d{1,2}\s+[A-Za-z]{3,}\s+\d{4}$/.test(p)) // strip "24 Jun 2026"
    .join(" · ");
}

async function graphGet(path: string, params: Record<string, string>, token: string): Promise<any> {
  const u = new URL(`${GRAPH()}/${path}`);
  for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);
  u.searchParams.set("access_token", token);
  const r = await fetch(u.toString(), { cache: "no-store" });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) {
    const msg = j?.error?.message || `Graph ${r.status}`;
    throw new Error(msg);
  }
  return j;
}

// Resolve the Page access token from the system-user token. Lead reads must use a
// Page token, not the system token, even with leads_retrieval granted.
export async function getPageToken(): Promise<string> {
  const token = sysToken();
  if (!token) throw new Error("META_SYSTEM_TOKEN not configured");
  const pid = pageId();
  if (!pid) throw new Error("META_PAGE_ID not configured");
  const j = await graphGet("me/accounts", { fields: "id,access_token", limit: "200" }, token);
  const page = (j.data || []).find((p: any) => String(p.id) === pid);
  if (!page?.access_token) throw new Error(`Page ${pid} not found on token (check scopes / page assignment)`);
  return page.access_token as string;
}

// List the Page's ACTIVE lead forms.
export async function listActiveForms(pageToken: string): Promise<{ id: string; name: string }[]> {
  const pid = pageId();
  const j = await graphGet(`${pid}/leadgen_forms`, { fields: "id,name,status", limit: "200" }, pageToken);
  return (j.data || [])
    .filter((f: any) => String(f.status).toUpperCase() === "ACTIVE")
    .map((f: any) => ({ id: String(f.id), name: String(f.name || "") }));
}

// Read a form's most recent leads, flattened to the fields we route on.
export async function fetchFormLeads(pageToken: string, formId: string, limit = 50): Promise<MetaLead[]> {
  const j = await graphGet(
    `${formId}/leads`,
    { fields: "id,created_time,ad_name,adset_name,campaign_name,field_data", limit: String(limit) },
    pageToken
  );
  return (j.data || []).map((l: any) => {
    const fd: Record<string, string> = {};
    for (const f of l.field_data || []) {
      const key = String(f.name || "").toLowerCase();
      const val = Array.isArray(f.values) ? f.values[0] : f.values;
      if (val != null) fd[key] = String(val);
    }
    const name =
      fd["full_name"] ||
      [fd["first_name"], fd["last_name"]].filter(Boolean).join(" ").trim();
    const phone = fd["phone_number"] || fd["phone"] || "";
    const email = fd["email"] || "";
    // Route on the campaign name; show the specific listing (ad set / ad) in the alert.
    const detail = l.campaign_name || l.adset_name || l.ad_name || "";
    const listing = cleanLabel(l.adset_name || l.ad_name || "");
    return { id: String(l.id), created_time: l.created_time, name, phone, email, detail, listing };
  });
}
