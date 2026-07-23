import { NextRequest } from "next/server";
import { createClient } from "@supabase/supabase-js";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// Vercel caps a streaming function's lifetime. Hold the connection open for as
// long as the plan allows, then close cleanly — EventSource reconnects on its
// own, so the client sees an uninterrupted feed.
export const maxDuration = 300;

// Server-Sent Events feed of live table changes.
//
// Why this exists rather than a browser Supabase client: the anon key ships in
// the client bundle and bypasses the app login gate, so lib/supabase.ts
// deliberately has no browser client and RLS denies anon at the DB
// (project_whatsapp_rls_lockdown). This route keeps that intact — it subscribes
// with the service role on the SERVER, behind the same session cookie as every
// other /api route, and pushes only a change notification (table + event, no row
// data) to the page. The page then refetches through its normal gated endpoint.
// So nothing sensitive crosses the wire that wasn't already authorised.
const TABLES = ["messages", "conversations", "campaigns"] as const;

const clean = (v?: string) => (v || "").replace(/^﻿/, "").trim();

export async function GET(req: NextRequest) {
  const url = clean(process.env.NEXT_PUBLIC_SUPABASE_URL);
  const key = clean(process.env.SUPABASE_SERVICE_ROLE_KEY);
  if (!url || !key) return new Response("Realtime not configured", { status: 503 });

  const encoder = new TextEncoder();
  let closed = false;

  const stream = new ReadableStream({
    async start(controller) {
      const send = (event: string, data: unknown) => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
        } catch {
          /* controller already closed by a client disconnect */
        }
      };

      const supabase = createClient(url, key, {
        auth: { persistSession: false, autoRefreshToken: false },
        realtime: { params: { eventsPerSecond: 20 } },
      });

      const channel = supabase.channel("console-live");
      for (const table of TABLES) {
        channel.on("postgres_changes", { event: "*", schema: "public", table }, (payload) => {
          send("change", { table, type: payload.eventType, at: Date.now() });
        });
      }
      channel.subscribe((status) => send("status", { status, at: Date.now() }));

      // Comment heartbeat keeps proxies from idling the connection out. It is a
      // bare SSE comment, so it costs the client nothing to ignore.
      const beat = setInterval(() => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(`: ping ${Date.now()}\n\n`));
        } catch {
          /* closed */
        }
      }, 25000);

      const shutdown = () => {
        if (closed) return;
        closed = true;
        clearInterval(beat);
        supabase.removeChannel(channel);
        try {
          controller.close();
        } catch {
          /* already closed */
        }
      };

      req.signal.addEventListener("abort", shutdown);
      // Close just before the platform would kill it, so the client reconnects
      // on a clean end-of-stream instead of a truncated response.
      setTimeout(shutdown, (maxDuration - 10) * 1000);
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      // Disable proxy buffering, which would otherwise hold events back in
      // chunks and defeat the whole point of the stream.
      "X-Accel-Buffering": "no",
    },
  });
}
