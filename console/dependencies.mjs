// Health of the outside services ImmoAdmin depends on (Stripe, Zūm Rails, Twilio, Anthropic, Supabase…),
// derived from the outbound calls the server recorder already captures (kind external / db, attrs.host).
// A third party degrading shows up as "everything is slow" or "payments fail" — this names the culprit.
import { percentile } from "./store.mjs";

const MIN = 60e3;

const SERVICES = [
  [/supabase\.(co|in|net)$/, "Supabase"], [/(^|\.)stripe\.com$/, "Stripe"], [/zumrails/, "Zūm Rails"], [/twilio/, "Twilio"],
  [/anthropic/, "Anthropic"], [/resend\.com$/, "Resend"], [/emailjs/, "EmailJS"], [/cloudconvert/, "CloudConvert"],
  [/singlekey/, "SingleKey"], [/upstash/, "Upstash"], [/groq\.com$/, "Groq"], [/googleapis|google\.com$/, "Google"], [/sentry\.io$/, "Sentry"],
];
/** host → friendly service name (unknown hosts keep their host name). */
export function serviceOf(host) {
  const h = String(host || "").toLowerCase().replace(/:\d+$/, "");
  for (const [re, name] of SERVICES) if (re.test(h)) return name;
  return host || "unknown";
}

/**
 * @param rows  {host, dur, status, ts, msg}
 * @param o     {now, rangeMs, bucketMs}
 * @param d     thresholds (config.dependencies)
 */
export function analyzeDependencies(rows, { now, rangeMs, bucketMs }, d) {
  const by = new Map();
  for (const r of rows) {
    const name = serviceOf(r.host);
    const e = by.get(name) || { name, hosts: new Set(), rows: [] };
    e.hosts.add(r.host); e.rows.push(r); by.set(name, e);
  }
  const recentFrom = now - d.recentMin * MIN;
  const out = [];
  for (const e of by.values()) {
    const durs = e.rows.filter((r) => r.dur != null).map((r) => r.dur).sort((a, b) => a - b);
    const errors = e.rows.filter((r) => r.status === "error");
    const recent = e.rows.filter((r) => r.ts >= recentFrom), base = e.rows.filter((r) => r.ts < recentFrom);
    const rErr = recent.filter((r) => r.status === "error").length;
    const rd = recent.map((r) => r.dur).filter((x) => x != null).sort((a, b) => a - b);
    const bd = base.map((r) => r.dur).filter((x) => x != null).sort((a, b) => a - b);

    let status = recent.length >= d.minRecent ? "healthy" : "idle";
    const reasons = [];
    if (recent.length >= d.minRecent) {
      const rate = rErr / recent.length;
      if (rate >= d.downRate) { status = "down"; reasons.push(`${Math.round(rate * 100)}% of the last ${recent.length} calls failed`); }
      else if (rate >= d.errorRate) { status = "degraded"; reasons.push(`${Math.round(rate * 100)}% of the last ${recent.length} calls failed`); }
      const rp95 = percentile(rd, 95), bp95 = percentile(bd, 95);
      if (bd.length >= d.minBaseline && rp95 != null && bp95 != null && rp95 >= Math.max(d.slowRatio * bp95, bp95 + d.slowMinDiffMs)) {
        if (status === "healthy") status = "degraded";
        reasons.push(`p95 latency ${Math.round(rp95)} ms versus ${Math.round(bp95)} ms normally`);
      }
    }

    const msgCount = new Map();
    for (const r of errors) if (r.msg) msgCount.set(r.msg, (msgCount.get(r.msg) || 0) + 1);
    const topError = [...msgCount.entries()].sort((a, b) => b[1] - a[1])[0];

    const bk = new Map();
    for (const r of e.rows) {
      const k = Math.floor(r.ts / bucketMs) * bucketMs;
      const b = bk.get(k) || { b: k, n: 0, errors: 0, durs: [] };
      b.n++; if (r.status === "error") b.errors++; if (r.dur != null) b.durs.push(r.dur);
      bk.set(k, b);
    }
    out.push({
      name: e.name, hosts: [...e.hosts].slice(0, 3), status, reasons,
      calls: e.rows.length, errors: errors.length, error_rate: e.rows.length ? errors.length / e.rows.length : 0,
      p50: percentile(durs, 50), p95: percentile(durs, 95),
      last_ok: Math.max(0, ...e.rows.filter((r) => r.status !== "error").map((r) => r.ts)) || null,
      last_error: Math.max(0, ...errors.map((r) => r.ts)) || null,
      top_error: topError ? { message: topError[0], count: topError[1] } : null,
      buckets: [...bk.values()].sort((a, b) => a.b - b.b).map((b) => ({ b: b.b, n: b.n, errors: b.errors, p95: percentile(b.durs.sort((x, y) => x - y), 95) })),
    });
  }
  const rank = { down: 0, degraded: 1, healthy: 2, idle: 3 };
  return out.sort((a, b) => rank[a.status] - rank[b.status] || b.calls - a.calls);
}

// ── convenience wrappers around the store ────────────────────────────────────
const cache = { at: -1, key: "", value: null };
export function evaluateDependencies(store, cfg, now = Date.now(), rangeMs = 24 * 3600e3) {
  const bucketMs = rangeMs <= 3600e3 ? 60e3 : rangeMs <= 6 * 3600e3 ? 300e3 : rangeMs <= 86400e3 ? 3600e3 : 6 * 3600e3;
  const rows = store.dependencySamples({ from: now - rangeMs, to: now + 1 });
  return analyzeDependencies(rows, { now, rangeMs, bucketMs }, cfg.dependencies);
}
/** Same, memoised for 60 s — the alert loop runs every 15 s and this scans a day of outbound calls. */
export function evaluateDependenciesCached(store, cfg, now) {
  const minute = Math.floor(now / MIN), key = String(store.file);
  if (cache.at === minute && cache.key === key) return cache.value;
  cache.value = evaluateDependencies(store, cfg, now); cache.at = minute; cache.key = key;
  return cache.value;
}
