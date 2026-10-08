// Baseline / drift detection: "is this normal for THIS route / control?"
// Learns normal from history (no rules to write) and flags departures. Pure analysis
// over rows supplied by the store, so it is deterministic and testable.
import { percentile } from "./store.mjs";

const HOUR = 3600e3, DAY = 86400e3;

function group(rows, keyOf, isErr) {
  const m = new Map();
  for (const r of rows) {
    const k = keyOf(r);
    const e = m.get(k) || { n: 0, errors: 0, dead: 0, durs: [], byDay: new Map() };
    e.n++;
    if (isErr(r)) e.errors++;
    if (r.status === "dead") e.dead++;
    if (r.dur != null) { e.durs.push(r.dur); const d = Math.floor(r.ts / DAY); (e.byDay.get(d) || e.byDay.set(d, []).get(d)).push(r.dur); }
    m.set(k, e);
  }
  for (const e of m.values()) e.durs.sort((a, b) => a - b);
  return m;
}
const pct = (x) => `${(x * 100).toFixed(x < 0.1 ? 1 : 0)}%`;
const ms = (x) => `${Math.round(x)} ms`;

/**
 * @param {{baseline: object[], recent: object[], clicksBase: object[], clicksRecent: object[], now: number, recentMs: number, baselineMs: number}} data
 *   rows: {route|name, dur, status, ts}
 * @returns finding[]
 */
export function analyzeDrift(data, d) {
  const { baseline, recent, clicksBase, clicksRecent, now, recentMs, baselineMs } = data;
  const out = [];
  const bucket = Math.floor(now / HOUR);
  const add = (rule, severity, key, title, detail, extra) =>
    out.push({ rule, category: "drift", severity, key, title, detail, trace_id: null, span_id: null, user_id: null, session_id: null, ts: now, dedupe: `${rule}|${key}|${bucket}`, data: extra });

  const B = group(baseline, (r) => r.route, (r) => r.status === "error");
  const R = group(recent, (r) => r.route, (r) => r.status === "error");
  const baselineHours = baselineMs / HOUR;

  for (const [route, b] of B) {
    if (b.n < d.minSamples) continue;
    const r = R.get(route) || { n: 0, errors: 0, durs: [], byDay: new Map() };

    const expected = (b.n / baselineHours) * (recentMs / HOUR);
    if (baselineHours >= 24 && expected >= d.minExpectedVolume && r.n <= d.volumeDropRatio * expected) {
      add("volume_drop", "info", route, `Traffic dropped: ${route}`,
        `${r.n} request(s) in the last ${Math.round(recentMs / 60e3)} min, normally about ${Math.round(expected)}. A feature that went quiet can mean a broken button, a failing page, or users giving up.`, { recent: r.n, expected: Math.round(expected) });
    }
    if (r.n < d.minRecent) continue;

    const bp95 = percentile(b.durs, 95), rp95 = percentile(r.durs, 95), bp50 = percentile(b.durs, 50), rp50 = percentile(r.durs, 50);
    if (bp95 != null && rp95 >= d.p95Ratio * bp95 && rp95 - bp95 >= d.p95MinDiffMs) {
      add("latency_drift", rp95 >= 2 * bp95 ? "warning" : "info", route, `Slower than usual: ${route}`,
        `p95 is ${ms(rp95)} now versus ${ms(bp95)} normally (×${(rp95 / bp95).toFixed(1)}), median ${ms(rp50)} versus ${ms(bp50)}, over ${r.n} requests.`, { p95: rp95, baseline_p95: bp95 });
    }
    const br = b.errors / b.n, rr = r.errors / r.n;
    if (r.errors >= 3 && rr >= Math.max(d.errRatio * br, br + d.errAbs)) {
      add("error_rate_drift", rr >= 0.3 ? "critical" : "warning", route, `More failures than usual: ${route}`,
        `${pct(rr)} of requests failed (${r.errors}/${r.n}) versus ${pct(br)} normally.`, { rate: rr, baseline_rate: br });
    }

    // Slow creep: median rising day after day.
    const days = [...b.byDay.entries()].filter(([, v]) => v.length >= d.creepMinPerDay).sort((x, y) => x[0] - y[0]).map(([, v]) => percentile([...v].sort((x, y) => x - y), 50));
    if (days.length >= d.creepDays) {
      const last = days.slice(-d.creepDays);
      const rising = last.every((v, i) => i === 0 || v >= last[i - 1] * 0.98);
      if (rising && last[last.length - 1] >= last[0] * d.creepRatio && last[last.length - 1] - last[0] >= 50) {
        add("slow_creep", "warning", route, `Getting slower every day: ${route}`,
          `Median latency rose over ${d.creepDays} days: ${last.map(ms).join(" → ")} (×${(last[last.length - 1] / last[0]).toFixed(1)}).`, { medians: last });
      }
    }
  }

  // Controls whose clicks increasingly do nothing.
  const CB = group(clicksBase, (r) => r.name, (r) => r.status === "error");
  const CR = group(clicksRecent, (r) => r.name, (r) => r.status === "error");
  for (const [name, b] of CB) {
    const r = CR.get(name);
    if (!r || b.n < d.minSamples || r.n < 5) continue;
    const br = b.dead / b.n, rr = r.dead / r.n;
    if (r.dead >= 2 && rr >= Math.max(3 * br, br + 0.15)) {
      add("dead_click_drift", "warning", name, `More dead clicks than usual: ${name}`,
        `${pct(rr)} of clicks did nothing (${r.dead}/${r.n}) versus ${pct(br)} normally — something may have broken this control.`, { rate: rr, baseline_rate: br });
    }
  }
  return out;
}

