#!/usr/bin/env node
/**
 * Trace Console — collector + API + web UI (one process, Node built-ins only).
 *
 *   node qa/console/server.mjs                 # http://127.0.0.1:4317
 *   node qa/console/server.mjs --mode=prod     # pseudonymous scrubbing (see scrub.mjs)
 *   node qa/console/server.mjs --port=4400 --db=./other.db
 *
 * Senders POST span batches to /ingest (format: SCHEMA.md). The UI reads the
 * JSON API below and a live SSE stream.
 */
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { cfg, HERE } from "./config.mjs";
import { openStore } from "./store.mjs";
import { normalizeSpan } from "./ingest.mjs";
import { evaluate } from "./alerts.mjs";
import { healthOf } from "./health.mjs";
import { analyzeBatch, analyzeFeedback } from "./pipeline.mjs";
import { evaluateDrift } from "./baseline.mjs";
import { buildReport } from "./report.mjs";
import { buildDigest } from "./digest.mjs";
import { createMonitor } from "./monitor.mjs";
import { evaluateDependencies } from "./dependencies.mjs";
import { evaluateExpectations, loadExpectations } from "./expectations.mjs";
import { applyTriage, countFindings, findingRef, errorRef, KINDS, STATUSES } from "./triage.mjs";

const store = openStore(cfg.dbFile);
const clients = new Set(); // SSE subscribers
const monitor = createMonitor();
let lastIngestAt = 0;      // wall-clock ms of the last accepted batch (0 = nothing yet)

// ── helpers ──────────────────────────────────────────────────────────────────
const send = (res, code, body, type = "application/json; charset=utf-8") => {
  res.writeHead(code, { "Content-Type": type, "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" });
  res.end(type.startsWith("application/json") ? JSON.stringify(body) : body);
};
const num = (v, d, min, max) => {
  const n = Number(v); if (!Number.isFinite(n)) return d;
  return Math.min(max, Math.max(min, n));
};
function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on("data", (c) => {
      size += c.length;
      if (size > limit) { reject(Object.assign(new Error("payload too large"), { code: 413 })); req.destroy(); return; }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}
function broadcast(event, data) {
  const msg = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const c of clients) { try { c.write(msg); } catch { clients.delete(c); } }
}
const WINDOWS = { "5m": 5 * 60e3, "15m": 15 * 60e3, "1h": 3600e3, "6h": 6 * 3600e3, "24h": 86400e3, "7d": 7 * 86400e3, "14d": 14 * 86400e3 };
const since = (u, def = "1h") => Date.now() - (WINDOWS[u.searchParams.get("range")] ?? WINDOWS[def]);

// DNS-rebinding / cross-site guard: only answer requests addressed to loopback.
function hostOk(req) {
  const h = String(req.headers.host || "").toLowerCase();
  return h === `127.0.0.1:${cfg.port}` || h === `localhost:${cfg.port}`;
}

const STATIC = { "/": "index.html", "/index.html": "index.html", "/app.js": "app.js", "/findings.js": "findings.js", "/style.css": "style.css" };
const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8" };

