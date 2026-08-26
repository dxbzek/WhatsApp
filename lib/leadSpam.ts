// Is this website form submission a property enquiry, or somebody selling us something?
//
// Zek, 26 Aug 2026: "if its not property enquiry ignore please" — after two vendor pitches
// (a contact-database seller and a WhatsApp-chatbot seller) came through the free
// consultation form, became Pipedrive deals, and were mirrored into Bitrix as leads.
//
// Two tiers on purpose. A false positive here costs a real buyer or seller, so only
// unmistakable vendor language bins a submission on its own. Softer business-speak needs
// two hits AND at least one of them from the selling side — "I want your team to manage my
// two units, can we collaborate" is a landlord, not a pitch. An EMPTY message is never
// spam: there is nothing to judge, and blank is the normal shape of a listing or valuation
// enquiry.
//
// Patterns deliberately have no closing \b so stems match ("backlinks", "guest posting").
//
// Nothing is silently discarded: the caller records every rejection (see the website lead
// route), so a wrong call stays visible and recoverable.

export type SpamVerdict = {
  spam: boolean;
  score: number;
  reasons: string[];
};

// One hit is enough. None of these turn up in a genuine property enquiry.
const STRONG: [RegExp, string][] = [
  [/\b(guest post|guest blogg|backlink|link building|write for us|off[- ]page seo|domain authority|search rankings?)/i, "seo pitch"],
  [/\b(seo servic|marketing servic|digital marketing (agency|servic)|social media management|online presence)/i, "marketing pitch"],
  [/\b(web design|web development|website development|app development|logo design|graphic design servic)/i, "dev pitch"],
  [/\b(lead generation servic|verified leads|our database|email database|contact (list|database)|b2b data|bulk sms|cold email|prospect list)/i, "data pitch"],
  [/\b(chatbot|whats ?app automation|ai (automation|agent|assistant|system|solution|chatbot)|automation (system|solution|servic)|crm software|saas|white ?label|dropship)/i, "software pitch"],
  [/\b((i|we) build (custom|automated|ai)|book a demo|free demo|schedule a demo|case stud|outsourc)/i, "vendor demo"],
  [/\b(our servic(e|es) (include|are)|we offer our servic|our (agency|firm|company) (offers|provides|specialis|specializ))/i, "vendor offer"],
  [/\b(job|career|vacanc|hiring|recruit|cv|resume|internship)\b/i, "careers"],
  [/\b(invoice|supplier|sponsorship|crypto|forex|binary option|loan offer)/i, "unrelated business"],
];

// Selling-side language. Needs one of these plus a second hit from either list.
const PITCH: [RegExp, string][] = [
  [/\b(our (company|team|platform|software|solution|tool|expertise))/i, "pitches their company"],
  [/\b(we (offer|provide|help|specialis|specializ)|i (can|could) (help|offer|provide|build))/i, "we-offer language"],
  [/\b(reaching out|looking to connect|get in touch with you|partner with you|leverage our)/i, "outreach opener"],
  [/\b(increase your|grow your|boost your|generate more|scale your|amplify your)/i, "growth promise"],
  [/\b(high[- ]net[- ]worth|hnwi|targeted audience|targeted traffic)/i, "audience pitch"],
  [/\b(no obligation|happy to share (more|the details|pricing)|worth a (quick )?(call|chat)|check my (blog|site|website))/i, "soft close"],
  [/https?:\/\/|www\./i, "link in message"],
];

// Business-speak that a real enquirer can also use. Only counts alongside a PITCH hit.
const CONTEXT: [RegExp, string][] = [
  [/\b(your (company|business|team|agency|website|brand|marketing|niche|clients))/i, "addresses us as a business"],
  [/\b(partnership|collaborat)/i, "partnership language"],
  [/\b(let me know if (you|this)|feel free to)/i, "generic closer"],
  [/\b(pricing|packages|rates) (available|start|from)/i, "quotes their pricing"],
];

export function classifyEnquiry(input: {
  interest?: string | null;
  message?: string | null;
  email?: string | null;
}): SpamVerdict {
  const message = (input.message || "").trim();
  const hay = `${input.interest || ""} ${message}`;

  // Nothing written = nothing to judge.
  if (!message) return { spam: false, score: 0, reasons: [] };

  const strong = STRONG.filter(([re]) => re.test(hay)).map(([, l]) => `${l} (certain)`);
  if (strong.length > 0) return { spam: true, score: 10, reasons: strong };

  const pitch = PITCH.filter(([re]) => re.test(hay)).map(([, l]) => l);
  const context = CONTEXT.filter(([re]) => re.test(hay)).map(([, l]) => l);
  const reasons = [...pitch, ...context];
  const spam = pitch.length >= 1 && reasons.length >= 2;
  return { spam, score: reasons.length, reasons };
}
