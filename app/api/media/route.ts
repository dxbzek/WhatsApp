import { NextRequest, NextResponse } from "next/server";
import { twilioCreds } from "@/lib/twilio";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Authenticated proxy for inbound Twilio media. Twilio media URLs require
// Basic auth to fetch, so the browser can't load them directly - this streams
// them through with credentials. Only proxies api.twilio.com URLs (no SSRF).
export async function GET(req: NextRequest) {
  const url = req.nextUrl.searchParams.get("url") || "";
  let host = "";
  try { host = new URL(url).hostname; } catch { return NextResponse.json({ error: "Bad url" }, { status: 400 }); }
  if (!host.endsWith("api.twilio.com")) return NextResponse.json({ error: "Forbidden host" }, { status: 403 });

  const { authHeader } = twilioCreds();
  // redirect:manual so the Twilio Basic-auth header is never re-sent to a
  // redirect target off api.twilio.com (the host check only covers the first hop).
  const res = await fetch(url, { headers: { Authorization: authHeader }, redirect: "manual" });
  if (res.status >= 300 && res.status < 400) return NextResponse.json({ error: "Unexpected redirect" }, { status: 502 });
  if (!res.ok) return NextResponse.json({ error: `Media ${res.status}` }, { status: res.status });

  const buf = await res.arrayBuffer();
  return new NextResponse(buf, {
    headers: {
      "Content-Type": res.headers.get("content-type") || "application/octet-stream",
      "Cache-Control": "private, max-age=86400",
    },
  });
}
