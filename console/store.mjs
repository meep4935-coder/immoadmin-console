// SQLite store (node:sqlite, built into Node >= 22.5 — no npm dependency).
//
// This file is the ONLY place that knows about SQL. server.mjs and alerts.mjs use
// the methods below, so a different backend (e.g. a hosted store that the console
// pulls production data from) can be added later by implementing the same methods.
import fs from "node:fs";
import path from "node:path";

const ew = process.emitWarning;
process.emitWarning = (w, ...a) => (String(w).includes("SQLite") ? undefined : ew.call(process, w, ...a));
const { DatabaseSync } = await import("node:sqlite");
process.emitWarning = ew;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS spans (
  id TEXT PRIMARY KEY,
  trace_id TEXT NOT NULL,
  parent_id TEXT,
  ts REAL NOT NULL,
  dur REAL,
  kind TEXT NOT NULL,
  name TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'ok',
  source TEXT, user_id TEXT, session_id TEXT, role TEXT, route TEXT,
  attrs TEXT, error TEXT, fingerprint TEXT, app_version TEXT, env TEXT
);
CREATE INDEX IF NOT EXISTS ix_spans_trace ON spans(trace_id);
DROP INDEX IF EXISTS ix_spans_parent;
CREATE INDEX IF NOT EXISTS ix_spans_parent_status ON spans(parent_id, status);
CREATE INDEX IF NOT EXISTS ix_spans_ts ON spans(ts);
CREATE INDEX IF NOT EXISTS ix_spans_user ON spans(user_id, ts);
CREATE INDEX IF NOT EXISTS ix_spans_status ON spans(status, ts);
CREATE INDEX IF NOT EXISTS ix_spans_fp ON spans(fingerprint, ts);
CREATE INDEX IF NOT EXISTS ix_spans_kind ON spans(kind, ts);

CREATE TABLE IF NOT EXISTS traces (
  trace_id TEXT PRIMARY KEY,
  ts REAL NOT NULL, dur REAL, user_id TEXT, session_id TEXT, role TEXT,
  root_name TEXT, root_kind TEXT, route TEXT, status TEXT NOT NULL,
  spans INTEGER NOT NULL, errors INTEGER NOT NULL, dead INTEGER NOT NULL, slow INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_traces_ts ON traces(ts);
CREATE INDEX IF NOT EXISTS ix_traces_status ON traces(status, ts);
CREATE INDEX IF NOT EXISTS ix_traces_user ON traces(user_id, ts);

CREATE TABLE IF NOT EXISTS alerts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  key TEXT NOT NULL, severity TEXT NOT NULL, title TEXT NOT NULL, detail TEXT,
  opened_ts REAL NOT NULL, last_ts REAL NOT NULL, resolved_ts REAL,
  count INTEGER NOT NULL DEFAULT 1, state TEXT NOT NULL DEFAULT 'open',
  ack INTEGER NOT NULL DEFAULT 0, data TEXT
);
CREATE INDEX IF NOT EXISTS ix_alerts_state ON alerts(state, last_ts);
CREATE INDEX IF NOT EXISTS ix_alerts_key ON alerts(key, state);

-- Findings: hidden-bug detections (detectors.mjs / baseline.mjs). One row per occurrence,
-- de-duplicated by 'dedupe'; the UI groups them by (rule, key).
CREATE TABLE IF NOT EXISTS findings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts REAL NOT NULL, rule TEXT NOT NULL, category TEXT NOT NULL, severity TEXT NOT NULL,
  key TEXT NOT NULL, title TEXT NOT NULL, detail TEXT,
  trace_id TEXT, span_id TEXT, user_id TEXT, session_id TEXT, data TEXT,
  dedupe TEXT NOT NULL UNIQUE
);
CREATE INDEX IF NOT EXISTS ix_findings_ts ON findings(ts);
CREATE INDEX IF NOT EXISTS ix_findings_group ON findings(rule, key, ts);

