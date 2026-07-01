import { supabaseAdmin } from "@/lib/supabase";

// Short, human, unique lead handle: 'L' + 6 base36 chars (e.g. "L3f9k2a").
// Printed in agent alerts and accepted back from agents to target a specific lead
// (handleAgentReport matches /\bL[0-9a-z]{6}\b/i). Kept tiny so it is easy to type.
const LEAD_REF_RE = /^L[0-9a-z]{6}$/i;

// Generate a candidate ref. Random base36, lowercased, padded to 6 chars.
function candidate(): string {
  const s = Math.floor(Math.random() * 36 ** 6).toString(36).padStart(6, "0");
  return "L" + s.slice(0, 6);
}

export function isLeadRef(s: string): boolean {
  return LEAD_REF_RE.test(s.trim());
}

// Ensure a conversation has a lead_ref, generating + persisting one if missing.
// Best-effort and collision-safe: on the rare unique clash it retries. Returns the
// ref (existing or newly set), or null if it could not be set (never throws).
export async function ensureLeadRef(conversationId: string): Promise<string | null> {
  try {
    const db = supabaseAdmin();
    const { data } = await db.from("conversations").select("lead_ref").eq("id", conversationId).maybeSingle();
    if (data?.lead_ref) return data.lead_ref as string;
    for (let i = 0; i < 5; i++) {
      const ref = candidate();
      const { error } = await db.from("conversations").update({ lead_ref: ref }).eq("id", conversationId).is("lead_ref", null);
      if (!error) {
        // Re-read to confirm we own this ref (another writer may have raced us).
        const { data: after } = await db.from("conversations").select("lead_ref").eq("id", conversationId).maybeSingle();
        if (after?.lead_ref) return after.lead_ref as string;
      }
      // unique_violation or race — try a fresh candidate
    }
    return null;
  } catch {
    return null;
  }
}
