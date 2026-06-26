import crypto from "crypto";
import type { NextRequest } from "next/server";

// Validate Twilio's X-Twilio-Signature: HMAC-SHA1 of (full URL + each POST param
// appended in key-sorted order), base64, keyed by the account auth token.
// https://www.twilio.com/docs/usage/security#validating-requests
export function isValidTwilioSignature(authToken: string, signature: string, url: string, params: Record<string, string>): boolean {
  if (!authToken || !signature) return false;
  const data = url + Object.keys(params).sort().map((k) => k + params[k]).join("");
  const expected = crypto.createHmac("sha1", authToken).update(Buffer.from(data, "utf-8")).digest("base64");
  try {
    const a = Buffer.from(expected);
    const b = Buffer.from(signature);
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  } catch {
    return false;
  }
}

// Reconstruct the exact public URL Twilio signed (proto + host from the proxy
// headers + path + query — Twilio includes any configured query params).
function publicUrl(req: NextRequest): string {
  const proto = req.headers.get("x-forwarded-proto") || "https";
  const host = req.headers.get("x-forwarded-host") || req.headers.get("host") || "";
  return `${proto}://${host}${req.nextUrl.pathname}${req.nextUrl.search}`;
}

// Verify an incoming Twilio webhook. Returns whether the request should be
// allowed. SAFE ROLLOUT: by default this only LOGS a mismatch and still allows
// the request (so a signature/URL quirk can't silently kill live webhooks). It
// only rejects once TWILIO_ENFORCE_SIGNATURE=1 is set — flip that after you see
// "[twilio-sig] ok" in the logs. Returns { ok, allow }.
export function verifyTwilioWebhook(req: NextRequest, params: Record<string, string>): { ok: boolean; allow: boolean } {
  const token = (process.env.TWILIO_AUTH_TOKEN || "").replace(/^﻿/, "").trim();
  const signature = req.headers.get("x-twilio-signature") || "";
  const enforce = process.env.TWILIO_ENFORCE_SIGNATURE === "1";
  const ok = isValidTwilioSignature(token, signature, publicUrl(req), params);
  if (!ok) {
    // eslint-disable-next-line no-console
    console.warn(`[twilio-sig] mismatch on ${req.nextUrl.pathname} (enforce=${enforce})`);
    return { ok, allow: !enforce };
  }
  return { ok, allow: true };
}
