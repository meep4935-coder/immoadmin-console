// Watches the console's OWN intake: how much arrives, what gets rejected, and how late.
// A silent recorder looks exactly like a healthy app — this is how you tell them apart.
const MIN = 60e3;

export function createMonitor() {
  const buckets = new Map();           // minute → { accepted, rejected, batches, reasons: Map }
  const lag = new Map();               // source → { ms, at }
  let lastIngestAt = 0;
  const bucketOf = (t) => Math.floor(t / MIN);

  return {
    /** Call once per POST /ingest. `rejected`: [{reason}]. `spans`: normalized rows (for lag). */
    record({ accepted, rejected = [], spans = [], now = Date.now() }) {
      const b = buckets.get(bucketOf(now)) || { accepted: 0, rejected: 0, batches: 0, reasons: new Map() };
      b.accepted += accepted; b.rejected += rejected.length; b.batches += 1;
      for (const r of rejected) b.reasons.set(r.reason, (b.reasons.get(r.reason) || 0) + 1);
      buckets.set(bucketOf(now), b);
      for (const k of buckets.keys()) if (k < bucketOf(now) - 60) buckets.delete(k);
      if (accepted) lastIngestAt = now;
      // Lag = how old the newest event of a source is when it arrives (live traffic ≈ <2 s).
      const newest = new Map();
      for (const s of spans) newest.set(s.source || "unknown", Math.max(newest.get(s.source || "unknown") ?? 0, s.ts + (s.dur || 0)));
      for (const [src, end] of newest) lag.set(src, { ms: Math.max(0, now - end), at: now });
    },
    snapshot(now = Date.now(), windowMs = 5 * MIN) {
      let accepted = 0, rejected = 0, batches = 0; const reasons = new Map();
      for (const [k, b] of buckets) {
        if (k < bucketOf(now - windowMs)) continue;
        accepted += b.accepted; rejected += b.rejected; batches += b.batches;
        for (const [r, n] of b.reasons) reasons.set(r, (reasons.get(r) || 0) + n);
      }
      return {
        windowMin: Math.round(windowMs / MIN), accepted, rejected, batches, lastIngestAt,
        rejectReasons: [...reasons.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5).map(([reason, count]) => ({ reason, count })),
        lag: Object.fromEntries([...lag.entries()].map(([s, v]) => [s, v.ms])),
      };
    },
  };
}
