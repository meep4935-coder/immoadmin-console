#!/usr/bin/env node
/** Absence detection: cron arithmetic, "did it run?", severity, grace, off-by-default, events. */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { cfg } from "./config.mjs";
import { openStore } from "./store.mjs";
import { normalizeSpan } from "./ingest.mjs";
import { evaluate } from "./alerts.mjs";
import { parseCron, lastScheduled, evaluateExpectations, loadExpectations } from "./expectations.mjs";

let pass = 0, fail = 0;
const check = (name, ok, extra = "") => { ok ? pass++ : fail++; console.log(`${ok ? "  ✓" : "  ✗ FAIL"} ${name}${ok ? "" : "  " + extra}`); };
const eq = (name, a, b) => check(name, JSON.stringify(a) === JSON.stringify(b), `got ${JSON.stringify(a)} expected ${JSON.stringify(b)}`);
const U = (y, mo, d, h = 0, mi = 0) => Date.UTC(y, mo - 1, d, h, mi);
const iso = (ms) => (ms === null ? null : new Date(ms).toISOString().slice(0, 16));
const last = (expr, at) => iso(lastScheduled(parseCron(expr), at));
const MIN = 60e3;

console.log("\ncron arithmetic (UTC)");
const NOW = U(2026, 10, 8, 12, 7);                                  // Thursday 2026-10-08 12:07
eq("daily 08:00", last("0 8 * * *", NOW), "2026-10-08T08:00");
eq("daily 13:00 hasn't happened yet today → yesterday", last("0 13 * * *", NOW), "2026-10-07T13:00");
eq("every 15 minutes", last("*/15 * * * *", NOW), "2026-10-08T12:00");
eq("hourly at :45 → 11:45", last("45 * * * *", NOW), "2026-10-08T11:45");
eq("1st of the month at 03:00", last("0 3 1 * *", NOW), "2026-10-01T03:00");
eq("Mondays 08:00 (Oct 5 is a Monday)", last("0 8 * * 1", NOW), "2026-10-05T08:00");
eq("Sundays given as 0 or 7 agree", last("0 9 * * 0", NOW), last("0 9 * * 7", NOW));
eq("a time exactly on the schedule counts", last("0 12 * * *", U(2026, 10, 8, 12, 0)), "2026-10-08T12:00");
eq("garbage expression → not understood", parseCron("every day"), null);
eq("out-of-range field → not understood", parseCron("61 * * * *"), null);
eq("ranges and lists", last("0 9,17 * * 1-5", U(2026, 10, 8, 12, 0)), "2026-10-08T09:00");

console.log("\nwere the crons seen?");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "console-expect-"));
let n = 0;
function fresh() {
  const store = openStore(path.join(tmp, `t${++n}.db`));
  const hit = (route, ts) => store.insertSpans([normalizeSpan({ id: `x${Math.random()}`, trace_id: `t${Math.random()}`, ts, dur: 50, kind: "net.server", name: `GET ${route}`, route }, cfg).row]);
  return { store, hit };
}
const conf = (o = {}) => ({ crons: { enabled: true, vercelJson: "x", graceMinutes: 3, onlyWhenSeen: true, ignore: [], ...o }, events: [] });
const CRONS = [{ path: "/api/cron/daily-8", schedule: "0 8 * * *" }, { path: "/api/cron/quarter", schedule: "*/15 * * * *" }];
const rowOf = (r, name) => r.rows.find((x) => x.name === name);
{
  const { store, hit } = fresh();
  hit("/api/cron/daily-8", U(2026, 10, 8, 8, 0) + 20e3); hit("/api/cron/quarter", U(2026, 10, 8, 12, 0) + 5e3); hit("/api/cron/quarter", U(2026, 10, 8, 11, 45) + 5e3);
  const r = evaluateExpectations(store, conf(), NOW, CRONS);
  eq("ran on time → on_time", [rowOf(r, "/api/cron/daily-8").status, rowOf(r, "/api/cron/quarter").status], ["on_time", "on_time"]);
}
{
  const { store, hit } = fresh();
  hit("/api/cron/daily-8", U(2026, 10, 7, 8, 0)); hit("/api/cron/daily-8", U(2026, 10, 6, 8, 0));   // ran yesterday, NOT today
  const row = rowOf(evaluateExpectations(store, conf(), NOW, CRONS), "/api/cron/daily-8");
  eq("today's run missing → missed, warning", [row.status, row.missed, row.severity], ["missed", 1, "warning"]);
}
{
  const { store, hit } = fresh();
  hit("/api/cron/daily-8", U(2026, 10, 5, 8, 0));                                                      // last ran 3 days ago
  const row = rowOf(evaluateExpectations(store, conf(), NOW, CRONS), "/api/cron/daily-8");
  eq("two runs in a row missed → critical", [row.missed, row.severity], [2, "critical"]);
}
{
  const { store, hit } = fresh();
  hit("/api/cron/quarter", U(2026, 10, 8, 11, 45) + 5e3);                                              // 12:00 not seen yet
  const justDue = evaluateExpectations(store, conf(), U(2026, 10, 8, 12, 1), CRONS);
  eq("within the grace period the 12:00 run is not judged late (11:45 is the last one due)", rowOf(justDue, "/api/cron/quarter").status, "on_time");
  const later = evaluateExpectations(store, conf(), U(2026, 10, 8, 12, 5), CRONS);
  eq("after the grace period it is missed", rowOf(later, "/api/cron/quarter").status, "missed");
}
{
  const { store } = fresh();
  const r = evaluateExpectations(store, conf(), NOW, CRONS);
  eq("a cron never seen at all is NOT judged (can't tell 'not instrumented' from 'broken')", r.rows.map((x) => x.status), ["never_seen", "never_seen"]);
  const strict = evaluateExpectations(store, conf({ onlyWhenSeen: false }), NOW, CRONS);
  eq("…unless you say every cron must be seen", strict.rows.map((x) => x.status), ["missed", "missed"]);
}
{
  const { store } = fresh();
  eq("disabled by default → no rows", evaluateExpectations(store, conf({ enabled: false }), NOW, CRONS).rows, []);
  const shipped = loadExpectations();
  eq("the shipped expectations.json is OFF", shipped.crons.enabled, false);
  const { store: s2, hit } = fresh(); hit("/api/cron/daily-8", U(2026, 10, 1, 8, 0));
  eq("'ignore' skips matching crons", evaluateExpectations(s2, conf({ ignore: ["daily"] }), NOW, CRONS).rows.map((x) => x.name), ["/api/cron/quarter"]);
}

