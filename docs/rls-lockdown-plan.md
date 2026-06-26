# RLS lockdown — WhatsApp console tables

Supabase linter flagged ERROR `rls_disabled_in_public` on four public tables exposed to PostgREST:
`messages`, `conversations`, `auto_replies`, `campaigns`.

These hold WhatsApp phone numbers, names, message bodies, and lead status. The console's
only gate today is the app login (signed cookie). But the Supabase anon key ships in the
browser bundle as `NEXT_PUBLIC_SUPABASE_ANON_KEY`, so anyone who pulls it can read and
write these tables directly through PostgREST, bypassing the login gate entirely. The
linter is correct: this is a real exposure.

> Note: this DB is NOT one of the projects the Claude session's Supabase MCP can reach
> (it only sees "Spend Pal" and "Ascend", which are different apps). Run the SQL below in
> the ERE Supabase SQL editor, or connect the ERE project to the MCP.

## How each table is accessed (from this repo)

| Table | Browser (anon, public key) | Server (service role) |
|---|---|---|
| `auto_replies` | none | `app/api/auto-replies/route.ts`, `app/api/templates/route.ts`, `app/api/twilio/inbound/route.ts` |
| `conversations` | read + **update** — `app/page.tsx`, `app/inbox/page.tsx`, `app/insights/page.tsx`, `app/suppressed/page.tsx` | several API routes |
| `messages` | read — `app/page.tsx`, `app/campaigns/page.tsx`, `app/campaigns/history/page.tsx`, `app/logs/page.tsx` | dispatch/send/inbound routes |
| `campaigns` | read — `app/page.tsx`, `app/campaigns/history/page.tsx` | campaign routes |

`app/inbox/page.tsx` also opens a Supabase **Realtime** channel (`postgres_changes` on
`messages` + `conversations`) via the anon client. Realtime respects RLS, so locking anon
out stops realtime — it must be replaced with polling (or an authenticated channel).

---

## Step 1 — `auto_replies` (safe now, zero app impact)

Server-only (always `supabaseAdmin`). Service role bypasses RLS, so just enabling it with
no anon policy changes nothing for the app and closes the hole.

```sql
alter table public.auto_replies enable row level security;
-- no anon policy on purpose: only the service role (API routes) should touch it
```

## Step 2 — `conversations` / `messages` / `campaigns` (plan A, the real fix)

Goal: stop the browser from touching these with the anon key, then deny anon at the DB.

1. **Add server API routes (service role) that return what each page needs:**
   - `GET  /api/inbox/conversations` (list + hot/warm/unread filter)
   - `GET  /api/inbox/messages?conversation=<id>`
   - `POST /api/inbox/conversation` (update `unread` / `lead_status` / `status`)
   - `GET  /api/dashboard` (conversations + active campaigns + the analytics counts in `app/page.tsx`)
   - `GET  /api/campaigns` and `GET /api/campaigns/messages` (history page)
   - `GET  /api/logs`
   - `GET  /api/insights`

2. **Replace the `supabaseBrowser()` calls** in these pages with `fetch()` to the routes above:
   `app/page.tsx`, `app/inbox/page.tsx`, `app/campaigns/page.tsx`,
   `app/campaigns/history/page.tsx`, `app/logs/page.tsx`, `app/insights/page.tsx`,
   `app/suppressed/page.tsx`.

3. **Replace inbox realtime** (`app/inbox/page.tsx` lines ~142-147) with polling the new
   inbox routes every ~7-10s. (Authenticated realtime isn't viable here — the app uses its
   own cookie login, not Supabase Auth.)

4. **Once no browser code reads these tables, lock them down:**
   ```sql
   alter table public.conversations enable row level security;
   alter table public.messages      enable row level security;
   alter table public.campaigns     enable row level security;
   -- no anon/authenticated policies: only the service role (API routes) gets in
   ```

5. **Verify:** open the deployed console, confirm inbox/dashboard/campaigns/logs/insights
   still load, then re-run the Supabase linter — all four should clear.

### Do NOT do this instead
Enabling RLS + a permissive `to anon using (true)` policy makes the linter pass but keeps
the door open (the anon key is public). It is not a real fix.