/**
 * Release regression: for each route, the LATEST release versus the one before it.
 * "It got slower" becomes "it got slower in release X". Needs ≥ minSamples in both releases.
 * @param rows   {route, dur, status, ts, app_version}
 * @param releases [{version, first_seen}] oldest first
 */
export function analyzeRegression(rows, releases, now, d) {
  if (releases.length < 2) return [];
  const cur = releases[releases.length - 1].version, prev = releases[releases.length - 2].version;
  const by = (v) => group(rows.filter((r) => r.app_version === v), (r) => r.route, (r) => r.status === "error");
  const C = by(cur), P = by(prev);
  const out = [], bucket = Math.floor(now / HOUR);
  const add = (rule, severity, key, title, detail, extra) =>
    out.push({ rule, category: "drift", severity, key, title, detail, trace_id: null, span_id: null, user_id: null, session_id: null, ts: now, dedupe: `${rule}|${key}|${bucket}`, data: extra });
  for (const [route, c] of C) {
    const p = P.get(route);
    if (!p || c.n < d.minSamples || p.n < d.minSamples) continue;
    const c95 = percentile(c.durs, 95), p95 = percentile(p.durs, 95);
    if (p95 != null && c95 >= d.p95Ratio * p95 && c95 - p95 >= d.p95MinDiffMs) {
      add("release_regression", c95 >= 2 * p95 ? "warning" : "info", `${route} @ ${cur}`, `Slower since release ${cur}: ${route}`,
        `p95 is ${ms(c95)} in ${cur} (${c.n} requests) versus ${ms(p95)} in ${prev} (${p.n} requests), ×${(c95 / p95).toFixed(1)}.`, { release: cur, previous: prev, p95: c95, previous_p95: p95 });
    }
    const cr = c.errors / c.n, pr = p.errors / p.n;
    if (c.errors >= 3 && cr >= Math.max(d.errRatio * pr, pr + d.errAbs)) {
      add("release_regression", cr >= 0.3 ? "critical" : "warning", `${route} @ ${cur} (errors)`, `More failures since release ${cur}: ${route}`,
        `${pct(cr)} of requests failed in ${cur} (${c.errors}/${c.n}) versus ${pct(pr)} in ${prev}.`, { release: cur, previous: prev, rate: cr, previous_rate: pr });
    }
  }
  return out;
}

export function evaluateDrift(store, cfg, now = Date.now()) {
  const d = cfg.drift;
  const recentMs = d.recentMin * 60e3, baselineMs = d.baselineDays * DAY;
  const split = now - recentMs;
  const from = now - baselineMs - recentMs;
  const data = {
    baseline: store.routeSamples({ from, to: split }),
    recent: store.routeSamples({ from: split, to: now + 1 }),
    clicksBase: store.clickSamples({ from, to: split }),
    clicksRecent: store.clickSamples({ from: split, to: now + 1 }),
    now, recentMs, baselineMs,
  };
  const releases = store.releases().filter((r) => r.last_seen >= now - baselineMs);
  const regress = releases.length >= 2
    ? analyzeRegression(store.routeSamples({ from: now - baselineMs, to: now + 1 }), releases, now, d) : [];
  return [...analyzeDrift(data, d), ...regress];
}
