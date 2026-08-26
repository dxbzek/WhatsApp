// What KIND of thing did somebody just submit on erehomes.ae?
//
//   "lead"    a property enquiry -> sales pipeline, round-robin to the desk
//   "career"  a job application  -> Recruitment pipeline 9, to Fadilah/Rochelle
//   "spam"    somebody selling us something -> logged, nobody's time
//
// Zek, 26 Aug 2026: "if its not property enquiry ignore please", then "Job applications
// should be direct to recruitment". Two vendor pitches (a contact-database seller and a
// WhatsApp-chatbot seller) had come through the free-consultation form, passed the old flat
// word list, become Pipedrive deals and been mirrored into Bitrix as leads.
//
// Tiers, deliberately. A false positive costs a real buyer or seller, so only unmistakable
// vendor language bins a submission on its own. Softer business-speak needs two hits with at
// least one from the SELLING side, so "I want your team to manage my two units, can we
// collaborate" is still a landlord. An EMPTY message is never spam: blank is the normal
// shape of a listing or valuation enquiry.
//
// Patterns carry no closing \b so stems match ("backlinks", "guest posting") - the regex
// this replaced missed both.
//
// Nothing is discarded: the caller records every spam verdict (see the website lead route),
// so a wrong call stays visible and recoverable.

export type EnquiryKind = "lead" | "career" | "spam";

export type SpamVerdict = {
  kind: EnquiryKind;
  spam: boolean;      // kept for callers that only care whether it is a property lead
  score: number;
  reasons: string[];
};

// Somebody wanting a job with us. Checked FIRST, but loses to a vendor pattern below, so
// "we offer recruitment services" stays spam.
const CAREER: [RegExp, string][] = [
  [/\b(job|vacanc|hiring|internship|apprentice)/i, "job wording"],
  [/\b(career (opportunit|with|at|in)|looking for (a )?(job|work|position|opportunit)|seeking (a )?(job|position|role|opportunit))/i, "seeking work"],
  [/\b(my (cv|resume|profile is attached)|cv attached|resume attached|attached is my)/i, "cv attached"],
  [/\b(join (your|the|ere) (team|company|brokerage|agency)|work (with|for) (you|your team|ere)|apply (for|as|to join))/i, "wants to join"],
  [/\b(i am (a|an) (licensed |experienced |rera )?(real estate |property )?(agent|broker|consultant|advisor)|years of experience in (real estate|property|sales))/i, "agent introducing themselves"],
  [/\b(brn|rera card|broker card)\b/i, "broker credentials"],
];

// One hit is enough. None of these turn up in a genuine property enquiry.
const STRONG: [RegExp, string][] = [
  [/\b(guest post|guest blogg|backlink|link building|write for us|off[- ]page seo|domain authority|search rankings?|rank higher)/i, "seo pitch"],
  [/\b(seo servic|marketing servic|digital marketing (agency|servic)|social media management|online presence|website traffic)/i, "marketing pitch"],
  [/\b(web design|web development|website development|app development|logo design|graphic design servic|ui\/ux servic)/i, "dev pitch"],
  [/\b(lead generation servic|verified leads|our database|email database|contact (list|database)|b2b data|bulk sms|cold email|prospect list|mailing list)/i, "data pitch"],
  [/\b(chatbot|whats ?app automation|ai (automation|agent|assistant|system|solution|chatbot)|automation (system|solution|servic)|crm software|saas|white ?label|dropship)/i, "software pitch"],
  [/\b((i|we) build (custom|automated|ai)|book a demo|free demo|schedule a demo|case stud|outsourc|free trial of)/i, "vendor demo"],
  [/\b(our servic(e|es) (include|are)|we offer our servic|our (agency|firm|company) (offers|provides|specialis|specializ)|we (supply|manufacture)|our factory|wholesale price)/i, "vendor offer"],
  [/\b(invoice attached|purchase order|sponsorship|crypto|bitcoin|forex|binary option|loan offer|casino|betting)/i, "unrelated business"],
  [/\b(translation servic|printing servic|visa servic|insurance quote|solar panel|fit ?out servic|cleaning servic|staffing agency|manpower supply)/i, "supplier pitch"],
];

// Selling-side language. Needs one of these plus a second hit from either list.
const PITCH: [RegExp, string][] = [
  [/\b(our (company|team|platform|software|solution|tool|expertise|network))/i, "pitches their company"],
  [/\b(we (offer|provide|help|specialis|specializ)|i (can|could) (help|offer|provide|build))/i, "we-offer language"],
  [/\b(reaching out|looking to connect|get in touch with you|partner with you|leverage our|touch base)/i, "outreach opener"],
  [/\b(increase your|grow your|boost your|generate more|scale your|amplify your|save you (time|money))/i, "growth promise"],
  [/\b(high[- ]net[- ]worth|hnwi|targeted audience|targeted traffic|qualified traffic)/i, "audience pitch"],
  [/\b(no obligation|happy to share (more|the details|pricing)|worth a (quick )?(call|chat)|check my (blog|site|website)|see our portfolio)/i, "soft close"],
  [/https?:\/\/|www\./i, "link in message"],
];

// Business-speak a real enquirer can also use. Only counts alongside a PITCH hit.
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
  const interest = (input.interest || "").trim();
  const hay = `${interest} ${message}`;

  const strong = STRONG.filter(([re]) => re.test(hay)).map(([, l]) => `${l} (certain)`);
  const career = CAREER.filter(([re]) => re.test(hay)).map(([, l]) => l);

  // A vendor selling recruitment beats an applicant asking for work.
  if (career.length > 0 && strong.length === 0) {
    return { kind: "career", spam: false, score: career.length, reasons: career };
  }

  // Nothing written = nothing to judge. Blank is the normal shape of a listing enquiry,
  // and the intent select alone can never carry a pitch.
  if (!message) return { kind: "lead", spam: false, score: 0, reasons: [] };

  if (strong.length > 0) return { kind: "spam", spam: true, score: 10, reasons: strong };

  const pitch = PITCH.filter(([re]) => re.test(hay)).map(([, l]) => l);
  const context = CONTEXT.filter(([re]) => re.test(hay)).map(([, l]) => l);
  const reasons = [...pitch, ...context];
  const spam = pitch.length >= 1 && reasons.length >= 2;
  return { kind: spam ? "spam" : "lead", spam, score: reasons.length, reasons };
}
