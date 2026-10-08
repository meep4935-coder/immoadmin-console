// Hidden-bug detectors. Pure functions over spans — no I/O, easy to test.
//
// A FINDING is something that is wrong or suspicious even though nothing crashed:
//   category        rules
//   silent-wrong    arithmetic (recorded math does not add up), invariant (app assertion failed),
//                   swallowed_error (a query/call failed but the request still answered OK)
//   integrity       duplicate_write, double_submit, multi_owner_access
//   performance     n_plus_one
//   confusion       rage_click, needed_second_click, repeated_failure, navigation_loop
//   drift           latency_drift, error_rate_drift, volume_drop, slow_creep, dead_click_drift  (baseline.mjs)

import crypto from "node:crypto";

// ── derived signals (computed at ingest from RAW attrs, so they survive prod-mode scrubbing) ──
const h10 = (s) => crypto.createHash("sha1").update(String(s)).digest("hex").slice(0, 10);
const stableJson = (v) => { try { return JSON.stringify(v, (_, x) => (x && typeof x === "object" && !Array.isArray(x) ? Object.fromEntries(Object.keys(x).sort().map((k) => [k, x[k]])) : x)); } catch { return String(v); } };
const WRITE = new Set(["insert", "upsert", "update", "delete", "rpc"]);

/** Pseudonymous fingerprints of a database span: which owners it touched, and what exactly it wrote. */
export function deriveSignals(attrs, name) {
  if (!attrs || typeof attrs !== "object") return {};
  const out = {};
  const ids = new Set();
  const grab = (v) => { if (typeof v === "string" && v) ids.add(h10(v.replace(/^eq./, ""))); };
  grab(attrs.filters?.owner_id);
  const inp = attrs.input;
  if (inp && typeof inp === "object") for (const r of Array.isArray(inp) ? inp : [inp]) if (r && typeof r === "object") grab(r.owner_id);
  if (ids.size) out._owners = [...ids];
  if (WRITE.has(attrs.op)) out._write_hash = h10(`${name}|${stableJson(attrs.filters)}|${stableJson(attrs.input)}`);
  return out;
}

// ── safe arithmetic evaluator (no eval) ──────────────────────────────────────
/** Evaluates + − × ÷ ( ) and round(x[, n]). Returns null if it cannot be parsed. */
export function evalExpr(src) {
  if (typeof src !== "string" || src.length > 200) return null;
  const s = src.replace(/×|·|∗/g, "*").replace(/÷/g, "/").replace(/−|–/g, "-").replace(/\s+/g, "");
  if (!/^[0-9a-z+\-*/().,]*$/.test(s)) return null;
  let i = 0;
  const peek = () => s[i];
  function number() {
    const m = /^\d+(\.\d+)?|^\.\d+/.exec(s.slice(i));
    if (!m) throw 0;
    i += m[0].length;
    return parseFloat(m[0]);
  }
  function factor() {
    if (peek() === "-") { i++; return -factor(); }
    if (peek() === "+") { i++; return factor(); }
    if (peek() === "(") { i++; const v = expr(); if (peek() !== ")") throw 0; i++; return v; }
    if (s.startsWith("round(", i)) {
      i += 6; const v = expr(); let d = 0;
      if (peek() === ",") { i++; d = expr(); }
      if (peek() !== ")") throw 0; i++;
      const k = 10 ** Math.round(d);
      return Math.round((v + Number.EPSILON * Math.sign(v)) * k) / k;
    }
    return number();
  }
  function term() {
    let v = factor();
    while (peek() === "*" || peek() === "/") {
      const op = s[i++]; const r = factor();
      if (op === "/" && r === 0) throw 0;
      v = op === "*" ? v * r : v / r;
    }
    return v;
  }
  function expr() {
    let v = term();
    while (peek() === "+" || peek() === "-") { const op = s[i++]; const r = term(); v = op === "+" ? v + r : v - r; }
    return v;
  }
  try { const v = expr(); return i === s.length && Number.isFinite(v) ? v : null; } catch { return null; }
}

const decimals = (n) => { const t = String(n); const k = t.indexOf("."); return k === -1 ? 0 : t.length - k - 1; };
function close(computed, recorded) {
  const tol = decimals(recorded) <= 2 ? 0.0051 : Math.max(1e-6, Math.abs(computed) * 1e-9);
  return Math.abs(computed - recorded) <= tol;
}

