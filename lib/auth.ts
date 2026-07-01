// Lightweight signed-session auth for the single marketing user.
// HMAC-SHA256 over {email,exp}; uses Web Crypto so it runs in BOTH the edge
// middleware and Node API routes. No DB, no external auth provider.
const enc = new TextEncoder();
const clean = (v?: string) => (v || "").replace(/^\uFEFF/, "").trim();

const SECRET = () => clean(process.env.AUTH_SECRET) || "dev-insecure-secret-change-me";
export const ALLOWED_EMAIL = () => (clean(process.env.ALLOWED_EMAIL) || "marketing@erehomes.ae").toLowerCase();
export const APP_PASSWORD = () => clean(process.env.APP_PASSWORD);
export const COOKIE = "ere_session";
const DAYS = 30;
export const COOKIE_MAX_AGE = (DAYS * 24 * 60 * 60); // seconds

function b64url(buf: ArrayBuffer | Uint8Array) {
  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function fromB64url(s: string) {
  const t = s.replace(/-/g, "+").replace(/_/g, "/");
  const pad = t.length % 4 ? 4 - (t.length % 4) : 0;
  const str = atob(t + "=".repeat(pad));
  const bytes = new Uint8Array(str.length);
  for (let i = 0; i < str.length; i++) bytes[i] = str.charCodeAt(i);
  return bytes;
}
async function hmac(data: string) {
  const key = await crypto.subtle.importKey("raw", enc.encode(SECRET()), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(data));
  return b64url(sig);
}

export async function signSession(email: string) {
  const payload = b64url(enc.encode(JSON.stringify({ email: email.toLowerCase(), exp: Date.now() + DAYS * 86400000 })));
  return `${payload}.${await hmac(payload)}`;
}

// Optional admin allowlist for export/CRM routes (#14). The app runs on a SINGLE
// shared login with no per-user roles, so by default (ADMIN_EMAILS unset) every
// authenticated session is treated as admin — this preserves the single-login
// flow. If ADMIN_EMAILS is set (comma-separated), only those emails pass. The
// session email is already restricted to ALLOWED_EMAIL, so this is mainly a
// forward-looking guard for when multiple logins are added.
// TODO: replace with a real per-user role once multi-user auth exists.
export function adminEmails(): string[] {
  return clean(process.env.ADMIN_EMAILS)
    .toLowerCase()
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

// Returns true if the request's session is allowed to perform admin-only actions.
// Reads the signed session cookie directly (API routes don't otherwise re-verify;
// middleware only guarantees SOME valid session). Never throws.
export async function isAdminRequest(req: { cookies: { get(name: string): { value: string } | undefined } }): Promise<boolean> {
  try {
    const session = await verifySession(req.cookies.get(COOKIE)?.value);
    if (!session) return false;
    const allow = adminEmails();
    if (allow.length === 0) return true; // no allowlist configured -> single-login stays admin
    return allow.includes(session.email.toLowerCase());
  } catch {
    return false;
  }
}

export async function verifySession(token?: string | null): Promise<{ email: string } | null> {
  if (!token || !token.includes(".")) return null;
  const [payload, sig] = token.split(".");
  if ((await hmac(payload)) !== sig) return null;
  try {
    const data = JSON.parse(new TextDecoder().decode(fromB64url(payload)));
    if (!data.exp || data.exp < Date.now()) return null;
    if (data.email !== ALLOWED_EMAIL()) return null;
    return { email: data.email };
  } catch {
    return null;
  }
}
