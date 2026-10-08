#!/usr/bin/env node
/** Release markers: which build a problem started in, and regressions between consecutive builds. */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { analyzeRegression } from "./baseline.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
let pass = 0, fail = 0;
const check = (name, ok, extra = "") => { ok ? pass++ : fail++; console.log(`${ok ? "  ✓" : "  ✗ FAIL"} ${name}${ok ? "" : "  " + extra}`); };
const eq = (name, a, b) => check(name, JSON.stringify(a) === JSON.stringify(b), `got ${JSON.stringify(a)} expected ${JSON.stringify(b)}`);

const D = { minSamples: 30, p95Ratio: 1.5, p95MinDiffMs: 150, errRatio: 3, errAbs: 0.05 };
const NOW = Date.UTC(2026, 9, 8, 12, 0, 0);
const rows = (route, n, version, dur, errRate = 0) => Array.from({ length: n }, (_, i) => ({ route, app_version: version, dur: dur + (i % 17), status: i < n * errRate ? "error" : "ok", ts: NOW - 1000 * i }));
const REL = [{ version: "v1", first_seen: NOW - 86400e3 }, { version: "v2", first_seen: NOW - 3600e3 }];
const run = (r, rel = REL) => analyzeRegression(r, rel, NOW, D).map((f) => `${f.severity}:${f.title}`);

console.log("\nregression between releases");
eq("same speed in both builds → nothing", run([...rows("/api/a", 60, "v1", 200), ...rows("/api/a", 60, "v2", 205)]), []);
eq("3× slower in the newest build → flagged, naming the build", run([...rows("/api/a", 60, "v1", 200), ...rows("/api/a", 60, "v2", 650)]), ["warning:Slower since release v2: /api/a"]);
eq("only the regressed route is flagged", run([...rows("/api/a", 60, "v1", 200), ...rows("/api/a", 60, "v2", 650), ...rows("/api/b", 60, "v1", 100), ...rows("/api/b", 60, "v2", 105)]).length, 1);
eq("a failure-rate jump is flagged", run([...rows("/api/a", 60, "v1", 200, 0.01), ...rows("/api/a", 60, "v2", 200, 0.4)]), ["critical:More failures since release v2: /api/a"]);
eq("too few requests in the new build → not judged yet", run([...rows("/api/a", 60, "v1", 200), ...rows("/api/a", 10, "v2", 900)]), []);
eq("a single release → nothing to compare", run(rows("/api/a", 60, "v1", 200), [REL[0]]), []);
eq("it compares the NEWEST build with the one before it, not with older ones", run([...rows("/api/a", 60, "v1", 900), ...rows("/api/a", 60, "v2", 200), ...rows("/api/a", 60, "v3", 210)], [...REL, { version: "v3", first_seen: NOW - 600e3 }]), []);

console.log("\nserver");
const PORT = 4394, tmp = fs.mkdtempSync(path.join(os.tmpdir(), "console-release-"));
const child = spawn(process.execPath, [path.join(HERE, "server.mjs"), `--port=${PORT}`, `--db=${path.join(tmp, "r.db")}`, "--eval-every=3600", "--drift-every=3600"], { stdio: "ignore" });
const call = (method, p, body) => new Promise((resolve, reject) => {
  const r = http.request({ host: "127.0.0.1", port: PORT, path: p, method, headers: { "content-type": "application/json" } }, (res) => { let b = ""; res.on("data", (c) => (b += c)); res.on("end", () => { let j = null; try { j = JSON.parse(b); } catch {} resolve({ status: res.statusCode, json: j }); }); });
  r.on("error", reject); if (body) r.write(JSON.stringify(body)); r.end();
});
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
try {
  for (let i = 0; i < 40; i++) { try { if ((await call("GET", "/api/health")).status === 200) break; } catch {} await sleep(150); }
  const now = Date.now();
  const sp = (id, ts, version, extra = {}) => ({ id, trace_id: `t_${id}`, ts, dur: 10, kind: "db", name: "select x", user_id: "u", app_version: version, ...extra });
  const E = (msg) => ({ error: { name: "PostgrestError", message: msg, stack: `PostgrestError\n    at f (src/${msg}.ts:1:1)` } });
  await call("POST", "/ingest", { spans: [
    sp("a1", now - 3 * 3600e3, "v1"), sp("a2", now - 2.5 * 3600e3, "v1", E("oldBug")),               // old bug, born in v1
    sp("b1", now - 3600e3, "v2"), sp("b2", now - 3000e3, "v2", E("oldBug")), sp("b3", now - 2000e3, "v2", E("newBug")),   // new bug, born in v2
  ] });
  const rel = (await call("GET", "/api/releases")).json;
  eq("lists builds oldest first, current = newest", [rel.rows.map((r) => r.version), rel.current.version], [["v1", "v2"], "v2"]);
  const errs = (await call("GET", "/api/errors?range=24h")).json;
  const byMsg = Object.fromEntries(errs.rows.map((r) => [r.error.message, r.introduced_in]));
  eq("each error says which build FIRST recorded it", [byMsg.oldBug, byMsg.newBug], ["v1", "v2"]);
  eq("…even though 'oldBug' also happens in v2", errs.rows.length, 2);
  const latest = (await call("GET", "/api/errors?range=24h&release=latest")).json.rows.map((r) => r.error.message);
  eq("'introduced in the latest release' keeps only the new one", latest, ["newBug"]);
  const stats = (await call("GET", "/api/stats?range=6h")).json;
  eq("Trends gets a release marker for the new build", stats.releases.map((r) => r.version), ["v2"]);
  const ov = (await call("GET", "/api/overview")).json;
  eq("overview reports the current release", [ov.release.current, ov.release.builds], ["v2", 2]);
  await call("POST", "/ingest", { spans: [sp("n1", now, null)] });
  eq("spans with no build id are ignored for releases", (await call("GET", "/api/releases")).json.rows.length, 2);
} catch (e) { fail++; console.log("  ✗ FAIL unexpected:", e.stack || e); }
finally { child.kill(); await sleep(300); try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {} }

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
