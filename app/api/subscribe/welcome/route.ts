import { NextRequest, NextResponse } from "next/server";
import nodemailer from "nodemailer";
import { renderWelcome } from "@/lib/emails/welcomeSubscriber";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Welcome email for a new erehomes.ae newsletter subscriber.
//
// Until 27 Aug 2026 the site's popup posted straight to Mailchimp's embedded form endpoint,
// so a subscriber existed only inside Mailchimp: nobody at ERE could see who had signed up
// without logging in there, and our own email_subscribers table held 2 rows from a June
// import (Zek: "Can we know who subscribed to us", "we need the emails to the ones who sign
// up"). The popup now writes the person into the website's own site_subscribers table and
// calls this route, which sends the welcome.
//
// Why the console sends it and not the web server: erehomes.ae publishes SPF as
// "v=spf1 include:_spf.google.com ~all" and its MX is Google Workspace, so mail from the
// Hostinger box over PHP mail() is unaligned and lands in spam for a stranger's inbox. This
// process holds the marketing@erehomes.ae SMTP credential, so what it sends is signed by
// Google and passes SPF and DKIM.
//
// The site holds no CRM or mailbox credential, only the shared secret it already uses for
// the lead hop:
//   WEBSITE_LEAD_SECRET  x-lead-secret header, same value as the /api/leads/website route
//   LEAD_SMTP_*          the marketing@ mailbox this sends from
//
// Idempotency lives UPSTREAM, in a unique index on lower(email) in site_subscribers: a repeat
// signup is rejected by the database and the popup never calls this route, so one address can
// only ever be welcomed once. Nothing here can pretend to have sent, and nothing here throws
// into the visitor's request: a failed welcome must not cost us the subscriber.

const UNSUB_BASE = "https://erehomes.ae/unsubscribe/";

// The website's own Supabase, where site_subscribers lives. The key below is the PUBLISHABLE
// anon key, not a secret: the same string is served to every visitor inside erehomes.ae's own
// JavaScript, and the table grants anon nothing but INSERT plus these two functions. It is
// inlined rather than put in the environment so this route cannot silently lose the ability
// to check a claim and fall back to emailing whatever address it was handed.
const SITE_SB = "https://qevdpwzacmqbdrjdfgbb.supabase.co";
const SITE_SB_ANON = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InFldmRwd3phY21xYmRyamRmZ2JiIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODIwMzI5NDgsImV4cCI6MjA5NzYwODk0OH0.DBAIptOstQyYZmnZ3LKmgP9pJLa0MWMOyP8EibqPICA";

// Claim the row before sending. Returns false when the email and token do not match a real,
// unwelcomed subscriber, which is what stops lead-alert.php (a public endpoint) being used to
// send mail from our domain to any address someone chooses.
async function claimWelcome(fn: string, email: string, token: string): Promise<boolean> {
  try {
    const r = await fetch(`${SITE_SB}/rest/v1/rpc/${fn}`, {
      method: "POST",
      headers: { apikey: SITE_SB_ANON, Authorization: `Bearer ${SITE_SB_ANON}`, "Content-Type": "application/json" },
      body: JSON.stringify({ p_email: email, p_token: token }),
    });
    if (!r.ok) return false;
    return (await r.json()) === true;
  } catch {
    return false;
  }
}

function ok(email: string): boolean {
  return /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email) && email.length <= 320;
}

export async function POST(req: NextRequest) {
  const secret = process.env.WEBSITE_LEAD_SECRET || "";
  if (!secret || req.headers.get("x-lead-secret") !== secret) {
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }

  let body: any = {};
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ ok: false, error: "bad json" }, { status: 400 });
  }

  const email = String(body?.email || "").trim().toLowerCase();
  // The token is generated in the browser and stored on the subscriber's row. It is opaque
  // and only ever compared against that row, so it carries no privilege of its own.
  const token = String(body?.unsub_token || "").replace(/[^A-Za-z0-9_-]/g, "");
  if (!ok(email)) return NextResponse.json({ ok: false, error: "bad email" }, { status: 400 });
  if (token.length < 24 || token.length > 128) {
    return NextResponse.json({ ok: false, error: "bad token" }, { status: 400 });
  }

  const host = process.env.LEAD_SMTP_HOST || "smtp.gmail.com";
  const port = Number(process.env.LEAD_SMTP_PORT || 465);
  const user = process.env.LEAD_SMTP_USER || "marketing@erehomes.ae";
  const pass = process.env.LEAD_SMTP_PASS || "";
  // With no mailbox password configured this sends NOTHING and says so, rather than
  // returning a 200 that reads like a delivered email.
  if (!pass) return NextResponse.json({ ok: false, error: "smtp not configured" }, { status: 503 });

  // No claim, no email. Either the pair is not a real subscriber, or this person has already
  // been welcomed and something is replaying the call.
  const claimed = await claimWelcome("subscriber_claim_welcome", email, token);
  if (!claimed) return NextResponse.json({ ok: true, sent: null, skipped: "not a new subscriber" });

  const unsubUrl = `${UNSUB_BASE}?t=${encodeURIComponent(token)}`;
  const { html, text } = renderWelcome(email, unsubUrl);

  try {
    const transport = nodemailer.createTransport({ host, port, secure: port === 465, auth: { user, pass } });
    await transport.sendMail({
      from: `ERE Homes <${user}>`,
      to: email,
      subject: "You are on the list",
      text,
      html,
      // Gmail and Outlook surface their own unsubscribe control from this header, which keeps
      // a bored reader off the spam button. No List-Unsubscribe-Post: that promises a one-click
      // POST endpoint and /unsubscribe/ is a page, so claiming it would break their control.
      headers: { "List-Unsubscribe": `<${unsubUrl}>` },
    });
    return NextResponse.json({ ok: true, sent: email });
  } catch (e: any) {
    // Hand the claim back so a retry can still reach them, rather than marking someone
    // welcomed on the strength of an email that never left the building.
    await claimWelcome("subscriber_release_welcome", email, token);
    return NextResponse.json({ ok: false, error: String(e?.message || e).slice(0, 200) }, { status: 502 });
  }
}