-- Heartbeats from the recorders themselves (kept apart from spans so they never show up as user activity).
CREATE TABLE IF NOT EXISTS recorder_health (
  id INTEGER PRIMARY KEY AUTOINCREMENT, ts REAL NOT NULL, source TEXT, session_id TEXT, user_id TEXT,
  dropped INTEGER, sent INTEGER, queued INTEGER, skew_ms REAL, app_version TEXT
);
CREATE INDEX IF NOT EXISTS ix_rh_ts ON recorder_health(ts);

-- Triage: what a human decided about an error group (ref = fingerprint) or a finding (ref = 'rule|key').
-- Absence of a row = 'new'. 'fixed' reopens automatically if the problem occurs again after updated_ts.
CREATE TABLE IF NOT EXISTS triage (
  kind TEXT NOT NULL, ref TEXT NOT NULL, status TEXT NOT NULL, note TEXT, updated_ts REAL NOT NULL,
  PRIMARY KEY (kind, ref)
);
`;

const SPAN_COLS = [
  "id", "trace_id", "parent_id", "ts", "dur", "kind", "name", "status", "source", "user_id",
  "session_id", "role", "route", "attrs", "error", "fingerprint", "app_version", "env",
];

const parseJson = (s) => { if (!s) return null; try { return JSON.parse(s); } catch { return null; } };
export function percentile(sorted, p) {
  if (!sorted.length) return null;
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))];
}

export function openStore(file) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL; PRAGMA busy_timeout=5000;");
  db.exec(SCHEMA);

  const insertSpan = db.prepare(
    `INSERT OR REPLACE INTO spans (${SPAN_COLS.join(",")}) VALUES (${SPAN_COLS.map(() => "?").join(",")})`,
  );
  const traceAgg = db.prepare(
    `SELECT MIN(ts) ts, MAX(ts + COALESCE(dur,0)) end_ts, COUNT(*) spans,
            SUM(status='error') errors, SUM(status='dead') dead, SUM(status='slow') slow,
            MAX(user_id) user_id, MAX(session_id) session_id, MAX(role) role
       FROM spans WHERE trace_id=?`,
  );
  const traceRoot = db.prepare(
    `SELECT name, kind, route FROM spans WHERE trace_id=?
      ORDER BY (parent_id IS NULL) DESC, ts ASC LIMIT 1`,
  );
  const traceRoute = db.prepare(
    `SELECT route FROM spans WHERE trace_id=? AND route IS NOT NULL ORDER BY ts ASC LIMIT 1`,
  );
  const upsertTrace = db.prepare(
    `INSERT OR REPLACE INTO traces (trace_id, ts, dur, user_id, session_id, role, root_name, root_kind,
       route, status, spans, errors, dead, slow) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  );

  const all = (sql, ...p) => db.prepare(sql).all(...p);
  const get = (sql, ...p) => db.prepare(sql).get(...p);
  const tx = (fn) => {
    db.exec("BEGIN");
    try { const r = fn(); db.exec("COMMIT"); return r; } catch (e) { db.exec("ROLLBACK"); throw e; }
  };

  function refreshTraces(ids) {
    for (const id of ids) {
      const a = traceAgg.get(id);
      if (!a || !a.spans) continue;
      const root = traceRoot.get(id) || {};
      const route = root.route || traceRoute.get(id)?.route || null;
      const status = a.errors > 0 ? "error" : a.dead > 0 ? "dead" : a.slow > 0 ? "slow" : "ok";
      upsertTrace.run(
        id, a.ts, a.end_ts - a.ts, a.user_id, a.session_id, a.role, root.name ?? null, root.kind ?? null,
        route, status, a.spans, a.errors, a.dead, a.slow,
      );
    }
  }

  return {
    kind: "sqlite",
    file,

    insertSpans(rows) {
      const traceIds = new Set();
      tx(() => {
        for (const r of rows) {
          insertSpan.run(...SPAN_COLS.map((c) => r[c] ?? null));
          traceIds.add(r.trace_id);
        }
        refreshTraces(traceIds);
      });
      return [...traceIds];
    },

    getTrace(id) {
      const spans = all(`SELECT * FROM spans WHERE trace_id=? ORDER BY ts ASC, id ASC`, id).map((s) => ({
        ...s, attrs: parseJson(s.attrs), error: parseJson(s.error),
      }));
      return { trace: get(`SELECT * FROM traces WHERE trace_id=?`, id) || null, spans };
    },

    listTraces({ q, status, user, route, since = 0, limit = 100, offset = 0 }) {
      const where = ["ts >= ?"]; const p = [since];
      if (status) { where.push("status = ?"); p.push(status); }
      if (user) { where.push("user_id = ?"); p.push(user); }
      if (route) { where.push("route LIKE ?"); p.push(`%${route}%`); }
      if (q) { where.push("(root_name LIKE ? OR route LIKE ? OR trace_id LIKE ?)"); p.push(`%${q}%`, `%${q}%`, `${q}%`); }
      const w = where.join(" AND ");
      const rows = all(`SELECT * FROM traces WHERE ${w} ORDER BY ts DESC LIMIT ? OFFSET ?`, ...p, limit, offset);
      const total = get(`SELECT COUNT(*) n FROM traces WHERE ${w}`, ...p).n;
      return { rows, total };
    },

    listUsers({ since, limit = 200 }) {
      return all(
        `SELECT s.user_id, MAX(s.role) role, COUNT(*) spans, COUNT(DISTINCT s.trace_id) traces,
                COUNT(DISTINCT s.session_id) sessions, COUNT(DISTINCT CASE WHEN s.status='error' THEN s.trace_id END) errors,
                COUNT(DISTINCT CASE WHEN s.status='dead' THEN s.trace_id END) dead,
                COUNT(DISTINCT CASE WHEN s.status='slow' THEN s.trace_id END) slow,
                MIN(s.ts) first_seen, MAX(s.ts) last_seen,
                (SELECT route FROM spans x WHERE x.user_id=s.user_id AND x.route IS NOT NULL
                  ORDER BY x.ts DESC LIMIT 1) last_route
           FROM spans s WHERE s.ts >= ? AND s.user_id IS NOT NULL AND s.user_id != ''
          GROUP BY s.user_id
          ORDER BY (errors*10 + dead*5 + slow) DESC, last_seen DESC
          LIMIT ?`,
        since, limit,
      );
    },

    userDetail(id, since) {
      const summary = get(
        `SELECT user_id, MAX(role) role, COUNT(*) spans, COUNT(DISTINCT trace_id) traces,
                COUNT(DISTINCT session_id) sessions,
                COUNT(DISTINCT CASE WHEN status='error' THEN trace_id END) errors,
                COUNT(DISTINCT CASE WHEN status='dead' THEN trace_id END) dead,
                COUNT(DISTINCT CASE WHEN status='slow' THEN trace_id END) slow,
                MIN(ts) first_seen, MAX(ts) last_seen
           FROM spans WHERE user_id=? AND ts >= ?`,
        id, since,
      );
      const traces = all(`SELECT * FROM traces WHERE user_id=? AND ts >= ? ORDER BY ts DESC LIMIT 100`, id, since);
      const errors = this.listErrors({ since, user: id, limit: 50 });
      return { summary, traces, errors };
    },

    listErrors({ since, user, limit = 100 }) {
      const u = user ? "AND user_id = ?" : "";
      const p = user ? [since, user] : [since];
      // One pass over the root-cause spans (an error span with no failing child — its parents are
      // just symptoms), then the most recent sample per group via a window function.
      return all(
        `WITH roots AS (
           SELECT s.id, s.trace_id, s.ts, s.user_id, s.fingerprint, s.name, s.kind, s.route, s.error
             FROM spans s
            WHERE s.fingerprint IS NOT NULL AND s.ts >= ? ${u}
              AND NOT EXISTS (SELECT 1 FROM spans c WHERE c.parent_id = s.id AND c.status = 'error')
         ), agg AS (
           SELECT fingerprint, COUNT(*) n, COUNT(DISTINCT user_id) users, MIN(ts) first_seen, MAX(ts) last_seen
             FROM roots GROUP BY fingerprint
         ), latest AS (
           SELECT fingerprint, name, kind, route, error, trace_id,
                  ROW_NUMBER() OVER (PARTITION BY fingerprint ORDER BY ts DESC) rn
             FROM roots
         )
         SELECT a.*, l.name, l.kind, l.route, l.error, l.trace_id
           FROM agg a JOIN latest l ON l.fingerprint = a.fingerprint AND l.rn = 1
          ORDER BY a.last_seen DESC LIMIT ?`,
        ...p, limit,
      ).map((r) => ({ ...r, error: parseJson(r.error) }));
    },

    /** Stats + latest sample of one error group (root-cause spans only, like listErrors). */
    errorGroup(fp) {
      const a = get(
        `SELECT COUNT(*) n, COUNT(DISTINCT user_id) users, MIN(ts) first_seen, MAX(ts) last_seen FROM spans s
          WHERE s.fingerprint = ? AND NOT EXISTS (SELECT 1 FROM spans c WHERE c.parent_id = s.id AND c.status = 'error')`, fp);
      if (!a || !a.n) return null;
      const l = get(`SELECT name, kind, route, error FROM spans WHERE fingerprint = ? ORDER BY ts DESC LIMIT 1`, fp);
      return { ...a, name: l.name, kind: l.kind, route: l.route, error: parseJson(l.error) };
    },
    errorOccurrences(fp, limit = 30) {
      return all(
        `SELECT trace_id, id, ts, user_id, route, name FROM spans WHERE fingerprint=? ORDER BY ts DESC LIMIT ?`, fp, limit,
      );
    },

    overview(now) {
      const h1 = now - 3600e3, m15 = now - 900e3;
      const active = get(`SELECT COUNT(DISTINCT user_id) n FROM spans WHERE ts >= ? AND user_id IS NOT NULL AND user_id!=''`, m15).n;
      const req = get(`SELECT COUNT(*) n, SUM(status='error') e FROM spans WHERE kind='net.server' AND ts >= ?`, h1);
      const durs = all(`SELECT dur FROM spans WHERE kind='net.server' AND ts >= ? AND dur IS NOT NULL ORDER BY dur`, h1).map((r) => r.dur);
      const users = this.listUsers({ since: m15 });
      const last = get(`SELECT MAX(ts) t FROM spans`).t;
      return {
        activeUsers15m: active,
        requests1h: req.n || 0,
        errorRate1h: req.n ? (req.e || 0) / req.n : 0,
        p95_1h: percentile(durs, 95),
        p50_1h: percentile(durs, 50),
        lastEventTs: last,
        usersByHealth: users, // health computed by caller (health.mjs)
      };
    },

    stats({ since, bucketMs }) {
      const buckets = all(
        `SELECT CAST(ts / ? AS INTEGER) * ? b,
                SUM(kind='net.server') requests,
                SUM(kind='net.server' AND status='error') server_errors,
                COUNT(DISTINCT CASE WHEN status='error' THEN trace_id END) errors,
                COUNT(DISTINCT user_id) users
           FROM spans WHERE ts >= ? GROUP BY b ORDER BY b`,
        bucketMs, bucketMs, since,
      );
      const routeRows = all(
        `SELECT route, dur, status FROM spans WHERE kind='net.server' AND ts >= ? AND route IS NOT NULL AND dur IS NOT NULL LIMIT 100000`,
        since,
      );
      const byRoute = new Map();
      for (const r of routeRows) {
        const e = byRoute.get(r.route) || { route: r.route, durs: [], errors: 0 };
        e.durs.push(r.dur); if (r.status === "error") e.errors++;
        byRoute.set(r.route, e);
      }
      const routes = [...byRoute.values()].map((e) => {
        e.durs.sort((a, b) => a - b);
        return { route: e.route, n: e.durs.length, errors: e.errors, p50: percentile(e.durs, 50), p95: percentile(e.durs, 95) };
      }).sort((a, b) => b.p95 - a.p95).slice(0, 15);
      return { buckets, routes };
    },

    // ── alerts ──
    listAlerts({ state, limit = 100 }) {
      const rows = state
        ? all(`SELECT * FROM alerts WHERE state=? ORDER BY last_ts DESC LIMIT ?`, state, limit)
        : all(`SELECT * FROM alerts ORDER BY (state='open') DESC, last_ts DESC LIMIT ?`, limit);
      return rows.map((r) => ({ ...r, data: parseJson(r.data) }));
    },
    openAlertByKey(key) { return get(`SELECT * FROM alerts WHERE key=? AND state='open'`, key) || null; },
    openAlert(a, now) {
      const r = db.prepare(
        `INSERT INTO alerts (key, severity, title, detail, opened_ts, last_ts, data) VALUES (?,?,?,?,?,?,?)`,
      ).run(a.key, a.severity, a.title, a.detail ?? null, now, now, a.data ? JSON.stringify(a.data) : null);
      return Number(r.lastInsertRowid);
    },
    touchAlert(id, a, now) {
      db.prepare(`UPDATE alerts SET last_ts=?, count=count+1, severity=?, title=?, detail=?, data=? WHERE id=?`)
        .run(now, a.severity, a.title, a.detail ?? null, a.data ? JSON.stringify(a.data) : null, id);
    },
    resolveAlert(id, now) { db.prepare(`UPDATE alerts SET state='resolved', resolved_ts=? WHERE id=?`).run(now, id); },
    ackAlert(id) { db.prepare(`UPDATE alerts SET ack=1 WHERE id=?`).run(id); },
    openAlertKeys() { return all(`SELECT id, key FROM alerts WHERE state='open'`); },

    // ── findings ──
    /** @returns true if inserted (false = duplicate of one already stored). */
    addFinding(f) {
      // One finding per trace; behaviour findings (confusion) once per session per 30 s; drift findings carry their own key.
      const dedupe = f.dedupe
        ?? (f.category === "confusion" ? `${f.rule}|${f.key}|${f.session_id}|${Math.floor(f.ts / 30000)}`
          : `${f.rule}|${f.key}|${f.trace_id}`);
      const r = db.prepare(
        `INSERT OR IGNORE INTO findings (ts, rule, category, severity, key, title, detail, trace_id, span_id, user_id, session_id, data, dedupe)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      ).run(f.ts, f.rule, f.category, f.severity, f.key, f.title, f.detail ?? null, f.trace_id ?? null, f.span_id ?? null,
        f.user_id ?? null, f.session_id ?? null, f.data ? JSON.stringify(f.data) : null, dedupe);
      return Number(r.changes) > 0;
    },
    listFindings({ since, category, limit = 200 }) {
      const c = category ? "AND category = ?" : "";
      const p = category ? [since, category] : [since];
      return all(
        `WITH f AS (SELECT * FROM findings WHERE ts >= ? ${c}),
              agg AS (SELECT rule, key, category, COUNT(*) n, COUNT(DISTINCT user_id) users, MIN(ts) first_seen, MAX(ts) last_seen,
                             MAX(CASE severity WHEN 'critical' THEN 3 WHEN 'warning' THEN 2 ELSE 1 END) sev
                        FROM f GROUP BY rule, key),
              latest AS (SELECT rule, key, title, detail, trace_id, span_id, data,
                                ROW_NUMBER() OVER (PARTITION BY rule, key ORDER BY ts DESC) rn FROM f)
         SELECT a.rule, a.key, a.category, a.n, a.users, a.first_seen, a.last_seen,
                CASE a.sev WHEN 3 THEN 'critical' WHEN 2 THEN 'warning' ELSE 'info' END severity,
                l.title, l.detail, l.trace_id, l.span_id, l.data
           FROM agg a JOIN latest l ON l.rule = a.rule AND l.key = a.key AND l.rn = 1
          ORDER BY a.sev DESC, a.last_seen DESC LIMIT ?`,
        ...p, limit,
      ).map((r) => ({ ...r, data: parseJson(r.data) }));
    },
    findingOccurrences(rule, key, limit = 30) {
      return all(`SELECT id, ts, trace_id, span_id, user_id, session_id, title, detail FROM findings WHERE rule=? AND key=? ORDER BY ts DESC LIMIT ?`, rule, key, limit);
    },
    findingCounts(since) {
      return all(`SELECT category, COUNT(*) n, COUNT(DISTINCT rule || '|' || key) kinds FROM findings WHERE ts >= ? GROUP BY category`, since);
    },

    // ── samples for baselines / sessions ──
    routeSamples({ from, to }) {
      return all(`SELECT route, dur, status, ts, app_version FROM spans WHERE kind='net.server' AND route IS NOT NULL AND ts >= ? AND ts < ? LIMIT 300000`, from, to);
    },
    clickSamples({ from, to }) {
      return all(`SELECT name, dur, status, ts FROM spans WHERE kind='ui.click' AND ts >= ? AND ts < ? LIMIT 300000`, from, to);
    },
    /** ui.click / ui.nav spans of one session since `since` (parsed attrs). */
    sessionEvents(sessionId, since, until = Infinity, limit = 200) {
      return all(
        `SELECT * FROM spans WHERE session_id=? AND kind IN ('ui.click','ui.nav') AND ts >= ? AND ts <= ? ORDER BY ts DESC LIMIT ?`,
        sessionId, since, Number.isFinite(until) ? until : 9e15, limit,
      ).reverse().map((s) => ({ ...s, attrs: parseJson(s.attrs), error: parseJson(s.error) }));
    },
    getSpan(id) {
      const s = get(`SELECT * FROM spans WHERE id=?`, id);
      return s ? { ...s, attrs: parseJson(s.attrs), error: parseJson(s.error) } : null;
    },
    firstSeenErrors(since) {
      return all(`SELECT fingerprint, MIN(ts) first_seen FROM spans WHERE fingerprint IS NOT NULL GROUP BY fingerprint HAVING MIN(ts) >= ?`, since);
    },

    // ── outside services ──
    /** Outbound calls (external + database) that carry a host, for dependencies.mjs. */
    dependencySamples({ from, to }) {
      return all(
        `SELECT json_extract(attrs, '$.host') host, dur, status, ts, json_extract(error, '$.message') msg
           FROM spans WHERE kind IN ('external', 'db') AND ts >= ? AND ts < ? AND json_extract(attrs, '$.host') IS NOT NULL LIMIT 300000`, from, to);
    },

    // ── feedback ──
    /** Trace ids of failing clicks whose recorder tracked on-screen messages, within [from, to]. */
    trackedFailedActions(from, to) {
      return all(`SELECT DISTINCT trace_id FROM spans WHERE kind='ui.click' AND status='error' AND ts >= ? AND ts <= ? AND attrs LIKE '%"feedback_tracked":true%'`, from, to).map((r) => r.trace_id);
    },

    // ── absence detection ──
    /** Last time each /api/cron/* route was seen (one scan for all crons). */
    cronLastSeen(since) {
      return all(`SELECT route, MAX(ts) last FROM spans WHERE kind='net.server' AND route LIKE '/api/cron/%' AND ts >= ? GROUP BY route`, since);
    },
    /** Last span matching {kind?, route?, name? (substring)} since `since`. */
    lastSeenMatching(match, since) {
      const w = ["ts >= ?"], p = [since];
      if (match.kind) { w.push("kind = ?"); p.push(match.kind); }
      if (match.route) { w.push("route = ?"); p.push(match.route); }
      if (match.name) { w.push("name LIKE ?"); p.push(`%${match.name}%`); }
      return { last: get(`SELECT MAX(ts) t FROM spans WHERE ${w.join(" AND ")}`, ...p).t ?? null };
    },

    // ── recorder health ──
    recordHealth(rows) {
      const ins = db.prepare(`INSERT INTO recorder_health (ts, source, session_id, user_id, dropped, sent, queued, skew_ms, app_version) VALUES (?,?,?,?,?,?,?,?,?)`);
      for (const r of rows) {
        const a = typeof r.attrs === "string" ? parseJson(r.attrs) || {} : r.attrs || {};
        ins.run(r.ts, r.source ?? null, r.session_id ?? null, r.user_id ?? null, a.dropped ?? 0, a.sent ?? 0, a.queued ?? 0, a.skew_ms ?? null, r.app_version ?? null);
      }
    },
    /** Latest heartbeat of every recorder (browser tab / server) seen since `since`. */
    latestHealth(since) {
      return all(
        `SELECT * FROM recorder_health h WHERE ts >= ?
            AND id = (SELECT MAX(id) FROM recorder_health x WHERE x.source IS h.source AND x.session_id IS h.session_id)
          ORDER BY ts DESC LIMIT 200`, since);
    },

    // ── releases ──
    /** Builds seen, oldest first: when each first/last appeared and how much traffic it carried. */
    releases() {
      return all(
        `SELECT app_version version, MIN(ts) first_seen, MAX(ts) last_seen, COUNT(*) spans, COUNT(DISTINCT user_id) users
           FROM spans WHERE app_version IS NOT NULL AND app_version != '' GROUP BY app_version ORDER BY first_seen`);
    },
    /** App version in which each error fingerprint was FIRST recorded (all-time, not just the viewed range). */
    introducedIn(fingerprints) {
      const m = new Map();
      if (!fingerprints.length) return m;
      const ph = fingerprints.map(() => "?").join(",");
      for (const r of all(
        `SELECT fingerprint, app_version FROM (SELECT fingerprint, app_version, ROW_NUMBER() OVER (PARTITION BY fingerprint ORDER BY ts ASC) rn
            FROM spans WHERE fingerprint IN (${ph})) WHERE rn = 1`, ...fingerprints)) m.set(r.fingerprint, r.app_version);
      return m;
    },

    // ── triage ──
    /** status: ack | fixed | ignored | new (new = forget the decision). */
    setTriage(kind, ref, status, note, now) {
      if (status === "new") { db.prepare(`DELETE FROM triage WHERE kind=? AND ref=?`).run(kind, ref); return; }
      db.prepare(`INSERT OR REPLACE INTO triage (kind, ref, status, note, updated_ts) VALUES (?,?,?,?,?)`).run(kind, ref, status, note ?? null, now);
    },
    triageMap(kind) {
      return new Map(all(`SELECT ref, status, note, updated_ts FROM triage WHERE kind=?`, kind).map((r) => [r.ref, r]));
    },
    /** Occurrences after `ts` (used to show how many times a "fixed" problem came back). */
    countSince(kind, ref, ts) {
      if (kind === "error") return get(`SELECT COUNT(*) n FROM spans WHERE fingerprint=? AND ts > ?`, ref, ts).n;
      const i = ref.indexOf("|");
      return get(`SELECT COUNT(*) n FROM findings WHERE rule=? AND key=? AND ts > ?`, ref.slice(0, i), ref.slice(i + 1), ts).n;
    },

    // raw helpers for alert rules
    all, get,

    prune(retentionDays, now) {
      const cutoff = now - retentionDays * 86400e3;
      const s = db.prepare(`DELETE FROM spans WHERE ts < ?`).run(cutoff).changes;
      db.prepare(`DELETE FROM traces WHERE ts < ?`).run(cutoff);
      db.prepare(`DELETE FROM findings WHERE ts < ?`).run(cutoff);
      db.prepare(`DELETE FROM recorder_health WHERE ts < ?`).run(cutoff);
      db.prepare(`DELETE FROM alerts WHERE state='resolved' AND resolved_ts < ?`).run(cutoff);
      return Number(s);
    },

    counts() {
      return {
        spans: get(`SELECT COUNT(*) n FROM spans`).n, traces: get(`SELECT COUNT(*) n FROM traces`).n,
        findings: get(`SELECT COUNT(*) n FROM findings`).n,
      };
    },
    close() { db.close(); },
  };
}