// ── routes ───────────────────────────────────────────────────────────────────
async function handle(req, res) {
  if (!hostOk(req)) return send(res, 403, { error: "forbidden host" });
  const u = new URL(req.url, `http://127.0.0.1:${cfg.port}`);
  const p = u.pathname;

  if (req.method === "GET" && STATIC[p]) {
    const file = path.join(HERE, "ui", STATIC[p]);
    try { return send(res, 200, fs.readFileSync(file), TYPES[path.extname(file)]); }
    catch { return send(res, 404, { error: "ui file missing" }); }
  }

  if (req.method === "POST" && p === "/ingest") {
    if (cfg.token && req.headers["x-trace-token"] !== cfg.token) return send(res, 401, { error: "bad token" });
    let body;
    try { body = JSON.parse(await readBody(req, cfg.maxBodyBytes) || "null"); }
    catch (e) { return send(res, e.code === 413 ? 413 : 400, { error: e.code === 413 ? "payload too large" : "invalid json" }); }
    const list = Array.isArray(body) ? body : Array.isArray(body?.spans) ? body.spans : null;
    if (!list) return send(res, 400, { error: "expected {spans:[…]} or […]" });
    if (list.length > cfg.maxBatch) return send(res, 413, { error: `max ${cfg.maxBatch} spans per batch` });
    const rows = []; const rejected = []; const violations = [];
    list.forEach((raw, i) => {
      const r = normalizeSpan(raw, cfg);
      if (r.row) { rows.push(r.row); if (r.violations?.length) violations.push({ row: r.row, violations: r.violations }); }
      else rejected.push({ index: i, reason: r.reject });
    });
    const beats = rows.filter((r) => r.kind === "health");
    if (beats.length) { rows.splice(0, rows.length, ...rows.filter((r) => r.kind !== "health")); store.recordHealth(beats); }
    monitor.record({ accepted: rows.length + beats.length, rejected, spans: rows });
    if (rows.length) {
      store.insertSpans(rows);
      lastIngestAt = Date.now();
      try { for (const f of analyzeBatch(store, rows, violations, cfg)) broadcast("finding", { rule: f.rule, severity: f.severity, title: f.title }); }
      catch (e) { console.error("[detect] failed:", e); }
      for (const r of rows) {
        broadcast("span", {
          id: r.id, trace_id: r.trace_id, ts: r.ts, dur: r.dur, kind: r.kind, name: r.name,
          status: r.status, user_id: r.user_id, route: r.route,
        });
      }
    }
    return send(res, 200, { accepted: rows.length + beats.length, rejected });
  }

  if (req.method === "GET" && p === "/api/stream") {
    res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-store", Connection: "keep-alive" });
    res.write(`retry: 3000\n\n`);
    clients.add(res);
    req.on("close", () => clients.delete(res));
    return;
  }

  if (req.method === "GET" && p === "/api/overview") {
    const o = store.overview(Date.now());
    const users = o.usersByHealth.map((x) => ({ ...x, health: healthOf(x) }));
    return send(res, 200, {
      ...o, usersByHealth: undefined,
      failingUsers: users.filter((x) => x.health === "failing").length,
      degradedUsers: users.filter((x) => x.health === "degraded").length,
      attention: users.filter((x) => x.health !== "healthy").slice(0, 8),
      openAlerts: store.listAlerts({ state: "open" }),
      counts: store.counts(), mode: cfg.mode,
      release: (() => { const r = store.releases(); return r.length ? { current: r[r.length - 1].version, since: r[r.length - 1].first_seen, builds: r.length } : null; })(),
      findings24h: countFindings(applyTriage(store, "finding", store.listFindings({ since: Date.now() - 86400e3, limit: 1000 }), findingRef, "open")),
    });
  }

  if (req.method === "GET" && p === "/api/traces") {
    return send(res, 200, store.listTraces({
      q: u.searchParams.get("q") || undefined, status: u.searchParams.get("status") || undefined,
      user: u.searchParams.get("user") || undefined, route: u.searchParams.get("route") || undefined,
      since: since(u, "24h"), limit: num(u.searchParams.get("limit"), 100, 1, 500), offset: num(u.searchParams.get("offset"), 0, 0, 1e6),
    }));
  }
  let m;
  if (req.method === "GET" && (m = p.match(/^\/api\/trace\/([\w.-]{1,64})$/))) {
    const t = store.getTrace(m[1]);
    return t.spans.length ? send(res, 200, t) : send(res, 404, { error: "trace not found" });
  }

  if (req.method === "GET" && p === "/api/users") {
    const rows = store.listUsers({ since: since(u, "15m") }).map((x) => ({ ...x, health: healthOf(x) }));
    return send(res, 200, { rows });
  }
  if (req.method === "GET" && (m = p.match(/^\/api\/user\/([\w.@:-]{1,64})$/))) {
    const d = store.userDetail(m[1], since(u, "24h"));
    return d.summary?.spans ? send(res, 200, { ...d, health: healthOf(d.summary) }) : send(res, 404, { error: "user not found in range" });
  }

  if (req.method === "GET" && p === "/api/errors") {
    const mode = u.searchParams.get("triage") === "all" ? "all" : "open";
    let rows = applyTriage(store, "error", store.listErrors({ since: since(u, "24h") }), errorRef, mode);
    const intro = store.introducedIn(rows.map((r) => r.fingerprint));
    for (const r of rows) r.introduced_in = intro.get(r.fingerprint) ?? null;
    const rel = store.releases(), latest = rel.length ? rel[rel.length - 1].version : null;
    if (u.searchParams.get("release") === "latest" && latest) rows = rows.filter((r) => r.introduced_in === latest);
    return send(res, 200, { rows, latest_release: latest });
  }
  if (req.method === "GET" && (m = p.match(/^\/api\/error\/([0-9a-f]{12})$/))) {
    return send(res, 200, { occurrences: store.errorOccurrences(m[1]) });
  }

  if (req.method === "GET" && p === "/api/stats") {
    const range = WINDOWS[u.searchParams.get("range")] ?? WINDOWS["24h"];
    const bucketMs = range <= 3600e3 ? 60e3 : range <= 6 * 3600e3 ? 300e3 : range <= 86400e3 ? 3600e3 : 6 * 3600e3;
    const rel = store.releases();
    // A marker = a build that REPLACED another one, inside the viewed range (the very first build is just where the data starts).
    const releases = rel.length > 1 ? rel.slice(1).filter((r) => r.first_seen >= Date.now() - range).map((r) => ({ version: r.version, first_seen: r.first_seen })) : [];
    return send(res, 200, { ...store.stats({ since: Date.now() - range, bucketMs }), bucketMs, range, releases });
  }

  if (req.method === "GET" && p === "/api/alerts") {
    return send(res, 200, { rows: store.listAlerts({ state: u.searchParams.get("state") || undefined }) });
  }
  if (req.method === "POST" && (m = p.match(/^\/api\/alerts\/(\d+)\/ack$/))) {
    if (req.headers["x-console"] !== "1") return send(res, 403, { error: "missing x-console header" });
    store.ackAlert(Number(m[1]));
    return send(res, 200, { ok: true });
  }

  // ── hidden-bug findings, bug reports, digest ──
  if (req.method === "GET" && p === "/api/findings") {
    const mode = u.searchParams.get("triage") === "all" ? "all" : "open";
    const rows = applyTriage(store, "finding", store.listFindings({ since: since(u, "24h"), category: u.searchParams.get("category") || undefined }), findingRef, mode);
    return send(res, 200, { rows, counts: countFindings(rows) });
  }
  if (req.method === "POST" && p === "/api/triage") {
    if (req.headers["x-console"] !== "1") return send(res, 403, { error: "missing x-console header" });
    let b;
    try { b = JSON.parse(await readBody(req, 16 * 1024) || "null"); } catch { return send(res, 400, { error: "invalid json" }); }
    if (!b || !KINDS.includes(b.kind) || !STATUSES.includes(b.status) || typeof b.ref !== "string" || !b.ref || b.ref.length > 300) return send(res, 400, { error: "kind, ref and status required" });
    store.setTriage(b.kind, b.ref, b.status, typeof b.note === "string" ? b.note.slice(0, 500) : null, Date.now());
    return send(res, 200, { ok: true });
  }
  if (req.method === "GET" && p === "/api/finding") {
    const rule = u.searchParams.get("rule"), key = u.searchParams.get("key");
    return rule && key != null ? send(res, 200, { occurrences: store.findingOccurrences(rule, key) }) : send(res, 400, { error: "rule and key required" });
  }
  if (req.method === "GET" && p === "/api/report") {
    const r = buildReport(store, { fingerprint: u.searchParams.get("fp") || undefined, trace: u.searchParams.get("trace") || undefined, rule: u.searchParams.get("rule") || undefined, key: u.searchParams.get("key") ?? undefined });
    return r ? send(res, 200, r) : send(res, 404, { error: "nothing to report on" });
  }
  if (req.method === "GET" && p === "/api/digest") {
    const range = WINDOWS[u.searchParams.get("range")] ?? WINDOWS["24h"];
    return send(res, 200, { markdown: buildDigest(store, { rangeMs: range, mode: cfg.mode }) });
  }

  if (req.method === "GET" && p === "/api/dependencies") {
    const range = WINDOWS[u.searchParams.get("range")] ?? WINDOWS["24h"];
    return send(res, 200, { services: evaluateDependencies(store, cfg, Date.now(), range), range });
  }

  if (req.method === "GET" && p === "/api/expectations") {
    const conf = loadExpectations();
    const r = evaluateExpectations(store, conf, Date.now());
    return send(res, 200, { ...r, config: { crons: conf.crons.enabled, events: conf.events.filter((e) => e.enabled !== false).length } });
  }

  if (req.method === "GET" && p === "/api/recorder-health") {
    const now = Date.now();
    const snap = monitor.snapshot(now);
    const recorders = store.latestHealth(now - 10 * 60e3);
    const issues = [];
    if (snap.rejected >= cfg.alerts.rejectMin) issues.push(`${snap.rejected} span(s) rejected in ${snap.windowMin} min (${snap.rejectReasons[0]?.reason ?? "?"})`);
    const dropped = recorders.reduce((s, r) => s + (r.dropped || 0), 0);
    if (dropped) issues.push(`${dropped} event(s) dropped by recorders`);
    for (const r of recorders) if (r.skew_ms != null && Math.abs(r.skew_ms) > cfg.alerts.skewMs) issues.push(`${r.source} clock is ${(r.skew_ms / 1000).toFixed(1)} s off`);
    if (snap.lastIngestAt && now - snap.lastIngestAt > 5 * 60e3) issues.push(`nothing received for ${Math.round((now - snap.lastIngestAt) / 60e3)} min`);
    return send(res, 200, { ingest: snap, recorders, dropped, issues, healthy: issues.length === 0 });
  }

  if (req.method === "GET" && p === "/api/releases") {
    const rel = store.releases();
    return send(res, 200, { rows: rel, current: rel.length ? rel[rel.length - 1] : null });
  }

  if (req.method === "GET" && p === "/api/health") return send(res, 200, { ok: true, mode: cfg.mode, store: store.kind, ...store.counts() });

  return send(res, 404, { error: "not found" });
}

