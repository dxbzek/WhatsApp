// Read-only access to the ERE audience CRM (Supabase) for building segments.
const clean = (v?: string) => (v || "").replace(/^\uFEFF/, "").trim();
const URL = () => clean(process.env.CRM_SUPABASE_URL);
const KEY = () => clean(process.env.CRM_SUPABASE_KEY);

const FILTERABLE = ["community", "nationality", "unit_type", "building", "tier", "verified_source"];

// A UAE mobile in E.164 (+971 5X XXX XXXX). WhatsApp only delivers to mobiles,
// so filtering to these cuts most "invalid recipient" (63024) bounces.
const isUaeMobile = (e164: string) => /^\+9715\d{8}$/.test(e164);

async function crmGet(path: string) {
  const res = await fetch(`${URL()}/rest/v1/${path}`, {
    headers: { apikey: KEY(), Authorization: `Bearer ${KEY()}` },
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`CRM ${res.status}: ${text.slice(0, 160)}`);
  return JSON.parse(text);
}

// Distinct values + counts for a filter column (from the small filter_options table).
export async function crmOptions(col: string) {
  if (!FILTERABLE.includes(col)) throw new Error("Unsupported column");
  const rows = await crmGet(`filter_options?col=eq.${col}&select=val,n&order=n.desc&limit=400`);
  return (rows || []).filter((r: any) => r.val && r.val !== "#N/A");
}

// Shared WHERE clause: only contactable numbers (has phone, not do-not-call,
// not uncontactable, not a switchboard) plus any chosen filters.
function contactableParts(filters: Record<string, string>) {
  const parts = [
    "phone=not.is.null",
    "do_not_call=eq.N",
    "is_uncontactable=not.is.true",
    "phone_is_switchboard=not.is.true",
  ];
  for (const [k, v] of Object.entries(filters || {})) {
    if (v && FILTERABLE.includes(k)) parts.push(`${k}=eq.${encodeURIComponent(v)}`);
  }
  // Number of properties (stored in number_of_transactions): exact, or "10+" => >= 10.
  const props = String(filters?.number_of_properties || "").trim();
  if (props) {
    const n = props.replace(/[^0-9]/g, "");
    if (n) parts.push(props.includes("+") ? `number_of_transactions=gte.${n}` : `number_of_transactions=eq.${n}`);
  }
  // Property value band (customizable min/max AED).
  const vmin = String(filters?.value_min || "").replace(/[^0-9]/g, "");
  const vmax = String(filters?.value_max || "").replace(/[^0-9]/g, "");
  if (vmin) parts.push(`total_transaction_value_aed=gte.${vmin}`);
  if (vmax) parts.push(`total_transaction_value_aed=lte.${vmax}`);
  return parts;
}

// Normalize a messy CRM phone to E.164 (UAE-centric). CRM stores things like
// ".0502077152" / "0502077152" / "971..." - campaigns need a real + number.
function toE164(raw: string): string {
  let d = (raw || "").replace(/[^0-9]/g, "");
  if (!d) return "";
  if (d.startsWith("971")) return `+${d}`;
  if (d.startsWith("00")) return `+${d.slice(2)}`;
  if (d.startsWith("0")) d = d.slice(1);
  if (d.length === 9 && d.startsWith("5")) return `+971${d}`; // UAE mobile
  return `+${d}`;
}

const CRM_RECIP_COLS = "phone,name,community,building,unit_number,nationality,tier";

// Contactable recipients matching the chosen filters, with the fields used to
// personalize template variables. Phones normalized + deduped.
export async function crmContacts(filters: Record<string, string>, limit: number) {
  const want = Math.min(Math.max(limit || 500, 1), 5000);
  // Mobile-only is on unless explicitly disabled. Over-pull so we can still
  // return up to `want` recipients after dropping non-mobiles + dupes.
  const mobileOnly = filters?.mobile_only !== "0" && (filters as any)?.mobile_only !== false;
  const fetchN = mobileOnly ? Math.min(want * 3, 5000) : want;
  const parts = [`select=${CRM_RECIP_COLS}`, ...contactableParts(filters)];
  parts.push(`limit=${fetchN}`);
  const rows = await crmGet(`contacts?${parts.join("&")}`);
  const seen = new Set<string>();
  const out: any[] = [];
  for (const r of rows || []) {
    const phone = toE164(r.phone);
    if (!phone || seen.has(phone)) continue;
    if (mobileOnly && !isUaeMobile(phone)) continue;
    seen.add(phone);
    out.push({ phone, name: r.name || "", community: r.community || "", building: r.building || "", unit_number: r.unit_number || "", nationality: r.nationality || "", tier: r.tier || "" });
    if (out.length >= want) break;
  }
  return out;
}

// Look up a single CRM contact by a WhatsApp number (E.164 digits, no +).
// CRM phones are stored inconsistently (e.g. ".0502077152", local "05..."),
// so we try several format variants against an indexed equality/in lookup.
const CRM_CONTACT_COLS = "name,community,building,tier,nationality,unit_type,total_transaction_value_aed,number_of_transactions,has_bought_before,has_sold_before,last_transaction_date,do_not_call,verified_source,source_batch,source_path";

function phoneVariants(wa: string): string[] {
  const digits = (wa || "").replace(/[^0-9]/g, "");
  if (!digits) return [];
  // Cover the formats the CRM is known to store: E.164 (+9715..), bare digits,
  // 00-prefixed intl, national (5..), 0-prefixed national (05..), and the
  // observed leading-dot variants of each.
  const set = new Set<string>([`+${digits}`, digits, `00${digits}`]);
  let national = digits;
  if (digits.startsWith("971")) national = digits.slice(3);
  else if (digits.startsWith("00971")) national = digits.slice(5);
  for (const n of [national, `0${national}`, `971${national}`]) {
    set.add(n);
    set.add(`.${n}`); // observed leading-dot format
  }
  return Array.from(set);
}

// The subscriber's last 9 digits — a format-proof key. "+971 50 123 4567",
// "0501234567", "971501234567" and ".0501234567" all reduce to "501234567",
// so this catches every separator/prefix variant AND lets us match the
// secondary phone2 field, which exact-variant matching never could.
function lastNine(wa: string): string {
  return (wa || "").replace(/[^0-9]/g, "").slice(-9);
}

export async function crmContactByPhone(wa: string) {
  // Preferred path: match the indexed, normalized last-9-digit keys on BOTH
  // phone fields. Requires the phone_norm / phone2_norm generated columns +
  // indexes (see docs/crm-phone-norm.sql). If they don't exist yet the query
  // 400s instantly and we fall back to the legacy variant match — no regression.
  const key = lastNine(wa);
  if (key.length === 9) {
    try {
      const rows = await crmGet(`contacts?or=(phone_norm.eq.${key},phone2_norm.eq.${key})&select=${CRM_CONTACT_COLS}&limit=1`);
      // Columns exist: trust the result (a miss here is a genuine "not in CRM").
      return (rows && rows[0]) || null;
    } catch { /* columns not created yet — fall through to legacy match */ }
  }

  // Legacy fallback: exact-match hand-built format variants on the indexed
  // `phone` column only (phone2 excluded — unindexed full scan would time out).
  const variants = phoneVariants(wa);
  if (!variants.length) return null;
  const inList = variants.map((v) => `"${v}"`).join(",");
  const rows = await crmGet(`contacts?phone=in.(${inList})&select=${CRM_CONTACT_COLS}&limit=1`);
  return (rows && rows[0]) || null;
}

// Approximate count of contactable contacts matching filters. Uses the
// planner's row estimate (Prefer: count=estimated) so it's fast and never
// trips the anon statement timeout on the 9.48M-row contacts table.
export async function crmCount(filters: Record<string, string>) {
  const parts = ["select=phone", ...contactableParts(filters), "limit=1"];
  const res = await fetch(`${URL()}/rest/v1/contacts?${parts.join("&")}`, {
    headers: { apikey: KEY(), Authorization: `Bearer ${KEY()}`, Prefer: "count=estimated" },
  });
  if (!res.ok) throw new Error(`CRM ${res.status}: ${(await res.text()).slice(0, 160)}`);
  const total = parseInt((res.headers.get("content-range") || "").split("/")[1] || "0", 10);
  return isNaN(total) ? 0 : total;
}
