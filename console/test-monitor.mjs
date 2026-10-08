#!/usr/bin/env node
/** Monitoring the monitor: intake counters, recorder heartbeats (drops, clock skew), rejects. */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { cfg } from "./config.mjs";
import { createMonitor } from "./monitor.mjs";
import { openStore } from "./store.mjs";
import { evaluate } from "./alerts.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
let pass = 0, fail = 0;
const check = (name, ok, extra = "") => { ok ? pass++ : fail++; console.log(`${ok ? "  ✓" : "  ✗ FAIL"} ${name}${ok ? "" : "  " + extra}`); };
const eq = (name, a, b) => check(name, JSON.stringify(a) === JSON.stringify(b), `got ${JSON.stringify(a)} expected ${JSON.stringify(b)}`);
const NOW = Date.UTC(2026, 9, 8, 12, 0, 0), MIN = 60e3;

console.log("\nintake monitor");
{
  const m = createMonitor();
  m.record({ accepted: 50, now: NOW }); m.record({ accepted: 30, rejected: [{ reason: "bad ts" }, { reason: "bad ts" }, { reason: "missing id" }], now: NOW + 1000 });
  const s = m.snapshot(NOW + 2000);
  eq("counts accepted / rejected / batches", [s.accepted, s.rejected, s.batches], [80, 3, 2]);
  eq("top reject reason first", s.rejectReasons, [{ reason: "bad ts", count: 2 }, { reason: "missing id", count: 1 }]);
  eq("old minutes fall out of the window", m.snapshot(NOW + 20 * MIN).accepted, 0);
  m.record({ accepted: 2, spans: [{ source: "browser", ts: NOW + 40 * MIN - 800, dur: 100 }, { source: "server", ts: NOW + 40 * MIN - 50, dur: 10 }], now: NOW + 40 * MIN });
  const lag = m.snapshot(NOW + 40 * MIN).lag;
  check("lag per source = how old the newest event is on arrival", Math.round(lag.browser) === 700 && Math.round(lag.server) === 40, JSON.stringify(lag));
}

console.log("\nrecorder alerts");
{
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "console-mon-"));
  const store = openStore(path.join(tmp, "a.db"));
  const beat = (o) => store.recordHealth([{ ts: NOW - MIN, source: "browser", session_id: "s1", user_id: "u", app_version: "v", attrs: { dropped: 0, sent: 100, queued: 0, ...o } }]);
  const keys = async (ctx = {}) => { await evaluate(store, cfg, NOW, () => {}, ctx); return store.listAlerts({ state: "open" }).map((a) => a.key); };

  beat({ skew_ms: 120 });
  eq("a healthy recorder raises nothing", await keys({ monitor: createMonitor() }), []);

  beat({ dropped: 7 });
  const k1 = await keys();
  check("dropped events → 'recorder is losing events'", k1.includes("recorder_dropping"), k1.join());

  store.recordHealth([{ ts: NOW - 30e3, source: "server", session_id: "srv", attrs: { dropped: 0, skew_ms: 9400 } }]);
  const a = (await (async () => { await evaluate(store, cfg, NOW, () => {}, {}); return store.listAlerts({ state: "open" }); })()).find((x) => x.key === "clock_skew");
  check("a 9 s clock difference → 'clocks disagree', naming how far", !!a && /9\.4 s ahead/.test(a.detail), a?.detail);
  store.recordHealth([{ ts: NOW - 20e3, source: "browser", session_id: "s2", attrs: { dropped: 0, skew_ms: -2000 } }]);

  const m = createMonitor();
  m.record({ accepted: 10, rejected: Array.from({ length: 6 }, () => ({ reason: "bad ts (epoch ms expected)" })), now: NOW - 10e3 });
  await evaluate(store, cfg, NOW, () => {}, { monitor: m });
  const rej = store.listAlerts({ state: "open" }).find((x) => x.key === "ingest_rejects");
  check("≥5 rejected spans → 'console is rejecting data' with the reason", !!rej && /bad ts/.test(rej.detail), rej?.detail);
  const m2 = createMonitor(); m2.record({ accepted: 10, rejected: [{ reason: "x" }, { reason: "x" }], now: NOW - 10e3 });
  const tmp2 = openStore(path.join(tmp, "b.db"));
  await evaluate(tmp2, cfg, NOW, () => {}, { monitor: m2 });
  eq("2 rejected spans is below the threshold → nothing", tmp2.listAlerts({ state: "open" }).map((x) => x.key), []);
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
}

