#!/usr/bin/env node
/**
 * Alert behaviour: grouped "users struggling", rate-based, explained-away, and honest timestamps.
 *   node qa/console/test-alerts.mjs
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { cfg } from "./config.mjs";
import { openStore } from "./store.mjs";
import { normalizeSpan } from "./ingest.mjs";
import { evaluate } from "./alerts.mjs";

let pass = 0, fail = 0;
const check = (name, ok, extra = "") => { ok ? pass++ : fail++; console.log(`${ok ? "  ✓" : "  ✗ FAIL"} ${name}${ok ? "" : "  " + extra}`); };
const eq = (name, a, b) => check(name, JSON.stringify(a) === JSON.stringify(b), `got ${JSON.stringify(a)} expected ${JSON.stringify(b)}`);

const NOW = Date.UTC(2026, 9, 8, 12, 0, 0), MIN = 60e3;
let seq = 0;
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "console-alerts-"));
function fresh() {
  const store = openStore(path.join(tmpRoot, `t${++seq}.db`));
  const put = (spans) => store.insertSpans(spans.map((s) => normalizeSpan(s, cfg).row));
  let n = 0;
  /** One user action: a click, optionally with the request it triggered. */
  const action = (user, ts, { fail: failed = false, route = null, routeFails = failed, crash = false } = {}) => {
    const tid = `t${++n}`;
    const base = { trace_id: tid, user_id: user, session_id: `s_${user}`, role: "owner", ts, dur: 20 };
    const spans = [{ ...base, id: `c${n}`, kind: "ui.click", name: "Clic : Enregistrer", status: failed ? "error" : "ok" }];
    if (route) spans.push({ ...base, id: `r${n}`, parent_id: `c${n}`, kind: "net.server", name: `POST ${route}`, route, status: routeFails ? "error" : "ok", error: routeFails ? { name: "HttpError", message: "HTTP 500" } : undefined });
    if (crash) spans.push({ ...base, id: `x${n}`, parent_id: `c${n}`, kind: "crash", name: "Render crash <Table>", status: "error", error: { name: "TypeError", message: "x is undefined", stack: "TypeError: x\n    at Table (src/a.tsx:1:1)" } });
    put(spans);
  };
  const keys = async (now = NOW) => { await evaluate(store, cfg, now); return store.listAlerts({ state: "open" }); };
  return { store, action, keys, put };
}
const at = (minAgo) => NOW - minAgo * MIN;

// ── noise: normal background failures must not alert ─────────────────────────
console.log("\nno noise");
{
  const { action, keys } = fresh();
  for (let u = 0; u < 40; u++) for (let i = 0; i < 50; i++) action(`u${u}`, at(4.5) + i * 1000, { fail: i < 3 }); // 3 of 50 = 6 %
  const a = await keys();
  eq("40 users each failing 6 % of actions → no 'struggling' alert at all", a.filter((x) => /struggl|^user:/.test(x.key + x.title)), []);
  check("no per-user alerts exist any more", !a.some((x) => x.key.startsWith("user:")));
}

// ── grouping and the rate rule ───────────────────────────────────────────────
console.log("\ngrouped and rate-based");
{
  const { action, keys } = fresh();
  for (let u = 0; u < 5; u++) for (let i = 0; i < 6; i++) action(`bad${u}`, at(4) + i * 1000, { fail: i < 5 });   // 5 of 6 failed
  for (let u = 0; u < 20; u++) for (let i = 0; i < 30; i++) action(`ok${u}`, at(4) + i * 1000);
  const a = (await keys()).filter((x) => /struggl/.test(x.key));
  eq("5 failing users → exactly ONE alert", a.map((x) => [x.key, x.title]), [["users_struggling", "5 users are struggling"]]);
  eq("…listing exactly the failing users", [...a[0].data.users].sort(), ["bad0", "bad1", "bad2", "bad3", "bad4"]);
  check("healthy users are not in it", !a[0].data.users.some((u) => u.startsWith("ok")));
}
{
  const { action, keys } = fresh();
  for (let u = 0; u < 2; u++) for (let i = 0; i < 6; i++) action(`bad${u}`, at(4) + i * 1000, { fail: i < 5 });
  eq("only 2 failing users (below the minimum of 3) → no alert", (await keys()).filter((x) => /struggl/.test(x.key)), []);
}
{
  const { action, keys } = fresh();
  for (let u = 0; u < 5; u++) for (let i = 0; i < 100; i++) action(`u${u}`, at(4.8) + i * 1000, { fail: i < 3 });  // 3 failures but 3 % of 100
  eq("3 failures among 100 actions each → not 'failing' → no alert", (await keys()).filter((x) => /struggl/.test(x.key)), []);
}

