import { createClient } from "@supabase/supabase-js";

// Strip a leading UTF-8 BOM / stray whitespace that can sneak into env vars
// (e.g. when set from a BOM-encoded file) and break realtime auth / keys.
const clean = (v?: string) => (v || "").replace(/^\uFEFF/, "").trim();

// Fallbacks keep the build from hard-failing if an env var is briefly
// missing at prerender time; real values are injected at build/runtime.
const URL = clean(process.env.NEXT_PUBLIC_SUPABASE_URL) || "https://placeholder.supabase.co";

// NOTE: there is intentionally NO browser/anon Supabase client. The public anon
// key is exposed in the client bundle and bypasses the app login gate, so the UI
// must never read these tables directly. All DB access goes through the gated
// /api/* routes below using the service role, and RLS denies anon at the DB.

// Server/service client (writes from API routes only - never import in client code)
//
// cache: "no-store" is CRITICAL. Next 14 patches global fetch with its Data
// Cache, and supabase-js GETs are plain fetches — small responses (a thread
// query, unreadCount) get cached indefinitely at the edge, so the inbox thread
// froze while the conversation list (too big to cache, >2MB) stayed live.
// `dynamic = "force-dynamic"` on the routes does NOT opt these fetches out.
export const supabaseAdmin = () =>
  createClient(
    URL,
    clean(process.env.SUPABASE_SERVICE_ROLE_KEY) || "placeholder",
    {
      auth: { persistSession: false },
      global: { fetch: (url, options) => fetch(url, { ...options, cache: "no-store" }) },
    }
  );
