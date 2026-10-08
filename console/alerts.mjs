// Alert rules. Each rule returns conditions {key, severity, title, detail, data}.
// evaluate() reconciles them with the alerts table: new key → open + notify,
// still-true key → touch, key no longer true → resolve. A persistent problem is
// therefore ONE alert with a counter, not a stream of duplicates.
//
// Every condition carries data.last_event_ts: when the problem LAST ACTUALLY HAPPENED.
// (The alert's own last_ts is only "the rule was still true at the last check", which for
// a windowed rule can be minutes after the final occurrence.)
import { percentile } from "./store.mjs";
import { healthOf } from "./health.mjs";
import { evaluateExpectations, loadExpectations } from "./expectations.mjs";
import { evaluateDependenciesCached } from "./dependencies.mjs";

const MIN = 60e3;

function rules(store, cfg, now, ctx) {
  const a = cfg.alerts;
  const win = now - a.windowMin * MIN;
  const out = [];

  // 1) Crashes — anything of kind "crash" is critical immediately.
  for (const r of store.all(
    `SELECT fingerprint, COUNT(*) n, COUNT(DISTINCT user_id) users, MAX(name) name, MAX(trace_id) trace_id, MAX(ts) last
       FROM spans WHERE kind='crash' AND ts >= ? GROUP BY fingerprint`, now - 10 * MIN)) {
    out.push({
      key: `crash:${r.fingerprint ?? r.name}`, severity: "critical",
      title: `Crash: ${r.name}`, detail: `${r.n} occurrence(s), ${r.users} user(s) in the last 10 min`,
      data: { trace_id: r.trace_id, fingerprint: r.fingerprint, last_event_ts: r.last },
    });
  }

  // 2) Error spike versus the previous hour's baseline.
  // (counted in failed actions = distinct traces, not error spans)
  const curRow = store.get(`SELECT COUNT(DISTINCT trace_id) n, MAX(ts) last FROM spans WHERE status='error' AND ts >= ?`, win);
  const cur = curRow.n;
  const prev = store.get(`SELECT COUNT(DISTINCT trace_id) n FROM spans WHERE status='error' AND ts >= ? AND ts < ?`, win - 60 * MIN, win).n;
  const perWindowBaseline = Math.max(1, prev / (60 / a.windowMin));
  if (cur >= a.errorSpikeMin && cur >= a.errorSpikeFactor * perWindowBaseline) {
    out.push({
      key: "error_spike", severity: cur >= a.errorSpikeMin * 4 ? "critical" : "warning",
      title: "Error spike",
      detail: `${cur} errors in ${a.windowMin} min (normal ≈ ${perWindowBaseline.toFixed(1)})`,
      data: { current: cur, baseline: perWindowBaseline, last_event_ts: curRow.last },
    });
  }

  // 3) Routes failing or slow.
  const byRoute = new Map();
  for (const r of store.all(
    `SELECT route, dur, status, ts FROM spans WHERE kind='net.server' AND ts >= ? AND route IS NOT NULL`, win)) {
    const e = byRoute.get(r.route) || { n: 0, err: 0, durs: [], lastErr: 0, lastSlow: 0 };
    e.n++;
    if (r.status === "error") { e.err++; e.lastErr = Math.max(e.lastErr, r.ts); }
    if (r.dur != null) { e.durs.push(r.dur); if (r.dur > a.routeSlowP95Ms) e.lastSlow = Math.max(e.lastSlow, r.ts); }
    byRoute.set(r.route, e);
  }
  for (const [route, e] of byRoute) {
    const rate = e.err / e.n;
    if (e.n >= a.routeMinRequests && rate >= a.routeFailRate) {
      out.push({
        key: `route_failing:${route}`, severity: rate >= 0.5 ? "critical" : "warning",
        title: `Route failing: ${route}`, detail: `${e.err}/${e.n} requests failed (${Math.round(rate * 100)}%) in ${a.windowMin} min`,
        data: { route, n: e.n, errors: e.err, last_event_ts: e.lastErr },
      });
    }
    e.durs.sort((x, y) => x - y);
    const p95 = percentile(e.durs, 95);
    if (e.n >= a.routeSlowMinRequests && p95 != null && p95 > a.routeSlowP95Ms) {
      out.push({
        key: `route_slow:${route}`, severity: "warning",
        title: `Route slow: ${route}`, detail: `p95 ${Math.round(p95)} ms over ${e.n} requests in ${a.windowMin} min`,
        data: { route, p95, n: e.n, last_event_ts: e.lastSlow || now },
      });
    }
  }

  // 4) Users struggling — ONE grouped alert, and only for failures nothing else already explains.
  //    • rate-based: a user counts only at the "failing" level (≥3 failed actions AND ≥25 % of their actions),
  //      not at a few percent of background noise;
  //    • explained-away: actions that hit a route already alerted as failing/slow, or that sit in a trace with a
  //      crash that is already alerted, are left out — "Route failing" already says it;
  //    • grouped: one alert "N users are struggling" (the list is in the alert), never one per user.
  const explainedRoutes = out.filter((c) => c.key.startsWith("route_failing:") || c.key.startsWith("route_slow:")).map((c) => c.data.route);
  const crashAlerted = out.some((c) => c.key.startsWith("crash:"));
  const explained = new Set();
  if (explainedRoutes.length || crashAlerted) {
    const ph = explainedRoutes.map(() => "?").join(",");
    const sql = `SELECT DISTINCT trace_id FROM spans WHERE ts >= ? AND (${[explainedRoutes.length ? `(kind='net.server' AND route IN (${ph}))` : null, crashAlerted ? `kind='crash'` : null].filter(Boolean).join(" OR ")})`;
    for (const r of store.all(sql, win, ...explainedRoutes)) explained.add(r.trace_id);
  }
  const perUser = new Map();
  for (const r of store.all(`SELECT user_id, trace_id, status, ts FROM spans WHERE ts >= ? AND user_id IS NOT NULL AND user_id != ''`, win)) {
    if (explained.has(r.trace_id)) continue;
    const u = perUser.get(r.user_id) || { traces: new Set(), errors: new Set(), dead: new Set(), slow: new Set(), last: 0 };
    u.traces.add(r.trace_id);
    if (r.status === "error") { u.errors.add(r.trace_id); u.last = Math.max(u.last, r.ts); }
    else if (r.status === "dead") { u.dead.add(r.trace_id); u.last = Math.max(u.last, r.ts); }
    else if (r.status === "slow") u.slow.add(r.trace_id);
    perUser.set(r.user_id, u);
  }
  const struggling = [];
  for (const [id, u] of perUser) {
    const stats = { errors: u.errors.size, dead: u.dead.size, slow: u.slow.size, traces: u.traces.size };
    if (healthOf(stats) === "failing") struggling.push({ id, ...stats, last: u.last });
  }
  if (struggling.length >= a.struggleMinUsers) {
    struggling.sort((x, y) => (y.errors + y.dead) - (x.errors + x.dead));
    out.push({
      key: "users_struggling", severity: "warning",
      title: `${struggling.length} users are struggling`,
      detail: `${struggling.length} users had most of their recent actions fail, for reasons no other alert explains: ${struggling.slice(0, 5).map((u) => u.id).join(", ")}${struggling.length > 5 ? ", …" : ""}`,
      data: { users: struggling.slice(0, 20).map((u) => u.id), last_event_ts: Math.max(...struggling.map((u) => u.last)) },
    });
  }

  // 5) Error types never seen before the window (skipping ones a human marked ignored,
  //    or fixed — unless they came back AFTER the fix, which is exactly what should alert).
  const triaged = store.triageMap("error");
  for (const r of store.all(
    `SELECT fingerprint, MIN(ts) first, MAX(ts) last, COUNT(*) n, MAX(name) name, MAX(trace_id) trace_id
       FROM spans s WHERE fingerprint IS NOT NULL
        AND NOT EXISTS (SELECT 1 FROM spans c WHERE c.parent_id = s.id AND c.status = 'error')
      GROUP BY fingerprint HAVING MIN(ts) >= ?`,
    now - a.newErrorWindowMin * MIN)) {
    const t = triaged.get(r.fingerprint);
    if (t && (t.status === "ignored" || (t.status === "fixed" && r.last <= t.updated_ts + 1000))) continue;
    out.push({
      key: `new_error:${r.fingerprint}`, severity: "info",
      title: `New error type: ${r.name}`, detail: `first seen ${Math.round((now - r.first) / 1000)} s ago, ${r.n} occurrence(s)`,
      data: { fingerprint: r.fingerprint, trace_id: r.trace_id, last_event_ts: r.last },
    });
  }

  // 6) Silence: nothing RECEIVED lately although data was flowing before. Uses the
  //    wall-clock time of the last ingest (not event timestamps, which a backfill or a
  //    client with a wrong clock would distort). Only armed once this process has
  //    received something, so a freshly started console never alarms on an empty feed.
  if (a.silenceMin > 0 && ctx.lastIngestAt) {
    const before = store.get(
      `SELECT COUNT(*) n FROM spans WHERE ts >= ? AND ts <= ?`, ctx.lastIngestAt - 60 * MIN, ctx.lastIngestAt).n;
    if (now - ctx.lastIngestAt > a.silenceMin * MIN && before >= 20) {
      out.push({
        key: "silence", severity: "critical", title: "No data received",
        detail: `nothing received for ${Math.round((now - ctx.lastIngestAt) / MIN)} min (was ${before} events in the hour before)`,
        data: { last_event_ts: ctx.lastIngestAt },
      });
    }
  }
  // 7) The recorders themselves: dropped events, clock drift, rejected data.
  //    Missing data is a bug in the monitoring, and it makes every other number untrustworthy.
  const beats = store.latestHealth(now - 10 * MIN);
  const dropping = beats.filter((b) => (b.dropped || 0) > 0);
  if (dropping.length) {
    const total = dropping.reduce((s, b) => s + b.dropped, 0);
    out.push({ key: "recorder_dropping", severity: "warning", title: "A recorder is losing events",
      detail: `${dropping.length} recorder(s) have dropped ${total} event(s) in total (${[...new Set(dropping.map((b) => b.source))].join(", ")}). Some actions are missing from the traces.`,
      data: { last_event_ts: Math.max(...dropping.map((b) => b.ts)) } });
  }
  const skewed = beats.filter((b) => b.skew_ms != null && Math.abs(b.skew_ms) > a.skewMs);
  if (skewed.length) {
    const worst = skewed.reduce((m, b) => (Math.abs(b.skew_ms) > Math.abs(m.skew_ms) ? b : m));
    out.push({ key: "clock_skew", severity: "warning", title: "Browser and server clocks disagree",
      detail: `A ${worst.source} clock is ${(Math.abs(worst.skew_ms) / 1000).toFixed(1)} s ${worst.skew_ms > 0 ? "ahead of" : "behind"} the server: timelines that mix both will show steps in the wrong order.`,
      data: { last_event_ts: worst.ts, skew_ms: worst.skew_ms } });
  }
  const snap = ctx.monitor?.snapshot(now);
  if (snap && snap.rejected >= a.rejectMin) {
    out.push({ key: "ingest_rejects", severity: "warning", title: "The console is rejecting data",
      detail: `${snap.rejected} span(s) rejected in the last ${snap.windowMin} min — most common reason: ${snap.rejectReasons[0]?.reason ?? "unknown"}`,
      data: { last_event_ts: now, reasons: snap.rejectReasons } });
  }
  // 8) Absence: things that should have happened and did not (expectations.json; off unless enabled).
  const conf = ctx.expectations ?? loadExpectations();
  for (const row of evaluateExpectations(store, conf, now, ctx.vercelCrons).rows) {
    if (row.status !== "missed") continue;
    out.push({
      key: `absence:${row.kind}:${row.name}`, severity: row.severity,
      title: `Expected activity is missing: ${row.name}`,
      detail: `${row.kind === "cron" ? `Scheduled ${row.schedule} (last due ${new Date(row.expected_at).toISOString().slice(0, 16).replace("T", " ")} UTC)` : `Expected ${row.schedule}`}, ${row.last_seen ? `but the last time it was seen was ${Math.round((now - row.last_seen) / 60e3)} min ago` : "but it has never been seen"}${row.missed >= 2 ? ` — ${row.missed} runs in a row missed` : ""}.`,
      data: { last_event_ts: row.last_seen ?? undefined, expected_at: row.expected_at },
    });
  }
  // 9) An outside service is failing or slow (Stripe, Zūm Rails, Twilio, Anthropic, Supabase…).
  for (const svc of evaluateDependenciesCached(store, cfg, now)) {
    if (svc.status !== "down" && svc.status !== "degraded") continue;
    out.push({
      key: `dependency:${svc.name}`, severity: svc.status === "down" ? "critical" : "warning",
      title: `${svc.name} is ${svc.status === "down" ? "down" : "degraded"}`, detail: svc.reasons.join("; ") + (svc.top_error ? ` — most common error: ${svc.top_error.message}` : ""),
      data: { service: svc.name, last_event_ts: svc.last_error ?? undefined },
    });
  }
  return out;
}

export async function evaluate(store, cfg, now = Date.now(), notify = () => {}, ctx = {}) {
  const conds = rules(store, cfg, now, ctx);
  const seen = new Set();
  for (const c of conds) {
    seen.add(c.key);
    const existing = store.openAlertByKey(c.key);
    if (existing) store.touchAlert(existing.id, c, now);
    else {
      const id = store.openAlert(c, now);
      await notify({ ...c, id, event: "opened" });
    }
  }
  for (const o of store.openAlertKeys()) {
    if (!seen.has(o.key)) {
      store.resolveAlert(o.id, now);
      await notify({ id: o.id, key: o.key, event: "resolved" });
    }
  }
  return conds.length;
}