/** Re-computes every recorded calculation step. @returns [{rule, title, detail}] */
export function checkArithmetic(attrs) {
  const out = [];
  if (!attrs || typeof attrs !== "object") return out;
  const steps = Array.isArray(attrs.steps) ? attrs.steps : [];
  let last = null;
  steps.forEach((st, idx) => {
    if (!st || typeof st.result !== "number") return;
    last = st.result;
    const v = typeof st.expr === "string" ? evalExpr(st.expr) : null;
    if (v !== null && !close(v, st.result)) {
      out.push({ rule: "arithmetic", title: `Wrong arithmetic: ${st.expr}`, detail: `step ${idx + 1}${st.label ? ` (“${st.label}”)` : ""}: ${st.expr} = ${+v.toFixed(6)}, but the program recorded ${st.result}` });
    }
  });
  if (typeof attrs.expr === "string" && typeof attrs.output === "number") {
    const v = evalExpr(attrs.expr);
    if (v !== null && !close(v, attrs.output)) out.push({ rule: "arithmetic", title: `Wrong arithmetic: ${attrs.expr}`, detail: `${attrs.expr} = ${+v.toFixed(6)}, but the output was ${attrs.output}` });
  }
  if (last !== null && typeof attrs.output === "number" && !close(last, attrs.output)) {
    out.push({ rule: "arithmetic", title: "Output differs from the last computed step", detail: `last step gave ${last}, but the output was ${attrs.output}` });
  }
  return out;
}

// ── per-trace structural detectors ───────────────────────────────────────────
const WRITE_OPS = new Set(["insert", "upsert", "update", "delete", "rpc"]);
const ADMIN_ROUTE = /^\/api\/(admin|cron|webhooks?|inngest|stripe\/(payment-)?webhook|zum\/(webhook|ingress))/;

function owners(attrs) {
  const found = new Set();
  if (Array.isArray(attrs?._owners)) { for (const o of attrs._owners) found.add(o); return found; }
  const grab = (v) => { if (typeof v === "string") found.add(v.replace(/^eq\./, "")); };
  if (attrs?.filters && typeof attrs.filters === "object") grab(attrs.filters.owner_id);
  const inp = attrs?.input;
  if (inp && typeof inp === "object") for (const r of Array.isArray(inp) ? inp : [inp]) if (r && typeof r === "object") grab(r.owner_id);
  return found;
}

const stable = (v) => { try { return JSON.stringify(v, Object.keys(v ?? {}).sort()); } catch { return String(v); } };

