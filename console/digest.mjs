// Periodic digest: what got worse, what got better, what is new — compared with the
// previous period of the same length. Output is markdown (also served at /api/digest).
import { percentile } from "./store.mjs";
import { healthOf } from "./health.mjs";
import { applyTriage, countFindings, findingRef, errorRef } from "./triage.mjs";

const fmtMs = (ms) => (ms == null ? "—" : ms < 1000 ? `${Math.round(ms)} ms` : `${(ms / 1000).toFixed(2)} s`);
const pct = (x) => `${(x * 100).toFixed(x < 0.1 ? 1 : 0)}%`;
const iso = (ts) => new Date(ts).toISOString().replace("T", " ").slice(0, 16) + " UTC";
const arrow = (cur, prev, goodWhenLower = true) => {
  if (!prev) return "";
  const r = cur / prev - 1;
  if (Math.abs(r) < 0.05) return " (≈ same)";
  const worse = goodWhenLower ? r > 0 : r < 0;
  return ` (${r > 0 ? "▲" : "▼"} ${Math.abs(Math.round(r * 100))}% ${worse ? "worse" : "better"})`;
};

function windowStats(store, from, to) {
  const rows = store.routeSamples({ from, to });
  const durs = rows.map((r) => r.dur).filter((d) => d != null).sort((a, b) => a - b);
  const errors = rows.filter((r) => r.status === "error").length;
  const u = store.get(`SELECT COUNT(DISTINCT user_id) users, COUNT(DISTINCT trace_id) traces FROM spans WHERE ts >= ? AND ts < ? AND user_id IS NOT NULL AND user_id != ''`, from, to);
  const failed = store.get(`SELECT COUNT(DISTINCT trace_id) n FROM spans WHERE ts >= ? AND ts < ? AND status = 'error'`, from, to).n;
  const byRoute = new Map();
  for (const r of rows) {
    const e = byRoute.get(r.route) || { route: r.route, durs: [], errors: 0 };
    if (r.dur != null) e.durs.push(r.dur);
    if (r.status === "error") e.errors++;
    byRoute.set(r.route, e);
  }
  for (const e of byRoute.values()) e.durs.sort((a, b) => a - b);
  return { requests: rows.length, errors, errorRate: rows.length ? errors / rows.length : 0, p50: percentile(durs, 50), p95: percentile(durs, 95), users: u.users, traces: u.traces, failedActions: failed, byRoute };
}

