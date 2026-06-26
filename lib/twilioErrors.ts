// Twilio messaging + WhatsApp error codes → plain-English cause.
// Sourced from Twilio's error dictionary (twilio.com/docs/api/errors).
export const TWILIO_ERRORS: Record<string, string> = {
  // --- Generic messaging delivery ---
  "30003": "Unreachable destination handset (off, no service, or blocked)",
  "30004": "Message blocked by the carrier or recipient",
  "30005": "Unknown destination handset (number doesn't exist)",
  "30006": "Landline or unreachable carrier",
  "30007": "Carrier filtered the message as spam",
  "30008": "Unknown delivery error from the carrier",

  // --- Number / permission issues ---
  "21211": "Invalid 'To' phone number",
  "21408": "Permission to send to this country/region not enabled",
  "21610": "Recipient replied STOP - unsubscribed",
  "21612": "Cannot route a message to this number",
  "21614": "'To' number is not a valid mobile number",

  // --- WhatsApp / Channel (63xxx) ---
  "63001": "Channel could not authenticate the request",
  "63002": "Channel could not find the 'From' (sender) address",
  "63003": "Could not find the recipient ('To' address)",
  "63005": "Channel did not accept the message content",
  "63007": "No WhatsApp sender found for this 'From' number",
  "63012": "WhatsApp/Meta returned an internal service error",
  "63013": "Message blocked by WhatsApp policy",
  "63014": "Recipient blocked your WhatsApp number",
  "63015": "Sandbox: recipient hasn't joined the WhatsApp sandbox",
  "63016": "Outside the 24-hour window - must use an approved template",
  "63017": "This channel doesn't support the media you sent",
  "63018": "Rate limit exceeded - too many messages too fast",
  "63021": "Channel rejected the content (invalid/blocked)",
  "63022": "Invalid WhatsApp sender (vname) certificate",
  "63024": "Invalid message recipient (not a valid WhatsApp user / Meta restriction)",
  "63026": "Failed to create the content",
  "63031": "Sender and recipient numbers are the same",
  "63032": "WhatsApp limitation - cannot send to this user right now (e.g. Meta experiment hold)",
  "63033": "Meta couldn't deliver (recipient-side issue)",
  "63041": "Template not found or parameter mismatch",
  "63049": "Meta chose not to deliver this WhatsApp marketing message (per-user marketing limit)",
  "63051": "WhatsApp sender or account is LOCKED by Meta (policy/security/inactivity — sender must be re-registered before it can send)",
  "63052": "Legacy WhatsApp template system used (end-of-life warning)",
};

export function errorCause(code: string | number | null | undefined): string {
  if (!code) return "";
  return TWILIO_ERRORS[String(code)] || "See Twilio error docs";
}

// Codes that mean the number is genuinely not reachable on WhatsApp (a dead /
// invalid number), NOT a content or throttle problem. These are excluded from
// the "real" delivery-rate denominator and auto-suppressed. Mirrors the status
// callback's INVALID_NUMBER_CODES. NOTE: 63049 is Meta's per-user marketing
// throttle (a real non-delivery to a LIVE number) — it is deliberately NOT here.
export const DEAD_NUMBER_CODES = new Set(["63024", "63003", "21211", "21614"]);
export const isDeadNumber = (code: string | number | null | undefined) =>
  !!code && DEAD_NUMBER_CODES.has(String(code));
