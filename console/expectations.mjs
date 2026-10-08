// Absence detection: alert when something that SHOULD have happened did not.
// Everything else in the console reacts to events that occurred; this is the "dead man's switch".
//
//  • crons   — read from vercel.json: for every schedule, when should it last have run, and did we see it?
//  • events  — "this should be seen at least every N minutes" (e.g. a payment-provider webhook)
//
// Only meaningful when the console is fed from the environment where those jobs actually run
// (production). In development nothing schedules them, so everything is OFF by default (expectations.json).
import fs from "node:fs";
import path from "node:path";
import { HERE } from "./config.mjs";

const MIN = 60e3, DAY = 86400e3;
const FILE = path.join(HERE, "expectations.json");

const DEFAULTS = {
  crons: { enabled: false, vercelJson: "../../vercel.json", graceMinutes: 3, onlyWhenSeen: true, ignore: [] },
  events: [],
};

export function loadExpectations(file = FILE) {
  let j = {};
  try { j = JSON.parse(fs.readFileSync(file, "utf8")); } catch { /* absent or invalid → defaults (off) */ }
  return { crons: { ...DEFAULTS.crons, ...(j.crons || {}) }, events: Array.isArray(j.events) ? j.events : [] };
}

// ── cron expressions (UTC, as Vercel runs them) ──────────────────────────────
function field(f, min, max) {
  const set = new Set();
  for (const part of String(f).split(",")) {
    const [range, stepStr] = part.split("/");
    const step = stepStr === undefined ? 1 : Number(stepStr);
    if (!Number.isInteger(step) || step < 1) return null;
    let a, b;
    if (range === "*") { a = min; b = max; }
    else if (range.includes("-")) [a, b] = range.split("-").map(Number);
    else { a = Number(range); b = stepStr === undefined ? a : max; }
    if (!Number.isInteger(a) || !Number.isInteger(b) || a < min || b > max || a > b) return null;
    for (let v = a; v <= b; v += step) set.add(v);
  }
  return set;
}

/** @returns parsed schedule, or null if the expression is not understood. */
export function parseCron(expr) {
  const p = String(expr).trim().split(/\s+/);
  if (p.length !== 5) return null;
  const [mi, ho, dom, mo, dow] = [field(p[0], 0, 59), field(p[1], 0, 23), field(p[2], 1, 31), field(p[3], 1, 12), field(p[4], 0, 7)];
  if (!mi || !ho || !dom || !mo || !dow) return null;
  if (dow.has(7)) { dow.delete(7); dow.add(0); }
  return { min: mi, hour: ho, dom, mon: mo, dow, domStar: p[2] === "*", dowStar: p[4] === "*" };
}

function dayMatches(c, d) {
  const dm = c.dom.has(d.getUTCDate()), dw = c.dow.has(d.getUTCDay());
  if (c.domStar && c.dowStar) return true;
  if (c.domStar) return dw;
  if (c.dowStar) return dm;
  return dm || dw; // standard cron: when both are restricted, either matches
}

/** Latest scheduled time at or before `beforeMs` (ms epoch), or null within 70 days. */
export function lastScheduled(c, beforeMs) {
  let t = Math.floor(beforeMs / MIN);
  for (let i = 0; i < 70 * 1440; i++, t--) {
    if (!c.min.has(t % 60)) continue;
    if (!c.hour.has(Math.floor(t / 60) % 24)) continue;
    const d = new Date(t * MIN);
    if (!c.mon.has(d.getUTCMonth() + 1)) continue;
    if (dayMatches(c, d)) return t * MIN;
  }
  return null;
}

// ── evaluation ───────────────────────────────────────────────────────────────
/**
 * @returns {{enabled: boolean, rows: Array<{kind, name, schedule?, expected_at?, last_seen, status, missed, severity?}>}}
 *   status: on_time | missed | never_seen
 */
export function evaluateExpectations(store, conf, now = Date.now(), vercelJson = null) {
  const rows = [];
  const grace = (conf.crons.graceMinutes ?? 3) * MIN;
  const horizon = now - 45 * DAY;

  if (conf.crons.enabled) {
    let crons = vercelJson;
    if (!crons) {
      try { crons = JSON.parse(fs.readFileSync(path.resolve(HERE, conf.crons.vercelJson), "utf8")).crons || []; } catch { crons = []; }
    }
    const seen = new Map(store.cronLastSeen(horizon).map((r) => [r.route, r.last]));
    for (const c of crons) {
      if ((conf.crons.ignore || []).some((x) => c.path.includes(x))) continue;
      const parsed = parseCron(c.schedule);
      if (!parsed) continue;
      const S = lastScheduled(parsed, now - grace);
      if (S === null) continue;
      const S2 = lastScheduled(parsed, S - MIN);
      const last = seen.get(c.path) ?? null;
      const row = { kind: "cron", name: c.path, schedule: c.schedule, expected_at: S, last_seen: last };
      if (last === null) Object.assign(row, { status: conf.crons.onlyWhenSeen === false ? "missed" : "never_seen", missed: conf.crons.onlyWhenSeen === false ? 1 : 0 });
      else {
        const missed = (last < S - 2 * MIN ? 1 : 0) + (S2 !== null && last < S2 - 2 * MIN ? 1 : 0);
        Object.assign(row, { status: missed ? "missed" : "on_time", missed });
      }
      if (row.status === "missed") row.severity = row.missed >= 2 ? "critical" : "warning";
      rows.push(row);
    }
  }

  for (const e of conf.events || []) {
    if (e.enabled === false || !e.name || !e.match || !(e.everyMinutes > 0)) continue;
    const r = store.lastSeenMatching(e.match, now - Math.max(14 * DAY, e.everyMinutes * MIN * 3));
    const row = { kind: "event", name: e.name, schedule: `every ${e.everyMinutes} min`, expected_at: now - e.everyMinutes * MIN, last_seen: r.last };
    if (r.last === null) Object.assign(row, { status: e.required ? "missed" : "never_seen", missed: e.required ? 1 : 0 });
    else {
      const late = now - r.last > e.everyMinutes * MIN * (1 + (e.tolerance ?? 0.25));
      Object.assign(row, { status: late ? "missed" : "on_time", missed: late ? Math.floor((now - r.last) / (e.everyMinutes * MIN)) : 0 });
    }
    if (row.status === "missed") row.severity = row.missed >= 2 ? "critical" : "warning";
    rows.push(row);
  }
  return { enabled: conf.crons.enabled || (conf.events || []).some((e) => e.enabled !== false), rows };
}
