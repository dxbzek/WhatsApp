// Server-side drip schedule. Mirrors the client planDripTimes logic so the
// queued send_at times are identical to what the UI previews, but computed on
// the server at enqueue time (the browser no longer drives the loop).
//
// Daytime send window: 9:00-20:00 Dubai (GMT+4) = 05:00-16:00 UTC. Owners
// shouldn't get a property message at 2am — it kills replies and looks like
// spam, and overnight marketing correlates with Meta's per-user throttle.
function nextDaytimeUTC(d: Date): Date {
  const x = new Date(d.getTime());
  const h = x.getUTCHours();
  if (h >= 5 && h < 16) return x; // already inside the window
  if (h >= 16) x.setUTCDate(x.getUTCDate() + 1); // after window -> tomorrow morning
  x.setUTCHours(5, 0, 0, 0); // 05:00 UTC = 09:00 Dubai
  return x;
}

// One send time per batch. Batch 0 is "now" (dispatcher picks it up on the next
// run); later batches step by intervalMin, rolled into the next morning when
// daytime is on so nothing lands overnight.
export function dripBatchTimes(batches: number, intervalMin: number, daytime: boolean, now: Date = new Date()): Date[] {
  const out: Date[] = [];
  let cursor = now;
  for (let c = 0; c < batches; c++) {
    if (c === 0) {
      const t = daytime ? nextDaytimeUTC(now) : now;
      cursor = t;
      out.push(t);
    } else {
      let t = new Date(cursor.getTime() + intervalMin * 60000);
      if (daytime) t = nextDaytimeUTC(t);
      cursor = t;
      out.push(t);
    }
  }
  return out;
}

// send_at (ISO) for the recipient at position `index` in the (already filtered)
// recipient list, given the batch size.
export function sendAtForIndex(index: number, perBatch: number, times: Date[]): string {
  const b = Math.min(times.length - 1, Math.floor(index / Math.max(1, perBatch)));
  return times[Math.max(0, b)].toISOString();
}
