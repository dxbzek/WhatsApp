/* Seed fixtures from the design handoff. Used to populate the UI when the live
   backend (Twilio / Supabase) isn't configured or returns nothing — so every
   screen and control stays fully interactive. Mirrors the shape of the real
   API responses (Twilio Content API, Supabase conversations, etc.). */

export type TplButton = { type: string; title: string; url?: string | null; phone?: string | null };
export type Tpl = {
  sid: string;
  name: string;
  language: string;
  type: string | null;
  category: string | null;
  status: string;
  rejection_reason: string | null;
  variables: Record<string, string>;
  body: string | null;
  replyButtons: string[];
  updated: string;
  // Card extras (surfaced by /api/templates so previews show the full creative)
  media?: string | null;
  headerText?: string | null;
  footer?: string | null;
  buttons?: TplButton[];
};

export const SEED_TEMPLATES: Tpl[] = [
  {
    sid: "HX7af0c1e2b9d4f6a8c3e1b0d9f7a2c4e6",
    name: "palm_jumeirah_offer_v3",
    language: "en",
    type: "whatsapp/card",
    category: "MARKETING",
    status: "approved",
    rejection_reason: null,
    variables: { "1": "there", "2": "Palm Jumeirah" },
    body:
      "Hi {{1}}, a signature 4-bed on {{2}} just came to market at a price we expect to move fast. Floor-to-ceiling sea views, private beach access. Would you like the full set of photos and the floor plan?",
    replyButtons: ["Send me details", "Book a viewing", "Not right now"],
    updated: "2026-05-28T09:12:00Z",
  },
  {
    sid: "HX2b8e4d6a1c9f3e7b5d0a8c2e6f4b1d3a",
    name: "viewing_reminder",
    language: "en",
    type: "twilio/text",
    category: "UTILITY",
    status: "approved",
    rejection_reason: null,
    variables: { "1": "there", "2": "Tuesday", "3": "4:00 PM" },
    body:
      "Hi {{1}}, this is a reminder of your viewing on {{2}} at {{3}}. Our agent will meet you at the tower lobby. Reply here if anything changes.",
    replyButtons: [],
    updated: "2026-05-30T14:40:00Z",
  },
  {
    sid: "HX9c1f7b3e5a2d8c6f0b4e9a1d7c3f5b2e",
    name: "welcome_intro_optin",
    language: "en",
    type: "twilio/quick-reply",
    category: "UTILITY",
    status: "approved",
    rejection_reason: null,
    variables: {},
    body:
      "Welcome to ERE Homes. We help Dubai owners and buyers move with clarity, no pressure. How can we help you today?",
    replyButtons: ["Buy a property", "Sell my property", "Talk to an agent"],
    updated: "2026-05-22T08:05:00Z",
  },
  {
    sid: "HX4d2a6c8e0b9f1d3a7c5e2b8d4f6a0c1e",
    name: "valuation_offer_ar",
    language: "ar",
    type: "whatsapp/card",
    category: "MARKETING",
    status: "pending",
    rejection_reason: null,
    variables: { "1": "السيد", "2": "نخلة جميرا" },
    body:
      "مرحباً {{1}}، نقدّم لك تقييماً مجانياً لعقارك في {{2}} بناءً على أحدث صفقات دائرة الأراضي. هل ترغب باستلام التقرير؟",
    replyButtons: ["نعم، أرسلوا التقرير", "ليس الآن"],
    updated: "2026-06-02T11:20:00Z",
  },
  {
    sid: "HX1e9b5d7a3c0f2e8b6d4a1c9f7e3b5d0a",
    name: "price_drop_alert",
    language: "en",
    type: "whatsapp/card",
    category: "MARKETING",
    status: "rejected",
    rejection_reason:
      "Content includes promotional urgency language that violates WhatsApp Commerce Policy. Remove pressure phrasing and resubmit.",
    variables: { "1": "there" },
    body: "PRICE CRASHING {{1}}! This unit WON'T LAST. Act NOW before it is GONE forever!!!",
    replyButtons: ["See it now"],
    updated: "2026-05-19T16:55:00Z",
  },
  {
    sid: "HX6f3c9e1b7d5a2c8e0b4d6a3f1c9e7b5d",
    name: "dch_new_launch",
    language: "en",
    type: "whatsapp/card",
    category: "MARKETING",
    status: "approved",
    rejection_reason: null,
    variables: { "1": "there" },
    body:
      "Hi {{1}}, a new waterfront release at Dubai Creek Harbour opens to our clients first this week. 1 to 3 beds, payment plan over handover. Want the price list before it goes public?",
    replyButtons: ["Send price list", "Register interest", "Unsubscribe"],
    updated: "2026-06-01T10:02:00Z",
  },
  {
    sid: "HX8a0d4f6c2e9b1d7a5c3e0b8d6f4a2c1e",
    name: "handover_congrats",
    language: "en",
    type: "twilio/text",
    category: "UTILITY",
    status: "approved",
    rejection_reason: null,
    variables: { "1": "there", "2": "Creek Horizon" },
    body:
      "Congratulations on your handover at {{2}}, {{1}}. If you would like a snagging referral or a leasing valuation, we are here when you need us.",
    replyButtons: [],
    updated: "2026-05-26T13:30:00Z",
  },
  {
    sid: "HX3c7e1a9d5b2f8c4e6a0d3b7c1f9e5a2d",
    name: "callback_request_hi",
    language: "hi",
    type: "twilio/quick-reply",
    category: "UTILITY",
    status: "approved",
    rejection_reason: null,
    variables: {},
    body: "नमस्ते, ERE Homes में आपका स्वागत है। क्या हमारा एजेंट आपको कॉल करे? कृपया एक विकल्प चुनें।",
    replyButtons: ["अभी कॉल करें", "बाद में", "केवल व्हाट्सएप"],
    updated: "2026-05-24T07:45:00Z",
  },
  {
    sid: "HX5b9d3f7a1c8e2b6d4a0c9e7b3f1d5a8c",
    name: "off_plan_launch_ru",
    language: "ru",
    type: "whatsapp/card",
    category: "MARKETING",
    status: "unsubmitted",
    rejection_reason: null,
    variables: { "1": "" },
    body:
      "Здравствуйте {{1}}, эксклюзивный старт продаж в Dubai South: студии и апартаменты с рассрочкой до сдачи. Прислать планировки и цены?",
    replyButtons: ["Прислать цены", "Связаться с агентом"],
    updated: "2026-06-03T15:10:00Z",
  },
  {
    sid: "HX0e6a2c8d4f1b9e3a7c5d2b0f8e6a4c1d",
    name: "ramadan_greeting",
    language: "ar",
    type: "twilio/text",
    category: "MARKETING",
    status: "approved",
    rejection_reason: null,
    variables: { "1": "" },
    body: "{{1}} رمضان كريم من فريق ERE Homes. نتمنى لكم ولعائلتكم شهراً مباركاً.",
    replyButtons: [],
    updated: "2026-03-01T09:00:00Z",
  },
];

