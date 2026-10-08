#!/usr/bin/env node
/**
 * Self-contained tests for the Trace Console (no framework, no network, temp database).
 *   node qa/console/test.mjs
 */
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { scrub } from "./scrub.mjs";
import { normalizeSpan, fingerprintOf } from "./ingest.mjs";
import { healthOf } from "./health.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
let pass = 0, fail = 0;
const check = (name, ok, extra = "") => { ok ? pass++ : fail++; console.log(`${ok ? "  ✓" : "  ✗ FAIL"} ${name}${ok ? "" : "  " + extra}`); };
const eq = (name, a, b) => check(name, JSON.stringify(a) === JSON.stringify(b), `got ${JSON.stringify(a)} expected ${JSON.stringify(b)}`);

// ── unit: redaction ──────────────────────────────────────────────────────────
console.log("\nredaction");
{
  const s = scrub({ authorization: "Bearer abc", password: "x", note: "tok eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abcdefghijk123", ok: 1 }, { mode: "dev" });
  eq("secret keys redacted", [s.authorization, s.password], ["[redacted]", "[redacted]"]);
  check("JWT inside a string replaced", s.note.includes("[jwt]") && !s.note.includes("eyJhbGci"));
  eq("normal values kept (dev)", s.ok, 1);
  const p = scrub({ message: "mail jean@example.com tel 514-555-0199", input: { name: "Jean", n: 5 } }, { mode: "prod" });
  check("prod masks email and phone", p.message.includes("[email]") && p.message.includes("[phone]"), p.message);
  eq("prod reduces payload keys to shape", p.input, { name: { _string: 4 }, n: "number" });
  const d = scrub({ a: { b: { c: { d: { e: { f: { g: { h: { i: 1 } } } } } } } } }, { mode: "dev" });
  check("depth is bounded", JSON.stringify(d).includes("max depth"));
}

// ── unit: normalize / fingerprint / health ───────────────────────────────────
console.log("\ningest + health");
{
  const cfg = { mode: "dev", slowMs: { db: 1000, default: 1500 }, maxAttrBytes: 65536 };
  const base = { id: "a", trace_id: "t", ts: Date.now(), kind: "db", name: "q" };
  check("bad ts rejected", !!normalizeSpan({ ...base, ts: 5 }, cfg).reject);
  check("missing trace_id rejected", !!normalizeSpan({ ...base, trace_id: "" }, cfg).reject);
  eq("slow derived from duration", normalizeSpan({ ...base, dur: 1500 }, cfg).row.status, "slow");
  const e1 = { name: "E", message: "row 123 id 3f2b9c1e-0000-4000-8000-000000000001 missing", stack: "E: x\n    at fn (src/a.ts:1:1)" };
  const e2 = { name: "E", message: "row 999 id 11111111-2222-4333-8444-555555555555 missing", stack: "E: x\n    at fn (src/a.ts:9:9)" };
  eq("same error, different ids/numbers → same fingerprint", fingerprintOf(e1, "db"), fingerprintOf(e2, "db"));
  check("different kind → different fingerprint", fingerprintOf(e1, "db") !== fingerprintOf(e1, "fn"));
  const r = normalizeSpan({ ...base, error: e1, attrs: { token: "zzz" } }, cfg).row;
  check("error span gets status + fingerprint", r.status === "error" && !!r.fingerprint);
  check("attrs scrubbed at ingest", JSON.parse(r.attrs).token === "[redacted]");
  eq("health: 1 error among 200 actions is healthy", healthOf({ errors: 1, traces: 200 }), "healthy");
  eq("health: 4 of 10 failed → failing", healthOf({ errors: 3, dead: 1, traces: 10 }), "failing");
  eq("health: 1 of 10 failed → degraded", healthOf({ errors: 1, traces: 10 }), "degraded");
}

// ── integration: real server on a temp db ────────────────────────────────────
const PORT = 4391, TOKEN = "test-token";
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "console-test-"));
const child = spawn(process.execPath, [path.join(HERE, "server.mjs"), `--port=${PORT}`, `--db=${path.join(tmp, "t.db")}`, "--eval-every=1"],
  { env: { ...process.env, CONSOLE_TOKEN: TOKEN }, stdio: ["ignore", "pipe", "pipe"] });
let logs = ""; child.stdout.on("data", (d) => (logs += d)); child.stderr.on("data", (d) => (logs += d));

const raw = (method, p, { body, headers = {}, host } = {}) => new Promise((resolve, reject) => {
  const req = http.request({ host: "127.0.0.1", port: PORT, path: p, method, headers: { ...(host ? { host } : {}), ...headers } }, (res) => {
    let b = ""; res.on("data", (c) => (b += c)); res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body: b }));
  });
  req.on("error", reject); if (body) req.write(body); req.end();
});
const json = async (method, p, opts) => { const r = await raw(method, p, opts); return { ...r, json: (() => { try { return JSON.parse(r.body); } catch { return null; } })() }; };
const ingest = (spans, token = TOKEN) => json("POST", "/ingest", { body: JSON.stringify({ spans }), headers: { "content-type": "application/json", ...(token ? { "x-trace-token": token } : {}) } });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitUp() { for (let i = 0; i < 40; i++) { try { if ((await json("GET", "/api/health")).status === 200) return true; } catch {} await sleep(150); } return false; }

