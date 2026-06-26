import { NextRequest, NextResponse } from "next/server";
import crypto from "crypto";
import { signSession, ALLOWED_EMAIL, APP_PASSWORD, COOKIE, COOKIE_MAX_AGE } from "@/lib/auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Best-effort per-IP throttle (per serverless instance) to blunt brute-forcing
// the single shared password: 10 tries per 15 min, then locked out.
const attempts = new Map<string, { n: number; reset: number }>();
function rateLimited(ip: string): boolean {
  const now = Date.now();
  const e = attempts.get(ip);
  if (!e || now > e.reset) { attempts.set(ip, { n: 1, reset: now + 15 * 60_000 }); return false; }
  e.n++;
  return e.n > 10;
}
// Constant-time compare (hash first so unequal lengths don't leak / throw).
function safeEqual(a: string, b: string): boolean {
  const ha = crypto.createHash("sha256").update(a).digest();
  const hb = crypto.createHash("sha256").update(b).digest();
  return crypto.timingSafeEqual(ha, hb);
}

// POST { email, password } -> sets a signed session cookie if it's the one
// allowed account with the correct password.
export async function POST(req: NextRequest) {
  const ip = (req.headers.get("x-forwarded-for") || "").split(",")[0].trim() || "unknown";
  if (rateLimited(ip)) return NextResponse.json({ error: "Too many attempts. Try again later." }, { status: 429 });

  const { email, password } = await req.json().catch(() => ({}));
  if (!email || !password) return NextResponse.json({ error: "Email and password required" }, { status: 400 });
  if (!APP_PASSWORD()) return NextResponse.json({ error: "Login is not configured yet (no password set)." }, { status: 503 });

  const ok = String(email).trim().toLowerCase() === ALLOWED_EMAIL() && safeEqual(String(password), APP_PASSWORD());
  if (!ok) return NextResponse.json({ error: "Invalid email or password" }, { status: 401 });

  const token = await signSession(ALLOWED_EMAIL());
  const res = NextResponse.json({ ok: true });
  res.cookies.set(COOKIE, token, { httpOnly: true, secure: true, sameSite: "lax", path: "/", maxAge: COOKIE_MAX_AGE });
  return res;
}