/* ── Inbox conversations ── */
export type FixtureMsg = { from: "in" | "out"; t: string; at: string };
export type FixtureConv = {
  id: number;
  name: string;
  phone: string;
  tag: "Hot" | "Warm" | "";
  unread: number;
  time: string;
  community: string;
  messages: FixtureMsg[];
};

export const CONVOS: FixtureConv[] = [
  {
    id: 1, name: "Aisha Rahman", phone: "+971 50 441 2208", tag: "Hot", unread: 2, time: "12:31", community: "Palm Jumeirah",
    messages: [
      { from: "in", t: "Hi, I saw the Palm Jumeirah listing. Is it still available?", at: "12:02" },
      { from: "out", t: "Hi Aisha, yes it is. A signature 4-bed with private beach access. Would you like the full photo set and floor plan?", at: "12:05" },
      { from: "in", t: "Yes please, and can I view it this week?", at: "12:20" },
      { from: "out", t: "Of course. We have Tuesday or Thursday afternoon open. Which suits you?", at: "12:24" },
      { from: "in", t: "Yes, Tuesday at 4pm works for the viewing.", at: "12:31" },
    ],
  },
  {
    id: 2, name: "David Okonkwo", phone: "+971 55 902 7741", tag: "Warm", unread: 1, time: "12:14", community: "Dubai Creek Harbour",
    messages: [
      { from: "out", t: "Hi David, here is the price list for the new Creek Harbour release.", at: "11:40" },
      { from: "in", t: "What's the service charge on the Creek unit?", at: "12:14" },
    ],
  },
  {
    id: 3, name: "Priya Nair", phone: "+971 52 118 6390", tag: "Hot", unread: 0, time: "11:33", community: "Downtown",
    messages: [
      { from: "out", t: "Hi Priya, a Downtown 2-bed with Burj views just came up. Want the details?", at: "11:30" },
      { from: "in", t: "Send me details", at: "11:33" },
    ],
  },
  {
    id: 4, name: "Mohammed Al Suwaidi", phone: "+971 50 776 1145", tag: "", unread: 0, time: "10:58", community: "Nad Al Sheba",
    messages: [
      { from: "out", t: "Morning Mohammed, attaching the villa floor plan you asked about.", at: "10:50" },
      { from: "in", t: "Thanks, I'll review the floor plan tonight.", at: "10:58" },
    ],
  },
  {
    id: 5, name: "Elena Volkova", phone: "+7 916 220 4417", tag: "Warm", unread: 0, time: "09:42", community: "Dubai South",
    messages: [
      { from: "out", t: "Здравствуйте Elena, старт продаж в Dubai South. Прислать планировки?", at: "09:40" },
      { from: "in", t: "Прислать цены, пожалуйста.", at: "09:42" },
    ],
  },
  {
    id: 6, name: "James Whitfield", phone: "+44 7700 900145", tag: "", unread: 0, time: "Yesterday", community: "Town Square",
    messages: [
      { from: "in", t: "Is the Town Square townhouse still on the market?", at: "Yesterday" },
      { from: "out", t: "Hi James, it's under offer now, but I have two similar units. Shall I send them?", at: "Yesterday" },
    ],
  },
];

/* ── Senders (sub-accounts / WhatsApp numbers) ── */
export type Sender = { id: string; sub: string; label: string; number: string };
export const SENDERS: Sender[] = [
  { id: "main", sub: "ERE Homes", label: "Main line", number: "+971 4 555 2100" },
  { id: "sales", sub: "ERE Homes", label: "Sales team", number: "+971 50 441 0000" },
  { id: "leasing", sub: "ERE Homes", label: "Leasing", number: "+971 55 200 1188" },
  { id: "offplan", sub: "ERE Off-Plan", label: "Investments", number: "+971 4 555 2233" },
];