// ── explained away ───────────────────────────────────────────────────────────
console.log("\nexplained-away");
{
  const { action, keys } = fresh();
  for (let u = 0; u < 6; u++) for (let i = 0; i < 6; i++) action(`u${u}`, at(4) + i * 1000, { fail: true, route: "/api/boom" });  // 36 failing requests
  const a = await keys();
  check("the failing route IS alerted", a.some((x) => x.key === "route_failing:/api/boom"));
  eq("…and the 6 users it failed are NOT separately alerted", a.filter((x) => /struggl/.test(x.key)), []);
}
{
  const { action, keys } = fresh();
  for (let u = 0; u < 6; u++) for (let i = 0; i < 5; i++) action(`u${u}`, at(4) + i * 1000, { fail: true, crash: true });
  const a = await keys();
  check("the crash IS alerted", a.some((x) => x.key.startsWith("crash:")));
  eq("…and the users it hit are not separately alerted", a.filter((x) => /struggl/.test(x.key)), []);
}
{
  const { action, keys } = fresh();
  for (let u = 0; u < 4; u++) for (let i = 0; i < 6; i++) action(`explained${u}`, at(4) + i * 1000, { fail: true, route: "/api/boom" });
  for (let u = 0; u < 4; u++) for (let i = 0; i < 6; i++) action(`mystery${u}`, at(4) + i * 1000, { fail: i < 5 });       // fail with nothing else explaining it
  const a = await keys();
  const s = a.find((x) => x.key === "users_struggling");
  check("route alert present", a.some((x) => x.key === "route_failing:/api/boom"));
  eq("only the UNEXPLAINED users are grouped", s ? [...s.data.users].sort() : null, ["mystery0", "mystery1", "mystery2", "mystery3"]);
}

// ── honest timestamps ────────────────────────────────────────────────────────
console.log("\nlast occurrence, and resolution");
{
  const { action, keys, store } = fresh();
  for (let i = 0; i < 12; i++) action(`u${i}`, at(4) + i * 1000, { fail: true });          // errors 4 minutes ago, window is 5 min
  const a1 = (await keys(NOW)).find((x) => x.key === "error_spike");
  check("error spike alert opens", !!a1);
  const last = a1.data.last_event_ts;
  check("last_event_ts is when the errors really happened (≈4 min ago), not 'now'", Math.abs(last - (at(4) + 11 * 1000)) < 1500 && NOW - last > 3 * MIN, `last=${NOW - last} ms ago`);
  const a2 = (await keys(NOW + 20_000)).find((x) => x.key === "error_spike");
  check("a later check keeps the true last occurrence (alert.last_ts moves, data does not)", a2.last_ts > a1.last_ts && a2.data.last_event_ts === last);
  const a3 = (await keys(NOW + 10 * MIN)).find((x) => x.key === "error_spike");
  check("once the window has passed, the alert resolves", a3 === undefined && store.listAlerts({ state: "resolved" }).some((x) => x.key === "error_spike"));
}

console.log(`\n${pass} passed, ${fail} failed\n`);
try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch {}
process.exit(fail ? 1 : 0);