export function buildDigest(store, { rangeMs, now = Date.now(), mode = "dev" }) {
  const from = now - rangeMs, pfrom = from - rangeMs;
  const cur = windowStats(store, from, now), prev = windowStats(store, pfrom, from);
  const label = rangeMs >= 86400e3 ? `${Math.round(rangeMs / 86400e3)} day(s)` : `${Math.round(rangeMs / 3600e3)} hour(s)`;
  const md = [];
  md.push(`# Trace Console digest — last ${label}`, "", `_${iso(from)} → ${iso(now)}, compared with the previous ${label}. Console mode: ${mode}._`, "");

  md.push("## At a glance", "",
    "| | This period | Previous |", "|---|---|---|",
    `| Server requests | ${cur.requests}${arrow(cur.requests, prev.requests, false)} | ${prev.requests} |`,
    `| Request error rate | ${pct(cur.errorRate)}${arrow(cur.errorRate, prev.errorRate)} | ${pct(prev.errorRate)} |`,
    `| Latency p95 | ${fmtMs(cur.p95)}${arrow(cur.p95, prev.p95)} | ${fmtMs(prev.p95)} |`,
    `| Failed user actions | ${cur.failedActions}${arrow(cur.failedActions, prev.failedActions)} | ${prev.failedActions} |`,
    `| Active users | ${cur.users} | ${prev.users} |`, "");

  // Routes that changed
  const changes = [];
  for (const [route, c] of cur.byRoute) {
    const p = prev.byRoute.get(route);
    if (!p || c.durs.length < 20 || p.durs.length < 20) continue;
    const c95 = percentile(c.durs, 95), p95 = percentile(p.durs, 95);
    const ratio = c95 / p95;
    if ((ratio >= 1.25 || ratio <= 0.8) && Math.abs(c95 - p95) >= 100) changes.push({ route, c95, p95, ratio, n: c.durs.length });
  }
  const worse = changes.filter((c) => c.ratio > 1).sort((a, b) => b.ratio - a.ratio).slice(0, 8);
  const better = changes.filter((c) => c.ratio < 1).sort((a, b) => a.ratio - b.ratio).slice(0, 5);
  md.push("## Routes that got slower", "");
  md.push(...(worse.length ? worse.map((c) => `- \`${c.route}\` p95 ${fmtMs(c.p95)} → **${fmtMs(c.c95)}** (×${c.ratio.toFixed(1)}, ${c.n} requests)`) : ["_None._"]), "");
  if (better.length) md.push("## Routes that got faster", "", ...better.map((c) => `- \`${c.route}\` p95 ${fmtMs(c.p95)} → ${fmtMs(c.c95)} (×${c.ratio.toFixed(1)})`), "");

  // Errors
  const errs = applyTriage(store, "error", store.listErrors({ since: from, limit: 500 }), errorRef, "open");
  const fresh = new Set(store.firstSeenErrors(from).map((r) => r.fingerprint));
  const newErrs = errs.filter((e) => fresh.has(e.fingerprint)).sort((a, b) => b.n - a.n);
  md.push("## New error types", "");
  md.push(...(newErrs.length ? newErrs.slice(0, 10).map((e) => `- **${e.error?.name ?? "Error"}**: ${String(e.error?.message ?? e.name).slice(0, 110)} — ${e.n}× for ${e.users} user(s) (\`${e.kind}\`${e.route ? `, ${e.route}` : ""})`) : ["_None._"]), "");
  const top = [...errs].sort((a, b) => b.n - a.n).slice(0, 8);
  md.push("## Most frequent errors", "");
  md.push(...(top.length ? top.map((e) => `- ${e.n}× — **${e.error?.name ?? "Error"}**: ${String(e.error?.message ?? e.name).slice(0, 110)} (${e.users} user(s))`) : ["_None._"]), "");

  // Hidden-bug findings
  const findings = applyTriage(store, "finding", store.listFindings({ since: from, limit: 500 }), findingRef, "open");
  const counts = countFindings(findings);
  md.push("## Hidden-bug findings", "");
  if (!findings.length) md.push("_None._", "");
  else {
    md.push(counts.map((c) => `${c.category}: ${c.kinds} kind(s), ${c.n} occurrence(s)`).join(" · "), "");
    for (const f of findings.slice(0, 15)) md.push(`- **[${f.severity}]** ${f.title} — ${f.n}× (${f.rule}, ${f.users} user(s)) — ${f.detail ?? ""}`);
    md.push("");
  }

  // Users
  const users = store.listUsers({ since: from, limit: 500 }).map((u) => ({ ...u, health: healthOf(u) })).filter((u) => u.health !== "healthy").slice(0, 6);
  md.push("## Users who struggled most", "");
  md.push(...(users.length ? users.map((u) => `- \`${u.user_id}\` (${u.role ?? "?"}) — ${u.health}: ${u.errors} failed action(s), ${u.dead} dead click(s), ${u.slow} slow, of ${u.traces} actions`) : ["_Everyone was healthy._"]), "");

  const al = store.all(`SELECT severity, COUNT(*) n FROM alerts WHERE opened_ts >= ? GROUP BY severity`, from);
  md.push("## Alerts raised", "", al.length ? al.map((a) => `${a.severity}: ${a.n}`).join(" · ") : "_None._", "");
  md.push("---", "_Detections are heuristics. Open the matching page in the console for the full trace, or use “Copy bug report”._");
  return md.join("\n");
}