/** @returns finding[] for one trace */
export function detectTrace(spans, opts = {}) {
  const o = { nPlusOne: 8, getDuplicates: 3, retryStorm: 3, ...opts };
  const byId = new Map(spans.map((s) => [s.id, s]));
  const reqOf = (s) => { for (let c = s, g = 0; c && g < 30; c = c.parent_id ? byId.get(c.parent_id) : null, g++) if (c.kind === "net.server") return c; return null; };
  const out = [];
  const f = (rule, category, severity, key, title, detail, span, data) =>
    out.push({ rule, category, severity, key, title, detail, trace_id: span.trace_id, span_id: span.id, user_id: span.user_id ?? null, session_id: span.session_id ?? null, ts: span.ts, data });

  // N+1: the same query many times inside ONE request.
  const perReq = new Map();
  for (const s of spans) if (s.kind === "db") {
    const r = reqOf(s); const k = `${r?.id ?? "-"}|${s.name}`;
    const e = perReq.get(k) || { req: r, list: [] }; e.list.push(s); perReq.set(k, e);
  }
  for (const { req, list } of perReq.values()) {
    if (list.length >= o.nPlusOne) {
      const total = list.reduce((a, s) => a + (s.dur || 0), 0);
      f("n_plus_one", "performance", "warning", `${list[0].name} @ ${req?.route ?? "?"}`, `N+1 queries: ${list[0].name} ×${list.length}`,
        `The same query ran ${list.length} times within one request (${Math.round(total)} ms in total). Batch it into one query.`, list[0], { count: list.length, total_ms: Math.round(total), route: req?.route });
    }
  }

  // Duplicate writes / double submit.
  const seenWrite = new Map(); const seenReq = new Map();
  for (const s of spans) {
    if (s.kind === "db" && WRITE_OPS.has(s.attrs?.op)) {
      const k = s.attrs?._write_hash ?? `${s.name}|${stable(s.attrs?.filters)}|${stable(s.attrs?.input)}`;
      const prev = seenWrite.get(k);
      if (prev && prev.status !== "error") f("duplicate_write", "integrity", "warning", `${s.name} @ ${reqOf(s)?.route ?? "?"}`, `Identical write twice: ${s.name}`,
        `The same ${s.attrs.op} with identical input ran twice in one trace (${Math.round(s.ts - prev.ts)} ms apart). If it is not idempotent, the data is duplicated or double-counted.`, s, { first: prev.id, second: s.id });
      else seenWrite.set(k, s);
    }
    if (s.kind === "net.client" && s.attrs?.method) {
      const k = `${s.name}|${s.attrs.request_bytes ?? ""}`;
      const list = seenReq.get(k) || []; list.push(s); seenReq.set(k, list);
    }
  }
  for (const list of seenReq.values()) {
    const m = list[0].attrs.method;
    const mutating = m !== "GET" && m !== "HEAD";
    const close2 = list.filter((s, i) => i === 0 || s.ts - list[i - 1].ts <= 2000);
    if (mutating && close2.length >= 2) f("double_submit", "integrity", "warning", list[0].name, `Request sent twice: ${list[0].name}`,
      `${close2.length} identical ${m} requests within ${Math.round(close2[close2.length - 1].ts - close2[0].ts)} ms — a double click or a retry that could create duplicates.`, list[0], { count: close2.length });
    else if (!mutating && close2.length >= o.getDuplicates) f("duplicate_request", "performance", "info", list[0].name, `Same request ${close2.length}× : ${list[0].name}`,
      `Identical ${m} request repeated ${close2.length} times in one trace — likely a missing cache or an effect that re-runs.`, list[0], { count: close2.length });
  }

  // One request touching several owners' data (isolation).
  const ownersByReq = new Map();
  for (const s of spans) if (s.kind === "db") {
    const r = reqOf(s); if (!r || ADMIN_ROUTE.test(r.route ?? "")) continue;
    const set = ownersByReq.get(r.id) || { req: r, ids: new Set() };
    for (const id of owners(s.attrs)) set.ids.add(id);
    ownersByReq.set(r.id, set);
  }
  for (const { req, ids } of ownersByReq.values()) {
    if (ids.size > 1) f("multi_owner_access", "integrity", "critical", req.route ?? "?", `One request touched ${ids.size} different owners' data`,
      `${req.name} read or wrote rows for ${ids.size} distinct owner_id values. Outside admin/cron routes this may be a tenant-isolation breach.`, req, { owners: ids.size });
  }

  // Retry storm.
  const errByName = new Map();
  for (const s of spans) if (s.status === "error" && (s.kind === "db" || s.kind === "external" || s.kind === "net.client")) {
    const l = errByName.get(s.name) || []; l.push(s); errByName.set(s.name, l);
  }
  for (const [name, l] of errByName) if (l.length >= o.retryStorm) f("retry_storm", "performance", "warning", name, `Repeated failures: ${name} ×${l.length}`,
    `The same call failed ${l.length} times in one trace — retries that keep failing add load and delay.`, l[0], { count: l.length });

  // Swallowed errors: a call failed deeper down, yet the request answered normally.
  for (const s of spans) if ((s.kind === "db" || s.kind === "external") && s.status === "error") {
    const r = reqOf(s);
    if (r && r.status !== "error" && (r.attrs?.status ?? 200) < 400) f("swallowed_error", "silent-wrong", "warning", `${s.name} @ ${r.route}`, `Failure swallowed: ${s.name}`,
      `${s.name} failed (${s.error?.message ?? "error"}) but ${r.name} still answered ${r.attrs?.status ?? "OK"}. The user is not told, and the data may be missing or stale.`, s, { request: r.id });
  }
  return out;
}

// ── what the user was TOLD versus what actually happened ─────────────────────
const isMessage = (s) => s.kind === "render" && /^Message affiché/.test(s.name);
const failedCall = (s) => (s.kind === "net.client" || s.kind === "db" || s.kind === "net.server") && s.status === "error";

/**
 * Compares the messages the user saw (toasts, banners) with the failures in the same trace.
 * Needs the browser recorder's message capture: only judged when the click says `feedback_tracked`.
 * Run on traces old enough that late-arriving message spans have landed (see pipeline.analyzeFeedback).
 */
