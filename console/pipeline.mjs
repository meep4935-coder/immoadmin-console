// Runs the detectors on every ingested batch and stores the findings.
import { detectTrace, detectSession, detectFeedback } from "./detectors.mjs";

/**
 * Feedback checks run LATER than everything else: the message span can arrive in a batch after the failing
 * click, so judging at ingest would call "no message" too early. Looks at failing, message-tracked actions
 * that are between `minAgeMs` and `maxAgeMs` old.
 * @returns findings that were NEW
 */
export function analyzeFeedback(store, now = Date.now(), { minAgeMs = 6000, maxAgeMs = 15 * 60e3 } = {}) {
  const fresh = [];
  for (const tid of store.trackedFailedActions(now - maxAgeMs, now - minAgeMs)) {
    for (const f of detectFeedback(store.getTrace(tid).spans)) if (store.addFinding(f)) fresh.push(f);
  }
  return fresh;
}

/**
 * @param store
 * @param rows        normalized spans just inserted
 * @param violations  [{ row, violations: [{rule,title,detail}] }]  from ingest (checks on raw values)
 * @returns findings that were NEW (not duplicates of ones already stored)
 */
export function analyzeBatch(store, rows, violations, cfg) {
  const fresh = [];
  const add = (f) => { if (store.addFinding(f)) fresh.push(f); };

  // 1. Wrong arithmetic found at ingest, and assertions raised by the application itself.
  for (const { row, violations: vs } of violations) {
    for (const v of vs) {
      add({ rule: v.rule, category: "silent-wrong", severity: "warning", key: `${row.name}|${v.title.replace(/[0-9.]+/g, "#")}`,
        title: v.title, detail: `${v.detail} — in “${row.name}”.`, trace_id: row.trace_id, span_id: row.id,
        user_id: row.user_id, session_id: row.session_id, ts: row.ts, data: { span: row.name } });
    }
  }
  for (const r of rows) {
    if (r.kind === "invariant" && r.status === "error") {
      let e = null; try { e = r.error ? JSON.parse(r.error) : null; } catch { /* ignore */ }
      add({ rule: "invariant", category: "silent-wrong", severity: "critical", key: r.name,
        title: `Invariant broken: ${r.name}`, detail: e?.message || "an assertion written in the application failed",
        trace_id: r.trace_id, span_id: r.id, user_id: r.user_id, session_id: r.session_id, ts: r.ts });
    }
  }

  // 2. Structural problems inside each affected trace.
  for (const tid of new Set(rows.map((r) => r.trace_id))) {
    const { spans } = store.getTrace(tid);
    for (const f of detectTrace(spans, cfg.detect)) add(f);
  }

  // 3. Behaviour of each affected session (clicks / navigation).
  const sessions = new Map();
  for (const r of rows) if (r.session_id && (r.kind === "ui.click" || r.kind === "ui.nav")) sessions.set(r.session_id, Math.max(sessions.get(r.session_id) ?? 0, r.ts));
  for (const [sid, lastTs] of sessions) for (const f of detectSession(store.sessionEvents(sid, lastTs - 60e3, lastTs + 1))) add(f);

  return fresh;
}
