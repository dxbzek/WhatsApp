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

// Flag a contact as a broker/agent so they are blocked from ALL owner/buyer
// marketing, and so the next audience refresh excludes them from Meta. Upsert by
// phone: update if the contact already exists (e.g. synced as a Buyer Lead on
// ingest), else insert a minimal broker record. Never touches phone fields on an
// update (a CRM trigger wipes phone_e164 if it is set directly). Best-effort.
export async function crmFlagBroker(e164: string, name?: string): Promise<{ ok: boolean; skipped?: string; error?: string }> {
  const db = crmAdmin();
  if (!db) return { ok: false, skipped: "crm_unconfigured" };
  const bare = clean(e164).replace("+", "");
  if (!bare) return { ok: false, skipped: "no_phone" };
  const { data: existing, error: selErr } = await db.from("contacts").select("id").eq("phone_e164", bare).limit(1);
  if (selErr) return { ok: false, error: selErr.message };
  if (existing && existing.length) {
    const { error } = await db.from("contacts").update({ is_broker: true, contact_category: "Broker" }).eq("id", existing[0].id);
    return error ? { ok: false, error: error.message } : { ok: true };
  }
  const { error } = await db.from("contacts").insert({
    name: clean(name) || null, phone: "+" + bare, phone_e164: bare, phone_norm: bare.slice(-9),
    is_broker: true, contact_category: "Broker", lead_source: "meta_lead_form", source_batch: "meta_broker_flag",
  });
  return error ? { ok: false, error: error.message } : { ok: true };
}

// Tag a contact as a "Meta Lead Enquirer" (reached but not interested right now)
// so they stay in the CRM for future nurture instead of being lost. Upsert by
// phone; never re-tags a known broker as a nurture lead. Best-effort.
export async function crmTagEnquirer(e164: string, name?: string, detail?: string): Promise<{ ok: boolean; skipped?: string; error?: string }> {
  const db = crmAdmin();
  if (!db) return { ok: false, skipped: "crm_unconfigured" };
  const bare = clean(e164).replace("+", "");
  if (!bare) return { ok: false, skipped: "no_phone" };
  const { data: existing, error: selErr } = await db.from("contacts").select("id, is_broker").eq("phone_e164", bare).limit(1);
  if (selErr) return { ok: false, error: selErr.message };
  if (existing && existing.length) {
    if (existing[0].is_broker) return { ok: true, skipped: "is_broker" };
    const { error } = await db.from("contacts").update({ contact_category: "Meta Lead Enquirer" }).eq("id", existing[0].id);
    return error ? { ok: false, error: error.message } : { ok: true };
  }
  const { error } = await db.from("contacts").insert({
    name: clean(name) || null, phone: "+" + bare, phone_e164: bare, phone_norm: bare.slice(-9),
    lead_source: "meta_lead_form", contact_category: "Meta Lead Enquirer",
    source_batch: detail ? `meta:${clean(detail)}` : "meta_lead_form",
  });
  return error ? { ok: false, error: error.message } : { ok: true };
}
