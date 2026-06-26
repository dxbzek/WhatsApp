// Create the dedicated Meta-ad LEAD ALERT template and submit it to WhatsApp as
// UTILITY. This is the Meta variant (distinct from the WhatsApp-interest alert)
// and is personalised with the assigned agent's name.
//
// Vars: 1=agent name, 2=lead name, 3=number, 4=enquiry (listing + email).
//
// After approval, copy the Content SID (HX…) into the WhatsApp project's Vercel
// env as META_LEAD_ALERT_SID, then redeploy. The code already prefers it.
//
// Run:  TWILIO_ACCOUNT_SID=ACxxxx TWILIO_AUTH_TOKEN=xxxx node scripts/submit-meta-lead-alert-utility.mjs
// (creds live on Vercel / the Twilio console)

const SID = (process.env.TWILIO_ACCOUNT_SID || "").trim();
const TOKEN = (process.env.TWILIO_AUTH_TOKEN || "").trim();
if (!SID || !TOKEN) {
  console.error("Missing TWILIO_ACCOUNT_SID / TWILIO_AUTH_TOKEN env vars.");
  process.exit(1);
}
const AUTH = "Basic " + Buffer.from(`${SID}:${TOKEN}`).toString("base64");

const NAME = "ere_meta_lead_alert";

const createBody = {
  friendly_name: NAME,
  language: "en",
  variables: { 1: "Keeley", 2: "Sakeer edasseri", 3: "+971504089510", 4: "Marina Residences 1 · Palm Jumeirah · name@gmail.com" },
  types: {
    "twilio/text": {
      body:
        "Hi {{1}}, you have a new ERE lead from a Meta ad.\n\n" +
        "Name: {{2}}\n" +
        "Number: {{3}}\n" +
        "Enquiry: {{4}}\n\n" +
        "They just submitted the lead form. Call or WhatsApp them now while it's hot.",
    },
  },
};

async function main() {
  const cRes = await fetch("https://content.twilio.com/v1/Content", {
    method: "POST",
    headers: { Authorization: AUTH, "Content-Type": "application/json" },
    body: JSON.stringify(createBody),
  });
  const content = await cRes.json();
  if (!cRes.ok) { console.error("Create failed:", cRes.status, content); process.exit(1); }
  console.log("Created:", content.sid, content.friendly_name);

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
  console.log("Submitted for approval as UTILITY. Status:", approval.status || "(received)");
  console.log("\n>>> Add this to Vercel env as META_LEAD_ALERT_SID, then redeploy:");
  console.log("    META_LEAD_ALERT_SID=" + content.sid);
}

main().catch((e) => { console.error(e); process.exit(1); });
