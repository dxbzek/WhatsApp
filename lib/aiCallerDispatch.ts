/**
 * Fresh-lead AI call: dial a brand-new inbound lead within seconds of it landing.
 *
 * This is the ONE use case where the AI caller beats a human outright — the lead
 * just enquired, they are still looking at the listing, and unlike the archive
 * queue we KNOW what they enquired about (`detail`). That real basis is exactly
 * what the archive calls lacked ("what unit did I ask about?" → "I don't have
 * that", which ended every call).
 *
 * SAFETY — this is an OUTWARD action (a real phone call), so it is OFF by default
 * and gated three ways. It stays dormant until every gate is deliberately opened:
 *   1. AI_CALLER_AUTODIAL must be "1". Absent/anything else = log only, no dial.
 *      Keep it off until: a UAE number under ERE's licence is dialling (Cabinet
 *      Resolution 56/2024), the leads are DNCR-scrubbed, and the agent's close
 *      passes the sim suite 26/26.
 *   2. calling window 10:00–18:00 Asia/Dubai, Sun–Thu.
 *   3. recruitment leads never dial (different audience entirely).
 * Best-effort and non-throwing: a dial failure must NEVER break lead routing or
 * the Pipedrive sync it runs beside.
 */

const AGENT_ID = "agent_1601kxz9get3ftgvydastrp868mb";
const PHONE_NUMBER_ID = "phnum_1701kxzr3fk5e2cs5exgg8dggvgr";
const clean = (v?: string | null) => (v || "").trim();

function withinCallingWindow(): boolean {
  // Dubai is UTC+4 year-round.
  const dubai = new Date(Date.now() + 4 * 3600 * 1000);
  const day = dubai.getUTCDay(); // 0 Sun .. 6 Sat
  const hour = dubai.getUTCHours();
  const workingDay = day === 0 || (day >= 1 && day <= 4); // Sun–Thu
  return workingDay && hour >= 10 && hour < 18;
}

function firstName(raw?: string | null): string {
  const n = clean(raw).split(/\s+/)[0] || "";
  const clean1 = n.replace(/[^A-Za-z'\-]/g, "");
  if (clean1.length < 3 || !/[aeiou]/i.test(clean1)) return "";
  return clean1[0].toUpperCase() + clean1.slice(1);
}

export async function dispatchFreshLeadCall(opts: {
  name?: string | null;
  e164: string;            // +9715XXXXXXXX
  detail?: string | null;  // what they enquired about — the real basis
  source: string;          // "Meta Ad" | "WhatsApp Campaign" | portal
  isRecruitment?: boolean;
}): Promise<{ dialed: boolean; reason: string; conversationId?: string }> {
  try {
    const key = clean(process.env.ELEVENLABS_API_KEY);
    if (!key) return { dialed: false, reason: "elevenlabs_unconfigured" };
    if (opts.isRecruitment) return { dialed: false, reason: "recruitment_never_dials" };
    if (!/^\+\d{8,15}$/.test(opts.e164)) return { dialed: false, reason: "bad_e164" };
    if (!withinCallingWindow()) return { dialed: false, reason: "outside_calling_window" };

    const name = firstName(opts.name);
    const dyn: Record<string, string> = {
      lead_name: name || "there",
      name_confirm: name ? `Is this ${name}?` : "",
      lead_source: opts.source,
      lead_route: "property enquiry",
      lead_type: "hot_lead", // fresh — they enquired seconds ago
    };
    // The enquiry itself: on a fresh lead we CAN name it, unlike the archive.
    const detail = clean(opts.detail);
    if (detail) dyn.enquiry_subject = detail.slice(0, 120);

    // Gate 1: unless explicitly armed, log the intent and do NOT place the call.
    if (clean(process.env.AI_CALLER_AUTODIAL) !== "1") {
      console.log("[aiCaller] would dial (autodial OFF):", opts.e164, JSON.stringify(dyn));
      return { dialed: false, reason: "autodial_disabled" };
    }

    const res = await fetch("https://api.elevenlabs.io/v1/convai/twilio/outbound-call", {
      method: "POST",
      headers: { "xi-api-key": key, "Content-Type": "application/json" },
      body: JSON.stringify({
        agent_id: AGENT_ID,
        agent_phone_number_id: PHONE_NUMBER_ID,
        to_number: opts.e164,
        conversation_initiation_client_data: { dynamic_variables: dyn },
      }),
    });
    if (!res.ok) {
      return { dialed: false, reason: `http_${res.status}` };
    }
    const body: any = await res.json().catch(() => ({}));
    return { dialed: true, reason: "placed", conversationId: body.conversation_id };
  } catch (e: any) {
    return { dialed: false, reason: String(e?.message || e).slice(0, 100) };
  }
}
