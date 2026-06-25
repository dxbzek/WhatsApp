import { createClient } from "@supabase/supabase-js";

// Strip a leading UTF-8 BOM / stray whitespace that can sneak into env vars.
const clean = (v?: string) => (v || "").replace(/^﻿/, "").trim();

// The ERE owner/audience CRM lives in a DIFFERENT Supabase project from the
// WhatsApp console, so it needs its own service client. Returns null when the
// env vars are not set, letting callers no-op instead of breaking lead ingest.
//   CRM_SUPABASE_URL               e.g. https://dzcmyghqfrziowiojpxt.supabase.co
//   CRM_SUPABASE_SERVICE_ROLE_KEY  service_role key for that project
function crmAdmin() {
  const url = clean(process.env.CRM_SUPABASE_URL);
  const key = clean(process.env.CRM_SUPABASE_SERVICE_ROLE_KEY);
  if (!url || !key) return null;
  return createClient(url, key, { auth: { persistSession: false } });
}

// Mirrors a real property enquiry (Meta Instant-Form lead) into the CRM contacts
// table as a Buyer Lead so it shows up alongside owner records and can be worked.
// Recruitment applicants are NOT synced here (different audience - must never land
// in owner/seller broadcasts); the caller filters those out. Best-effort and
// idempotent: dedupes on phone_e164, returns a status, never throws.
export async function syncLeadToCrm(opts: {
  name?: string;
  e164: string;     // +9715xxxxxxxx (already normalised by the caller)
  email?: string;
  detail?: string;  // campaign name, kept as the source batch
}): Promise<{ ok: boolean; skipped?: string; id?: number; error?: string }> {
  const db = crmAdmin();
  if (!db) return { ok: false, skipped: "crm_unconfigured" };

  const bare = clean(opts.e164).replace("+", "");
  if (!bare) return { ok: false, skipped: "no_phone" };
  const norm = bare.slice(-9); // CRM phone_norm = last 9 digits (local number)
  const name = clean(opts.name);
  const email = clean(opts.email);
  const detail = clean(opts.detail);

  // Already in the CRM? phone_e164 is indexed, so this is cheap. Don't duplicate
  // an existing owner/contact record - just leave it be.
  const { data: existing, error: selErr } = await db
    .from("contacts").select("id").eq("phone_e164", bare).limit(1);
  if (selErr) return { ok: false, error: selErr.message };
  if (existing && existing.length) return { ok: true, skipped: "exists", id: existing[0].id };

  const { data, error } = await db.from("contacts").insert({
    name: name || null,
    phone: "+" + bare,
    phone_e164: bare,
    phone_norm: norm,
    email: email || null,
    lead_source: "meta_lead_form",
    contact_category: "Buyer Lead",
    source_batch: detail ? `meta:${detail}` : "meta_lead_form",
  }).select("id").single();
  if (error) return { ok: false, error: error.message };
  return { ok: true, id: data?.id };
}
