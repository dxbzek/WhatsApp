/* Shared UI types for the shapes the live API returns (Twilio Content API,
   Supabase conversations, senders).

   TYPES ONLY — no seed data. This file used to also export design-handoff
   fixtures (CONVOS, SENDERS, SEED_TEMPLATES) that screens fell back to when the
   backend returned nothing, which meant invented contacts, invented phone
   numbers and a hardcoded unread badge rendered as if they were real. Removed
   20 Jul 2026. An empty backend must render an empty state, never sample data. */

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

/* ── Senders (sub-accounts / WhatsApp numbers) ── */
export type Sender = { id: string; sub: string; label: string; number: string };