console.log("\nserver");
const PORT = 4395, tmp = fs.mkdtempSync(path.join(os.tmpdir(), "console-mon2-"));
const child = spawn(process.execPath, [path.join(HERE, "server.mjs"), `--port=${PORT}`, `--db=${path.join(tmp, "s.db")}`, "--eval-every=3600", "--drift-every=3600"], { stdio: "ignore" });
const call = (method, p, body) => new Promise((resolve, reject) => {
  const r = http.request({ host: "127.0.0.1", port: PORT, path: p, method, headers: { "content-type": "application/json" } }, (res) => { let b = ""; res.on("data", (c) => (b += c)); res.on("end", () => { let j = null; try { j = JSON.parse(b); } catch {} resolve({ status: res.statusCode, json: j }); }); });
  r.on("error", reject); if (body) r.write(JSON.stringify(body)); r.end();
});
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
try {
  for (let i = 0; i < 40; i++) { try { if ((await call("GET", "/api/health")).status === 200) break; } catch {} await sleep(150); }
  const now = Date.now();
  const first = (await call("GET", "/api/recorder-health")).json;
  eq("before any data: healthy, nothing received", [first.healthy, first.ingest.accepted], [true, 0]);

  const ing = await call("POST", "/ingest", { spans: [
    { id: "h1", trace_id: "th1", ts: now, kind: "health", name: "[recorder] health", source: "browser", session_id: "sess", user_id: "u", attrs: { dropped: 4, sent: 90, queued: 2, skew_ms: 7200 } },
    { id: "a1", trace_id: "t1", ts: now - 300, dur: 20, kind: "net.server", name: "GET /api/x", route: "/api/x", source: "server" },
    { id: "bad1", trace_id: "t", ts: 5, kind: "fn", name: "bad" }, { id: "bad2", trace_id: "t", ts: 6, kind: "fn", name: "bad" },
    { id: "bad3", trace_id: "t", ts: 7, kind: "fn", name: "bad" }, { id: "bad4", trace_id: "t", ts: 8, kind: "fn", name: "bad" },
    { id: "bad5", trace_id: "t", ts: 9, kind: "fn", name: "bad" },
  ] });
  eq("heartbeat + real span accepted, 5 bad ones rejected", [ing.json.accepted, ing.json.rejected.length], [2, 5]);
  const h = (await call("GET", "/api/recorder-health")).json;
  eq("intake counts match", [h.ingest.accepted, h.ingest.rejected], [2, 5]);
  eq("the recorder's dropped events are reported", h.dropped, 4);
  check("issues name drops, rejects and the clock", h.issues.some((i) => /dropped/.test(i)) && h.issues.some((i) => /rejected/.test(i)) && h.issues.some((i) => /7\.2 s off/.test(i)), JSON.stringify(h.issues));
  eq("not healthy any more", h.healthy, false);
  const traces = (await call("GET", "/api/traces?range=1h")).json.rows;
  eq("heartbeats never appear as user activity (only the real span is a trace)", traces.map((t) => t.root_name), ["GET /api/x"]);
  eq("…and are not counted as spans", (await call("GET", "/api/health")).json.spans, 1);
} catch (e) { fail++; console.log("  ✗ FAIL unexpected:", e.stack || e); }
finally { child.kill(); await sleep(300); try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {} }

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