console.log("\nevents");
{
  const { store, hit } = fresh();
  const events = [{ name: "Billing webhook", match: { kind: "net.server", route: "/api/billing/webhook" }, everyMinutes: 60, tolerance: 0.25, required: false }];
  const c = { crons: { enabled: false }, events };
  hit("/api/billing/webhook", NOW - 30 * MIN);
  eq("seen 30 min ago, expected hourly → fine", evaluateExpectations(store, c, NOW).rows[0].status, "on_time");
  eq("seen 3 h ago → missed, warning/critical by how many periods", [evaluateExpectations(store, c, NOW + 150 * MIN).rows[0].status, evaluateExpectations(store, c, NOW + 150 * MIN).rows[0].severity], ["missed", "critical"]);
  eq("a little over the period but inside tolerance → fine", evaluateExpectations(store, c, NOW + 40 * MIN).rows[0].status, "on_time");
  const { store: empty } = fresh();
  eq("never seen and not required → not judged", evaluateExpectations(empty, c, NOW).rows[0].status, "never_seen");
  eq("never seen but required → missed", evaluateExpectations(empty, { crons: { enabled: false }, events: [{ ...events[0], required: true }] }, NOW).rows[0].status, "missed");
  eq("a disabled event is skipped", evaluateExpectations(empty, { crons: { enabled: false }, events: [{ ...events[0], enabled: false }] }, NOW).rows, []);
}

console.log("\nalerts");
{
  const { store, hit } = fresh();
  hit("/api/cron/daily-8", U(2026, 10, 7, 8, 0));
  const ctx = { expectations: conf(), vercelCrons: CRONS };
  await evaluate(store, cfg, NOW, () => {}, ctx);
  const a = store.listAlerts({ state: "open" }).find((x) => x.key === "absence:cron:/api/cron/daily-8");
  check("a missed cron opens an alert naming the schedule and when it last ran", !!a && /0 8 \* \* \*/.test(a.detail) && /min ago/.test(a.detail), a?.detail);
  check("…whose 'last happened' is the last REAL run, not now", a && a.data.last_event_ts === U(2026, 10, 7, 8, 0));
  hit("/api/cron/daily-8", U(2026, 10, 8, 8, 1));
  await evaluate(store, cfg, NOW + 5000, () => {}, ctx);
  check("once the job runs again the alert resolves", !store.listAlerts({ state: "open" }).some((x) => x.key.startsWith("absence:")));
  const { store: s2 } = fresh();
  await evaluate(s2, cfg, NOW, () => {}, { expectations: conf({ enabled: false }), vercelCrons: CRONS });
  eq("disabled → no absence alerts at all", s2.listAlerts({ state: "open" }).filter((x) => x.key.startsWith("absence:")), []);
}
const vercelFile = new URL("../../vercel.json", import.meta.url);
if (!fs.existsSync(vercelFile)) console.log("  – skipped: needs the ImmoAdmin vercel.json (not present here)");
else {
  const real = JSON.parse(fs.readFileSync(vercelFile, "utf8")).crons;
  eq("every one of the real vercel.json schedules is understood", real.filter((c) => !parseCron(c.schedule)).map((c) => c.schedule), []);
  eq("…and each has a last-due time", real.filter((c) => lastScheduled(parseCron(c.schedule), NOW) === null).length, 0);
  console.log(`    (${real.length} real crons parsed)`);
}

console.log(`\n${pass} passed, ${fail} failed\n`);
try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
process.exit(fail ? 1 : 0);
