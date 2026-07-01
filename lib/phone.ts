import { parsePhoneNumberFromString } from "libphonenumber-js";

// Validate + normalise a phone to WhatsApp form (E.164 digits, no "+"). Returns null
// for anything that is not a valid, complete international number — so malformed,
// too-short, and impossible numbers never enter a send. Those would otherwise just
// become 63024 "not on WhatsApp" errors, and a high 63024 rate is exactly the cold-
// list signal that craters the sender's quality rating.
//
// Numbers are expected to already carry their country code (the CRM stores E.164).
// A bare digit string is treated as already international; a genuinely local number
// with no country code is ambiguous and is dropped rather than guessed.
export function cleanPhone(raw: string | null | undefined): string | null {
  const s = String(raw || "").trim();
  if (!s) return null;
  const digits = s.replace(/[^0-9]/g, "");
  if (digits.length < 8) return null;
  const withPlus = s.startsWith("+") ? s : "+" + digits;
  const p = parsePhoneNumberFromString(withPlus);
  if (!p || !p.isValid()) return null;
  return p.number.replace(/[^0-9]/g, ""); // E.164 digits, WhatsApp form
}

// Clean + dedupe a batch of raw phone inputs, preserving first-seen order. Returns
// the valid, deduped items (each tagged with its clean `wa` key) plus counts of what
// was dropped, so the caller can report an honest "X invalid, Y duplicate" instead of
// silently shrinking the list.
export function cleanDedupe<T extends { phone: string }>(
  items: T[]
): { clean: (T & { wa: string })[]; invalid: number; duplicate: number } {
  const seen = new Set<string>();
  const clean: (T & { wa: string })[] = [];
  let invalid = 0;
  let duplicate = 0;
  for (const it of items) {
    const wa = cleanPhone(it.phone);
    if (!wa) { invalid++; continue; }
    if (seen.has(wa)) { duplicate++; continue; }
    seen.add(wa);
    clean.push({ ...it, wa });
  }
  return { clean, invalid, duplicate };
}