try {
  console.log("\nserver");
  check("server starts", await waitUp(), logs);
  const now = Date.now();
  const sp = (o) => ({ id: "s" + Math.random().toString(36).slice(2, 10), trace_id: "t1", ts: now, dur: 10, kind: "fn", name: "n", user_id: "u1", session_id: "ss", role: "owner", ...o });

  eq("ingest without token → 401", (await ingest([sp({})], "")).status, 401);
  eq("ingest with wrong token → 401", (await ingest([sp({})], "nope")).status, 401);
  const tooMany = await ingest(Array.from({ length: 501 }, () => sp({})));
  eq("batch over limit → 413", tooMany.status, 413);
  eq("evil Host header → 403 (DNS-rebinding guard)", (await raw("GET", "/api/health", { host: "evil.example" })).status, 403);
  eq("ack without x-console header → 403", (await json("POST", "/api/alerts/1/ack")).status, 403);

  // One failed user action: ui → net.client → net.server → db, each layer failing.
  const err = (msg) => ({ name: "Error", message: msg, stack: `Error: ${msg}\n    at deep (src/x.ts:1:1)` });
  const chain = [
    sp({ id: "c1", trace_id: "tfail", kind: "ui.click", name: "Click: Save", parent_id: null, error: err("could not save"), route: "/portail/x" }),
    sp({ id: "c2", trace_id: "tfail", kind: "net.client", name: "POST /api/x", parent_id: "c1", error: err("500") }),
    sp({ id: "c3", trace_id: "tfail", kind: "net.server", name: "POST /api/x", parent_id: "c2", error: err("failed"), route: "/api/x" }),
    sp({ id: "c4", trace_id: "tfail", kind: "db", name: "upsert t", parent_id: "c3", error: err("duplicate key") }),
    sp({ name: "<img src=x onerror=alert(1)>", trace_id: "txss", id: "x1" }),
  ];
  const ing = await ingest(chain);
  eq("valid batch accepted", [ing.status, ing.json?.accepted], [200, 5]);
  const bad = await ingest([{ id: "q", trace_id: "t", ts: 1, kind: "fn", name: "bad ts" }, sp({})]);
  eq("bad span rejected, good one kept", [bad.json?.accepted, bad.json?.rejected?.length], [1, 1]);

  const errs = (await json("GET", "/api/errors?range=1h")).json.rows;
  eq("a 4-layer failure is ONE error group (root cause = db)", [errs.length, errs[0]?.kind, errs[0]?.n], [1, "db", 1]);
  const t = (await json("GET", "/api/trace/tfail")).json;
  eq("trace rolled up: 4 spans, 4 error spans, status error", [t.trace.spans, t.trace.errors, t.trace.status], [4, 4, "error"]);
  const xss = await json("GET", "/api/trace/txss");
  check("hostile span name stored as data and served as JSON", xss.json.spans[0].name.startsWith("<img") && xss.headers["content-type"].startsWith("application/json") && xss.headers["x-content-type-options"] === "nosniff");

  // user health: 10 actions, 4 of them failed → failing
  const many = [];
  for (let i = 0; i < 10; i++) many.push(sp({ trace_id: `h${i}`, user_id: "u_sick", kind: "ui.click", name: "Click", status: i < 4 ? "dead" : "ok", ts: now + i }));
  await ingest(many);
  const users = (await json("GET", "/api/users?range=15m")).json.rows;
  eq("user with 4/10 dead clicks is failing", users.find((u) => u.user_id === "u_sick")?.health, "failing");
  eq("user with one failed action out of 1 is degraded/failing, not healthy", users.find((u) => u.user_id === "u1")?.health !== "healthy", true);

  // alerts: a route failing at ≥30% over ≥5 requests
  const reqs = []; for (let i = 0; i < 6; i++) reqs.push(sp({ trace_id: `r${i}`, kind: "net.server", name: "POST /api/boom", route: "/api/boom", dur: 20, user_id: `ur${i}`, ...(i < 4 ? { error: err("boom") } : {}) }));
  await ingest(reqs);
  let alert = null;
  for (let i = 0; i < 12 && !alert; i++) { await sleep(500); alert = (await json("GET", "/api/alerts?state=open")).json.rows.find((a) => a.key === "route_failing:/api/boom"); }
  check("route_failing alert opens (4/6 requests failed)", !!alert, logs.slice(-300));
  if (alert) { const a = await json("POST", `/api/alerts/${alert.id}/ack`, { headers: { "x-console": "1" } }); eq("ack with header works", a.status, 200); }
  check("overview responds", (await json("GET", "/api/overview")).json.counts.spans > 10);
  check("stats responds with buckets", (await json("GET", "/api/stats?range=1h")).json.buckets.length >= 1);
} catch (e) {
  fail++; console.log("  ✗ FAIL unexpected:", e.stack || e);
} finally {
  child.kill();
  await sleep(300);
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
}
console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
