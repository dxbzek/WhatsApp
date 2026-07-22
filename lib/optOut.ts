// Opt-out vocabulary shared by the inbound webhook (suppression) and the
// template-performance stats (a "Stop promotions" is not engagement, so it
// must not count as a reply). One list so the two can never disagree on what
// counts as an opt-out.
export const OPT_OUT = ["stop", "unsubscribe", "unsub", "cancel", "stop promotions", "opt out", "optout", "remove me", "remove", "blocked", "block", "block me", "do not contact", "dont contact", "leave me alone"];

// A CLEAR opt-out used as the FIRST token (e.g. "stop messaging me") always
// suppresses and can never be rescued by the buying-intent heuristic.
export const STANDALONE_OPT_OUT = ["stop", "unsubscribe", "unsub", "optout", "remove", "blocked", "block"];

// Strip trailing punctuation/whitespace so "Blocked!" / "Not interested." match.
export const normalizeReply = (body: string) => body.trim().toLowerCase().replace(/[\s!.?,]+$/, "");

// Hard-opt-out test (exact phrase OR standalone first token) for callers that
// only need "is this message an opt-out?", e.g. the performance reply counter.
export const isOptOutText = (body: string | null | undefined) => {
  if (!body) return false;
  const text = normalizeReply(body);
  return OPT_OUT.includes(text) || STANDALONE_OPT_OUT.includes(text.split(/\s+/)[0] || "");
};
