"use client";

import { useEffect, useRef, useState } from "react";

// Subscribe a page to live DB changes pushed from /api/stream (SSE).
//
// The stream carries only "something changed in <table>" — never row data — so
// the page still reads through its own gated API and no extra data is exposed.
// Bursts are coalesced: a drip batch fires ~20 row updates within a second, and
// we want one refetch out of that, not twenty.
//
// `onChange` is held in a ref so a page can pass an inline closure without
// tearing down and rebuilding the EventSource on every render.
export function useLive(tables: string[], onChange: () => void, debounceMs = 400) {
  const cb = useRef(onChange);
  cb.current = onChange;
  const [connected, setConnected] = useState(false);
  const watch = tables.join(",");

  useEffect(() => {
    // Guard for SSR and for browsers without EventSource: the caller's polling
    // fallback stays in charge, so the page degrades to its old behaviour.
    if (typeof window === "undefined" || typeof EventSource === "undefined") return;

    const wanted = new Set(watch.split(",").filter(Boolean));
    let timer: ReturnType<typeof setTimeout> | null = null;
    let es: EventSource | null = null;
    let retry: ReturnType<typeof setTimeout> | null = null;
    let attempts = 0;
    let dead = false;

    const fire = () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => { timer = null; cb.current(); }, debounceMs);
    };

    const connect = () => {
      if (dead) return;
      es = new EventSource("/api/stream");

      es.addEventListener("change", (e) => {
        try {
          const d = JSON.parse((e as MessageEvent).data);
          if (!wanted.size || wanted.has(d.table)) fire();
        } catch {
          /* malformed frame — ignore rather than kill the feed */
        }
      });

      es.addEventListener("status", (e) => {
        try {
          const d = JSON.parse((e as MessageEvent).data);
          if (d.status === "SUBSCRIBED") { attempts = 0; setConnected(true); }
        } catch {
          /* ignore */
        }
      });

      // The route closes the stream itself before the platform timeout, so an
      // error here is usually that clean end-of-stream. Reconnect with backoff
      // (capped) rather than hammering a genuinely down endpoint.
      es.onerror = () => {
        setConnected(false);
        es?.close();
        es = null;
        if (dead) return;
        const wait = Math.min(30000, 1000 * 2 ** Math.min(attempts++, 5));
        retry = setTimeout(connect, wait);
      };
    };

    connect();

    // A backgrounded tab gets its timers throttled and can miss frames, so
    // refetch once on return to make sure the view is current.
    const onVisible = () => { if (!document.hidden) fire(); };
    document.addEventListener("visibilitychange", onVisible);

    return () => {
      dead = true;
      document.removeEventListener("visibilitychange", onVisible);
      if (timer) clearTimeout(timer);
      if (retry) clearTimeout(retry);
      es?.close();
      setConnected(false);
    };
  }, [watch, debounceMs]);

  return connected;
}
