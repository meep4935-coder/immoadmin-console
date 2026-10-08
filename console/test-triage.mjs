#!/usr/bin/env node
/** Triage state: ack / fixed (reopens) / ignored, in lists, counts, alerts and the API. */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { cfg } from "./config.mjs";
import { openStore } from "./store.mjs";
import { normalizeSpan } from "./ingest.mjs";
import { applyTriage, countFindings, errorRef, findingRef } from "./triage.mjs";
import { evaluate } from "./alerts.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
let pass = 0, fail = 0;
const check = (name, ok, extra = "") => { ok ? pass++ : fail++; console.log(`${ok ? "  ✓" : "  ✗ FAIL"} ${name}${ok ? "" : "  " + extra}`); };
const eq = (name, a, b) => check(name, JSON.stringify(a) === JSON.stringify(b), `got ${JSON.stringify(a)} expected ${JSON.stringify(b)}`);

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "console-triage-"));
const NOW = Date.now();
let seq = 0;
function fresh() {
  const store = openStore(path.join(tmp, `t${++seq}.db`));
  const put = (s) => store.insertSpans([normalizeSpan({ trace_id: `t${seq}${Math.random()}`, user_id: "u1", session_id: "s", ...s, id: `i${Math.random()}` }, cfg).row]);
  const err = (ts, msg = "boom") => put({ ts, kind: "db", name: "select x", error: { name: "PostgrestError", message: msg, stack: "PostgrestError\n    at f (src/a.ts:1:1)" }, route: "/api/x" });
  return { store, err, put };
}
const rows = (store, mode = "open", since = 0) => applyTriage(store, "error", store.listErrors({ since }), errorRef, mode);

console.log("\nerrors");
{
  const { store, err } = fresh();
  err(NOW - 5 * 60e3); err(NOW - 4 * 60e3);
  const fp = store.listErrors({ since: 0 })[0].fingerprint;
  eq("untouched error is 'new'", rows(store).map((r) => r.triage.status), ["new"]);
  store.setTriage("error", fp, "ack", "Kevin is on it", NOW - 3 * 60e3);
  eq("acknowledged: still listed, with its note", rows(store).map((r) => [r.triage.status, r.triage.note]), [["ack", "Kevin is on it"]]);
  store.setTriage("error", fp, "ignored", "known, not a bug", NOW - 2 * 60e3);
  eq("ignored: hidden from the default view", rows(store), []);
  eq("…but visible with 'show all'", rows(store, "all").map((r) => r.triage.status), ["ignored"]);
  store.setTriage("error", fp, "new", null, NOW);
  eq("reset: back to 'new'", rows(store).map((r) => r.triage.status), ["new"]);
}
{
  const { store, err } = fresh();
  err(NOW - 10 * 60e3);
  const fp = store.listErrors({ since: 0 })[0].fingerprint;
  store.setTriage("error", fp, "fixed", "patched in release 42", NOW - 5 * 60e3);
  eq("fixed and quiet: hidden", rows(store), []);
  err(NOW - 1 * 60e3); err(NOW - 30e3);
  const r = rows(store);
  eq("fixed, but it happened AGAIN afterwards → reopened", r.map((x) => x.triage.status), ["reopened"]);
  eq("…and says how many times since the fix", r[0].triage.since_fix, 2);
}