const server = http.createServer((req, res) => {
  handle(req, res).catch((e) => {
    console.error("[console] handler error:", e);
    if (!res.headersSent) send(res, 500, { error: "internal error" });
    else res.end();
  });
});

// ── alert loop, retention, SSE keepalive ─────────────────────────────────────
async function notify(ev) {
  broadcast("alert", ev);
  if (ev.event === "opened") {
    console.log(`[alert] ${ev.severity.toUpperCase()} ${ev.title} — ${ev.detail ?? ""}`);
    if (cfg.webhookUrl && ev.severity !== "info") {
      try {
        await fetch(cfg.webhookUrl, {
          method: "POST", headers: { "content-type": "application/json" },
          body: JSON.stringify({ severity: ev.severity, title: ev.title, detail: ev.detail }),
          signal: AbortSignal.timeout(5000),
        });
      } catch (e) { console.error("[alert] webhook failed:", e.message); }
    }
  }
}
const evalTimer = setInterval(() => { evaluate(store, cfg, Date.now(), notify, { lastIngestAt, monitor }).catch((e) => console.error("[alerts]", e)); }, cfg.alerts.evalEverySec * 1000);
const driftTimer = setInterval(() => {
  try { for (const f of analyzeFeedback(store, Date.now())) broadcast("finding", { rule: f.rule, severity: f.severity, title: f.title }); } catch (e) { console.error("[feedback]", e); }
  try {
    for (const f of evaluateDrift(store, cfg, Date.now())) if (store.addFinding(f)) { console.log(`[drift] ${f.severity.toUpperCase()} ${f.title} — ${f.detail}`); broadcast("finding", { rule: f.rule, severity: f.severity, title: f.title }); }
  } catch (e) { console.error("[drift]", e); }
}, cfg.drift.everySec * 1000);
const pruneTimer = setInterval(() => {
  try { const n = store.prune(cfg.retentionDays, Date.now()); if (n) console.log(`[retention] pruned ${n} spans`); } catch (e) { console.error("[retention]", e); }
}, 6 * 3600e3);
const pingTimer = setInterval(() => { for (const c of clients) { try { c.write(": ping\n\n"); } catch { clients.delete(c); } } }, 15000);

server.listen(cfg.port, cfg.host, () => {
  console.log(`\n  Trace Console  http://127.0.0.1:${cfg.port}   mode=${cfg.mode}   db=${path.relative(process.cwd(), cfg.dbFile)}`);
  console.log(`  ingest: POST http://127.0.0.1:${cfg.port}/ingest${cfg.token ? "  (x-trace-token required)" : ""}\n`);
});
server.on("error", (e) => { console.error(e.code === "EADDRINUSE" ? `Port ${cfg.port} already in use (use --port).` : e); process.exit(1); });

function shutdown() { clearInterval(driftTimer); clearInterval(evalTimer); clearInterval(pruneTimer); clearInterval(pingTimer); server.close(); try { store.close(); } catch {} process.exit(0); }
process.on("SIGINT", shutdown); process.on("SIGTERM", shutdown);