export function detectFeedback(spans) {
  const out = [];
  const root = spans.filter((s) => !s.parent_id || !spans.some((p) => p.id === s.parent_id)).sort((a, b) => a.ts - b.ts)[0];
  if (!root) return out;
  const msgs = spans.filter(isMessage);
  const failed = spans.filter(failedCall).sort((a, b) => a.ts - b.ts);
  const f = (rule, severity, key, title, detail, span, data) =>
    out.push({ rule, category: "silent-wrong", severity, key, title, detail, trace_id: span.trace_id, span_id: span.id, user_id: span.user_id ?? null, session_id: span.session_id ?? null, ts: span.ts, data });

  if (root.kind === "ui.click" && root.attrs?.feedback_tracked === true && root.status === "error" && failed.length && !msgs.length) {
    f("no_feedback", "warning", root.name, `Failed with no message: ${root.name}`,
      `The action failed (${failed[0].name}: ${failed[0].error?.message ?? "error"}) but the user was shown no toast or error banner — they cannot tell it did not work.`, root, { failed: failed[0].name });
  }
  const success = msgs.find((m) => m.attrs?.type === "success");
  if (success && failed.length) {
    f("false_success", "critical", `${root.name}`, `Told it worked, but it failed: ${root.name}`,
      `The user saw “${String(success.attrs.text).slice(0, 80)}” while ${failed[0].name} failed (${failed[0].error?.message ?? "error"}). Check whether the failure was retried; if not, the screen is lying.`, success, { message: success.attrs.text, failed: failed[0].name });
  }
  return out;
}

// ── per-session behaviour detectors (confusion) ──────────────────────────────
const label = (s) => s.attrs?.target?.component ? `${s.attrs.target.component}: ${s.attrs.target.text ?? s.name}` : s.name;

/** @param events ui.click / ui.nav spans of ONE session, any order. */
export function detectSession(events) {
  const ev = [...events].sort((a, b) => a.ts - b.ts);
  const out = [];
  const f = (rule, severity, key, title, detail, s, data) =>
    out.push({ rule, category: "confusion", severity, key, title, detail, trace_id: s.trace_id, span_id: s.id, user_id: s.user_id ?? null, session_id: s.session_id ?? null, ts: s.ts, data });
  const clicks = ev.filter((s) => s.kind === "ui.click");

  for (let i = 0; i + 2 < clicks.length; i++) {
    const a = clicks[i], b = clicks[i + 1], c = clicks[i + 2];
    if (label(a) === label(b) && label(b) === label(c) && c.ts - a.ts <= 1500)
      f("rage_click", "warning", label(a), `Rage click: ${label(a)}`, `3 clicks on the same control within ${Math.round(c.ts - a.ts)} ms — the user thinks it is not responding.`, c, { clicks: 3 });
  }
  for (let i = 0; i + 1 < clicks.length; i++) {
    const a = clicks[i], b = clicks[i + 1];
    if (a.status === "dead" && label(a) === label(b) && b.ts - a.ts <= 4000)
      f("needed_second_click", "warning", label(a), `Needed a second click: ${label(a)}`, `The first click did nothing, the user clicked again ${Math.round(b.ts - a.ts)} ms later.`, b, { gap_ms: Math.round(b.ts - a.ts) });
  }
  const failsBy = new Map();
  for (const c of clicks) if (c.status === "error") { const l = failsBy.get(c.name) || []; l.push(c); failsBy.set(c.name, l); }
  for (const [name, l] of failsBy) {
    for (let i = 0; i + 2 < l.length; i++) if (l[i + 2].ts - l[i].ts <= 5 * 60e3) {
      f("repeated_failure", "warning", name, `Same action failed 3 times: ${name}`, `The user retried "${name}" and it failed each time within ${Math.round((l[i + 2].ts - l[i].ts) / 1000)} s.`, l[i + 2], { failures: 3 }); break;
    }
  }
  const navs = ev.filter((s) => s.kind === "ui.nav" && /^Navigation/.test(s.name)).map((s) => ({ s, to: s.attrs?.to }));
  for (let i = 0; i + 3 < navs.length; i++) {
    const [a, b, c, d] = [navs[i], navs[i + 1], navs[i + 2], navs[i + 3]];
    if (a.to && a.to === c.to && b.to === d.to && a.to !== b.to && d.s.ts - a.s.ts <= 15000)
      f("navigation_loop", "info", `${a.to} ↔ ${b.to}`, `Navigation loop: ${a.to} ↔ ${b.to}`, `The user bounced between the same two pages ${2} times in ${Math.round((d.s.ts - a.s.ts) / 1000)} s — they may be lost or the page is not giving what they need.`, d.s, { pages: [a.to, b.to] });
  }
  return out;
}
