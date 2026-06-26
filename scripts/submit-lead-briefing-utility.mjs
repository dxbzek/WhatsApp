// Create a fresh agent lead-briefing template worded as a pure operational
// notification (no promo tone, no links) and submit it to WhatsApp as UTILITY.
//
// Meta decides the final category from the content, so the wording below is the
// lever: a specific assigned item + a neutral instruction + quick-reply status
// buttons, nothing promotional. We cannot recategorize the approved v1, so this
// files a new version (ere_agent_lead_briefing_v2).
//
// Run:  TWILIO_ACCOUNT_SID=ACxxxx TWILIO_AUTH_TOKEN=xxxx node scripts/submit-lead-briefing-utility.mjs
// (creds live on Vercel; copy them from the Twilio console or Vercel env)

const SID = (process.env.TWILIO_ACCOUNT_SID || "").trim();
const TOKEN = (process.env.TWILIO_AUTH_TOKEN || "").trim();
if (!SID || !TOKEN) {
  console.error("Missing TWILIO_ACCOUNT_SID / TWILIO_AUTH_TOKEN env vars.");
  process.exit(1);
}
const AUTH = "Basic " + Buffer.from(`${SID}:${TOKEN}`).toString("base64");

const NAME = "ere_agent_lead_briefing_v2";

// Quick-reply template: body with 3 vars + WON/VIEWING/LOST status buttons.
// The inbound handler already reads these as an agent self-report, so a tap
// updates the lead stage with no extra wiring.
const createBody = {
  friendly_name: NAME,
  language: "en",
  variables: { 1: "Igor", 2: "+971501234567", 3: "3BR Palm villa under AED 25M" },
  types: {
    "twilio/quick-reply": {
      body:
        "New lead assigned to you.\n\n" +
        "Name: {{1}}\n" +
        "Number: {{2}}\n" +
        "Interest: {{3}}\n\n" +
        "Please contact them today. When done, tap your status below or reply WON, VIEWING, or LOST.",
      actions: [
        { id: "won", title: "WON" },
        { id: "viewing", title: "VIEWING" },
        { id: "lost", title: "LOST" },
      ],
    },
  },
};

async function main() {
  // 1) Create the Content resource.
  const cRes = await fetch("https://content.twilio.com/v1/Content", {
    method: "POST",
    headers: { Authorization: AUTH, "Content-Type": "application/json" },
    body: JSON.stringify(createBody),
  });
  const content = await cRes.json();
  if (!cRes.ok) {
    console.error("Create failed:", cRes.status, content);
    process.exit(1);
  }
  console.log("Created:", content.sid, content.friendly_name);

  // 2) Submit for WhatsApp approval as UTILITY.
  const aRes = await fetch(
    `https://content.twilio.com/v1/Content/${content.sid}/ApprovalRequests/whatsapp`,
    {
      method: "POST",
      headers: { Authorization: AUTH, "Content-Type": "application/json" },
      body: JSON.stringify({ name: NAME, category: "UTILITY" }),
    }
  );
  const approval = await aRes.json();
  if (!aRes.ok) {
    console.error("Approval submit failed:", aRes.status, approval);
    console.error("Content was created (sid above); fix and resubmit the approval only.");
    process.exit(1);
  }
  console.log("Submitted for approval as UTILITY.");
  console.log("Status:", approval.status || "(received)");
  console.log("\nTrack it in the console Templates page. Meta usually reviews within a few hours.");
  console.log("Note: Meta may still reclassify to MARKETING; this wording gives the best shot at UTILITY.");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
