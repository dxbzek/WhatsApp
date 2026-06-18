import { NextRequest, NextResponse } from "next/server";
import { verifySession, COOKIE } from "@/lib/auth";

// Paths that must work without a session:
//  - /api/auth/*   : the login/logout endpoints themselves
//  - /api/twilio/* : Twilio webhooks (inbound + status) reach us unauthenticated
//  - /api/cron/*   : the drip dispatcher, poked by pg_cron (self-secured by CRON_SECRET)
//  - /api/leads/*  : Meta lead-form ingest from Zapier/Make (self-secured by LEAD_INGEST_SECRET)
const PUBLIC_API = ["/api/auth/", "/api/twilio/", "/api/cron/", "/api/leads/"];

export async function middleware(req: NextRequest) {
  const { pathname } = req.nextUrl;
  if (PUBLIC_API.some((p) => pathname.startsWith(p))) return NextResponse.next();

  const session = await verifySession(req.cookies.get(COOKIE)?.value);
  if (session) return NextResponse.next();

  // Unauthenticated:
  if (pathname.startsWith("/api/")) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (pathname === "/login") return NextResponse.next();

  const url = req.nextUrl.clone();
  url.pathname = "/login";
  url.searchParams.set("next", pathname);
  return NextResponse.redirect(url);
}

// Run on everything except Next internals / static assets.
export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