console.log("\nfindings");
{
  const { store } = fresh();
  const f = (rule, key, ts, cat = "integrity") => store.addFinding({ rule, key, category: cat, severity: "warning", title: `${rule} ${key}`, detail: "d", trace_id: `t${Math.random()}`, span_id: "s", user_id: "u", session_id: "s", ts });
  f("duplicate_write", "A", NOW - 60e3); f("n_plus_one", "B", NOW - 50e3, "performance"); f("rage_click", "C", NOW - 40e3, "confusion");
  let list = () => applyTriage(store, "finding", store.listFindings({ since: 0 }), findingRef, "open");
  eq("3 findings, all new", list().length, 3);
  store.setTriage("finding", "n_plus_one|B", "ignored", "known, tracked in ticket", NOW);
  eq("ignoring one removes it from the list", list().map((r) => r.rule).sort(), ["duplicate_write", "rage_click"]);
  eq("…and from the category counts (overview tile)", countFindings(list()).map((c) => c.category).sort(), ["confusion", "integrity"]);
  eq("a finding key containing '|' round-trips", (store.setTriage("finding", "rage_click|C|x", "ack", null, NOW), store.triageMap("finding").has("rage_click|C|x")), true);
}

console.log("\nalerts");
{
  const { store, err } = fresh();
  const a = cfg.alerts;
  err(NOW - 30e3);
  const fp = store.listErrors({ since: 0 })[0].fingerprint;
  await evaluate(store, cfg, NOW);
  check("a brand-new error type raises 'new error type'", store.listAlerts({ state: "open" }).some((x) => x.key === `new_error:${fp}`));
  store.setTriage("error", fp, "ignored", "known", NOW);
  await evaluate(store, cfg, NOW + 1000);
  check("…once ignored, that alert resolves and stays quiet", !store.listAlerts({ state: "open" }).some((x) => x.key === `new_error:${fp}`));
}

console.log("\nAPI");
const PORT = 4393;
const child = spawn(process.execPath, [path.join(HERE, "server.mjs"), `--port=${PORT}`, `--db=${path.join(tmp, "api.db")}`, "--eval-every=3600", "--drift-every=3600"], { stdio: "ignore" });
const call = (method, p, body, headers = {}) => new Promise((resolve, reject) => {
  const r = http.request({ host: "127.0.0.1", port: PORT, path: p, method, headers: { "content-type": "application/json", ...headers } }, (res) => { let b = ""; res.on("data", (c) => (b += c)); res.on("end", () => { let j = null; try { j = JSON.parse(b); } catch {} resolve({ status: res.statusCode, json: j }); }); });
  r.on("error", reject); if (body) r.write(JSON.stringify(body)); r.end();
});
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
try {
  for (let i = 0; i < 40; i++) { try { if ((await call("GET", "/api/health")).status === 200) break; } catch {} await sleep(150); }
  const ing = await call("POST", "/ingest", { spans: [{ id: "e1", trace_id: "t1", ts: Date.now(), kind: "db", name: "select x", user_id: "u", error: { name: "E", message: "m", stack: "E\n    at f (src/a.ts:1:1)" } }] });
  eq("ingested", ing.json.accepted, 1);
  const fp = (await call("GET", "/api/errors?range=1h")).json.rows[0].fingerprint;
  eq("POST /api/triage needs the x-console header", (await call("POST", "/api/triage", { kind: "error", ref: fp, status: "ignored" })).status, 403);
  eq("rejects an unknown status", (await call("POST", "/api/triage", { kind: "error", ref: fp, status: "banana" }, { "x-console": "1" })).status, 400);
  eq("rejects an unknown kind", (await call("POST", "/api/triage", { kind: "alert", ref: fp, status: "ack" }, { "x-console": "1" })).status, 400);
  eq("accepts a valid decision", (await call("POST", "/api/triage", { kind: "error", ref: fp, status: "ignored", note: "known" }, { "x-console": "1" })).status, 200);
  eq("ignored error disappears from /api/errors", (await call("GET", "/api/errors?range=1h")).json.rows, []);
  const all = (await call("GET", "/api/errors?range=1h&triage=all")).json.rows;
  eq("…and is back with triage=all, carrying its note", [all.length, all[0].triage.status, all[0].triage.note], [1, "ignored", "known"]);
} catch (e) { fail++; console.log("  ✗ FAIL unexpected:", e.stack || e); }
finally { child.kill(); await sleep(300); try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {} }

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
