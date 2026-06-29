import { supabaseAdmin } from "@/lib/supabase";

// Resolves a Meta ad's stable public preview link (Instagram permalink, Facebook
// permalink fallback) for the agent alert, keyed by ad_id.
//
// Real-time + self-healing: a cache HIT in ad_creatives returns instantly with no
// Meta call; a cache MISS (a brand-new ad we have never seen) triggers ONE live
// Graph fetch, upserts the row, and returns it — so a new ad's leads carry the
// preview link immediately, with no periodic sync and no gap. Every later lead for
// that ad is a cache hit.
//
// The live fetch needs an ads-read token: META_ADS_TOKEN if set, else the existing
// META_SYSTEM_TOKEN (used only if the system user has ads_read). Best-effort: any
// failure just yields no link — it never blocks routing the lead.

const V = () => (process.env.META_API_VERSION || "v21.0").trim();
const adsToken = () => (process.env.META_ADS_TOKEN || process.env.META_SYSTEM_TOKEN || "").trim();

export async function resolveAdPreview(adId: string): Promise<string> {
  const id = (adId || "").trim();
  if (!id) return "";
  const db = supabaseAdmin();

  // 1) Cache hit — no Meta call.
  const { data: cached } = await db
    .from("ad_creatives")
    .select("ig_permalink, fb_permalink")
    .eq("ad_id", id)
    .maybeSingle();
  if (cached && (cached.ig_permalink || cached.fb_permalink)) {
    return String(cached.ig_permalink || cached.fb_permalink);
  }

  // 2) Cache miss — fetch this ad live, cache it, use it.
  const token = adsToken();
  if (!token) return "";
  try {
    const fields =
      "id,name,effective_status,campaign{name},adset{name}," +
      "creative{title,body,thumbnail_url,image_url,instagram_permalink_url,effective_object_story_id}";
    const u = new URL(`https://graph.facebook.com/${V()}/${id}`);
    u.searchParams.set("fields", fields);
    u.searchParams.set("access_token", token);
    const r = await fetch(u.toString(), { cache: "no-store" });
    const a = await r.json().catch(() => ({}));
    if (!r.ok || a?.error) return "";
    const c = a.creative || {};
    const story = c.effective_object_story_id;
    const row = {
      ad_id: id,
      ad_name: a.name || null,
      headline: c.title || null,
      body: c.body || null,
      ig_permalink: c.instagram_permalink_url || null,
      fb_permalink: story ? `https://www.facebook.com/${story}` : null,
      image_url: c.image_url || c.thumbnail_url || null,
      effective_status: a.effective_status || null,
      campaign_name: a.campaign?.name || null,
      adset_name: a.adset?.name || null,
      synced_at: new Date().toISOString(),
    };
    await db.from("ad_creatives").upsert(row, { onConflict: "ad_id" });
    return String(row.ig_permalink || row.fb_permalink || "");
  } catch {
    return "";
  }
}
