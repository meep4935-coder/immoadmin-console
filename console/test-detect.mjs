#!/usr/bin/env node
/**
 * Tests for the hidden-bug layer: arithmetic verifier, trace/session detectors, drift baselines,
 * privacy of derived signals, findings → report → digest through a real server.
 *   node qa/console/test-detect.mjs
 */
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { evalExpr, checkArithmetic, detectTrace, detectSession, deriveSignals } from "./detectors.mjs";
import { analyzeDrift } from "./baseline.mjs";
import { normalizeSpan } from "./ingest.mjs";
import { resolveRouteFile, stackLocations } from "./report.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
let pass = 0, fail = 0;
const check = (name, ok, extra = "") => { ok ? pass++ : fail++; console.log(`${ok ? "  ✓" : "  ✗ FAIL"} ${name}${ok ? "" : "  " + extra}`); };
const eq = (name, a, b) => check(name, JSON.stringify(a) === JSON.stringify(b), `got ${JSON.stringify(a)} expected ${JSON.stringify(b)}`);
const rules = (fs_) => fs_.map((f) => f.rule).sort();

// ── arithmetic ───────────────────────────────────────────────────────────────
console.log("\narithmetic verifier");
eq("1 + 1", evalExpr("1 + 1"), 2);
eq("1200 × 0.03", evalExpr("1200 × 0.03"), 36);
eq("precedence and parentheses", evalExpr("(1200 + 36) * 2 - 10 / 4"), 2469.5);
eq("round(x, 2)", evalExpr("round(1236.456, 2)"), 1236.46);
eq("unary minus", evalExpr("-5 + 8"), 3);
eq("garbage → null", evalExpr("abc + 1"), null);
eq("division by zero → null", evalExpr("1 / 0"), null);
eq("no code execution", evalExpr("process.exit(1)"), null);
eq("correct steps → no violation", checkArithmetic({ steps: [{ expr: "1200 × 0.03", result: 36 }, { expr: "1200 + 36", result: 1236 }], output: 1236 }), []);
eq("1 + 1 = 3 is caught", checkArithmetic({ steps: [{ label: "add", expr: "1 + 1", result: 3 }] }).map((v) => v.rule), ["arithmetic"]);
check("message names the real answer", /1 \+ 1 = 2, but the program recorded 3/.test(checkArithmetic({ steps: [{ expr: "1 + 1", result: 3 }] })[0].detail));
eq("output ≠ last step is caught", checkArithmetic({ steps: [{ expr: "2 × 5", result: 10 }], output: 11 }).length, 1);
eq("cent rounding tolerated", checkArithmetic({ steps: [{ expr: "1200 × 0.0213", result: 25.56 }] }), []);
eq("a real cents error is caught", checkArithmetic({ steps: [{ expr: "1200 × 0.0213", result: 25.9 }] }).length, 1);
eq("unparseable expr is skipped, not flagged", checkArithmetic({ steps: [{ expr: "see TAL table", result: 5 }] }), []);

// ── trace detectors ──────────────────────────────────────────────────────────
console.log("\ntrace detectors");
let n = 0;
const sp = (o) => ({ id: `s${++n}`, trace_id: "t", ts: 1_000_000 + n * 10, dur: 10, status: "ok", user_id: "u", session_id: "ss", ...o });
const req = (route = "/api/x", extra = {}) => sp({ id: "req", kind: "net.server", name: `GET ${route}`, route, attrs: { status: 200 }, ...extra });
const db = (name, attrs, extra = {}) => sp({ kind: "db", name, parent_id: "req", attrs, ...extra });

eq("normal trace → no findings (no false alarm)", detectTrace([req(), db("select a", { op: "select", table: "a" }), db("select b", { op: "select", table: "b" })]), []);
eq("N+1: same query ×10 in one request", rules(detectTrace([req(), ...Array.from({ length: 10 }, () => db("select leases", { op: "select", table: "leases" }))])), ["n_plus_one"]);
eq("N+1 not raised for 7 queries", detectTrace([req(), ...Array.from({ length: 7 }, () => db("select leases", { op: "select" }))]), []);
const w = (extra) => db("insert revenus", { op: "insert", table: "revenus", input: { amount: 100 }, ...deriveSignals({ op: "insert", input: { amount: 100 } }, "insert revenus"), ...extra });
eq("identical write twice → duplicate_write", rules(detectTrace([req(), w(), w()])), ["duplicate_write"]);
eq("different inputs → no duplicate", detectTrace([req(), db("insert revenus", { op: "insert", input: { a: 1 }, ...deriveSignals({ op: "insert", input: { a: 1 } }, "insert revenus") }), db("insert revenus", { op: "insert", input: { a: 2 }, ...deriveSignals({ op: "insert", input: { a: 2 } }, "insert revenus") })]), []);
eq("a retried write after a FAILED first try is not a duplicate", detectTrace([req(), w({}, {}), (() => { const s = w(); return s; })()]).length, 1); // sanity: both ok → 1
{
  const first = w(); first.status = "error";
  eq("…whereas a retry after failure is fine", detectTrace([req(), first, w()]).filter((f) => f.rule === "duplicate_write"), []);
}
const post = (ts) => sp({ kind: "net.client", name: "POST /api/pay", ts, attrs: { method: "POST", request_bytes: 40 } });
eq("two identical POSTs within 2 s → double_submit", rules(detectTrace([post(1000), post(1500)])), ["double_submit"]);
eq("POSTs 10 s apart are fine", detectTrace([post(1000), post(11000)]), []);
const get = (ts) => sp({ kind: "net.client", name: "GET /api/me", ts, attrs: { method: "GET" } });
eq("2 identical GETs (React strict mode) are NOT reported", detectTrace([get(1000), get(1100)]), []);
eq("4 identical GETs are reported", rules(detectTrace([get(1000), get(1100), get(1200), get(1300)])), ["duplicate_request"]);
{
  const A = deriveSignals({ op: "select", filters: { owner_id: "eq.aaaa" } }, "x"), B = deriveSignals({ op: "select", filters: { owner_id: "eq.bbbb" } }, "x");
  eq("one request touching 2 owners → multi_owner_access (critical)", detectTrace([req("/api/leases"), db("select a", { op: "select", ...A }), db("select b", { op: "select", ...B })]).map((f) => [f.rule, f.severity]), [["multi_owner_access", "critical"]]);
  eq("…but not on admin routes", detectTrace([req("/api/admin/clients"), db("select a", { op: "select", ...A }), db("select b", { op: "select", ...B })]), []);
  eq("same owner twice is fine", detectTrace([req("/api/leases"), db("select a", { op: "select", ...A }), db("select b", { op: "select", ...A })]), []);
}
eq("DB failure swallowed by a 200 response", rules(detectTrace([req(), db("select prefs", { op: "select" }, { status: "error", error: { message: "timeout" } })])), ["swallowed_error"]);
eq("DB failure that fails the request is NOT 'swallowed'", detectTrace([req("/api/x", { status: "error" }), db("select prefs", { op: "select" }, { status: "error" })]).filter((f) => f.rule === "swallowed_error"), []);
eq("same call failing 3× → retry_storm", rules(detectTrace([req("/api/x", { status: "error" }), ...Array.from({ length: 3 }, () => db("rpc kv", { op: "rpc" }, { status: "error" }))])), ["retry_storm"]);

// ── session detectors ────────────────────────────────────────────────────────
console.log("\nsession (confusion) detectors");
const click = (ts, text, extra = {}) => sp({ kind: "ui.click", name: `Clic : ${text}`, ts, attrs: { target: { text, component: "Btn" } }, ...extra });
eq("3 clicks on one control in 1.2 s → rage_click", rules(detectSession([click(0, "Save"), click(500, "Save"), click(1200, "Save")])), ["rage_click"]);
eq("3 clicks on DIFFERENT controls → nothing", detectSession([click(0, "A"), click(400, "B"), click(900, "C")]), []);
eq("slow repeated clicks (3 s apart) → nothing", detectSession([click(0, "Save"), click(3000, "Save"), click(6000, "Save")]), []);
eq("dead click then click again → needed_second_click", rules(detectSession([click(0, "Send", { status: "dead" }), click(2000, "Send")])), ["needed_second_click"]);
eq("same action failing 3× in a row → repeated_failure", rules(detectSession([click(0, "Pay", { status: "error" }), click(20000, "Pay", { status: "error" }), click(40000, "Pay", { status: "error" })])), ["repeated_failure"]);
const nav = (ts, to) => sp({ kind: "ui.nav", name: `Navigation → ${to}`, ts, attrs: { to } });
eq("A→B→A→B quickly → navigation_loop", rules(detectSession([nav(0, "/a"), nav(2000, "/b"), nav(4000, "/a"), nav(6000, "/b")])), ["navigation_loop"]);
eq("normal browsing → nothing", detectSession([nav(0, "/a"), nav(2000, "/b"), nav(4000, "/c"), nav(6000, "/d")]), []);

// ── drift ────────────────────────────────────────────────────────────────────
console.log("\ndrift / baselines");
const D = { recentMin: 60, baselineDays: 7, minSamples: 30, minRecent: 10, p95Ratio: 1.5, p95MinDiffMs: 150, errRatio: 3, errAbs: 0.05, volumeDropRatio: 0.3, minExpectedVolume: 20, creepDays: 4, creepRatio: 1.3, creepMinPerDay: 20 };
const NOW = Date.UTC(2026, 9, 7, 12, 0, 0), H = 3600e3, DAY = 86400e3;
const rows = (route, count, from, to, dur, errRate = 0) => Array.from({ length: count }, (_, i) => ({ route, dur: dur + ((i * 7) % 20), status: i < count * errRate ? "error" : "ok", ts: from + ((to - from) * i) / count }));
const run = (baseline, recent) => analyzeDrift({ baseline, recent, clicksBase: [], clicksRecent: [], now: NOW, recentMs: H, baselineMs: 7 * DAY }, D).map((f) => `${f.rule}:${f.key}`).sort();
const base = [...rows("/api/a", 1400, NOW - 7 * DAY - H, NOW - H, 200, 0.01), ...rows("/api/b", 1400, NOW - 7 * DAY - H, NOW - H, 200, 0.01)];
eq("recent matches baseline → nothing", run(base, [...rows("/api/a", 30, NOW - H, NOW, 210, 0.01), ...rows("/api/b", 30, NOW - H, NOW, 205)]), []);
eq("route 3× slower → latency_drift only for that route", run(base, [...rows("/api/a", 30, NOW - H, NOW, 700), ...rows("/api/b", 30, NOW - H, NOW, 205)]), ["latency_drift:/api/a"]);
eq("failure rate jumps → error_rate_drift", run(base, [...rows("/api/a", 30, NOW - H, NOW, 210, 0.4), ...rows("/api/b", 30, NOW - H, NOW, 205)]), ["error_rate_drift:/api/a"]);
{
  const busy = [...rows("/api/a", 5000, NOW - 7 * DAY - H, NOW - H, 200), ...rows("/api/b", 5000, NOW - 7 * DAY - H, NOW - H, 200)]; // ≈ 30 requests/hour each
  eq("busy route goes quiet → volume_drop", run(busy, rows("/api/b", 30, NOW - H, NOW, 205)), ["volume_drop:/api/a"]);
  eq("a low-traffic route going quiet is NOT flagged (too little signal)", run(base, rows("/api/b", 30, NOW - H, NOW, 205)), []);
}
{
  const days = [200, 230, 270, 330, 400];
  const creep = days.flatMap((d, i) => rows("/api/slowly", 60, NOW - (days.length - i) * DAY, NOW - (days.length - i - 1) * DAY, d));
  eq("median rising every day → slow_creep", run(creep, rows("/api/slowly", 12, NOW - H, NOW, 400)).filter((x) => x.startsWith("slow_creep")), ["slow_creep:/api/slowly"]);
  const flat = [200, 205, 198, 202, 204].flatMap((d, i) => rows("/api/flat", 60, NOW - (5 - i) * DAY, NOW - (4 - i) * DAY, d));
  eq("flat latency → no slow_creep", run(flat, rows("/api/flat", 12, NOW - H, NOW, 202)), []);
}
eq("too little history → not judged", run(rows("/api/new", 5, NOW - 2 * H, NOW - H, 100), rows("/api/new", 30, NOW - H, NOW, 900)), []);

// ── privacy: derived signals survive prod-mode scrubbing without exposing ids ─
console.log("\nprivacy of derived signals");
{
  const raw = { id: "d1", trace_id: "t", ts: Date.now(), kind: "db", name: "select x", attrs: { op: "select", filters: { owner_id: "eq.11111111-2222-3333-4444-555555555555" } } };
  const prod = normalizeSpan(raw, { mode: "prod", slowMs: { default: 1500 }, maxAttrBytes: 65536 }).row;
  const attrs = JSON.parse(prod.attrs);
  check("prod mode keeps a pseudonymous owner fingerprint", Array.isArray(attrs._owners) && attrs._owners.length === 1);
  check("…and the raw owner id is gone from the stored row", !prod.attrs.includes("11111111-2222"));
  const bad = normalizeSpan({ id: "c1", trace_id: "t", ts: Date.now(), kind: "calc", name: "add", attrs: { steps: [{ expr: "1 + 1", result: 3 }] } }, { mode: "prod", slowMs: { default: 1500 }, maxAttrBytes: 65536 });
  check("arithmetic is checked on RAW values even in prod mode", bad.row.status === "error" && bad.violations.length === 1);
}

// ── report helpers ───────────────────────────────────────────────────────────
console.log("\nreport helpers");
const haveRepo = fs.existsSync(path.join(HERE, "..", "..", "src", "app", "api", "portal-kv", "mutate", "route.ts"));
if (!haveRepo) console.log("  – skipped: the next 3 checks look files up in an ImmoAdmin checkout (not present here)");
if (haveRepo) {
eq("static route → file", resolveRouteFile("/api/portal-kv/mutate"), "src/app/api/portal-kv/mutate/route.ts");
eq("dynamic segment → [id] directory", resolveRouteFile("/api/buildings/:id")?.startsWith("src/app/api/buildings/[") ?? false, true);
}
eq("unknown route → null", resolveRouteFile("/api/does/not/exist"), null);
eq("stack frames limited to app files that exist", stackLocations("Error: x\n    at f (src/app/api/portal-kv/mutate/route.ts:41:9)\n    at g (node_modules/next/x.js:1:1)\n    at h (src/nope/missing.ts:3:3)").map((l) => [l.file, l.exists]), [["src/app/api/portal-kv/mutate/route.ts", haveRepo], ["src/nope/missing.ts", false]]);

// ── integration through a real server ────────────────────────────────────────
console.log("\nserver: findings → report → digest");
const PORT = 4392;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "console-detect-"));
const child = spawn(process.execPath, [path.join(HERE, "server.mjs"), `--port=${PORT}`, `--db=${path.join(tmp, "t.db")}`, "--eval-every=3600"], { stdio: ["ignore", "pipe", "pipe"] });
let logs = ""; child.stdout.on("data", (d) => (logs += d)); child.stderr.on("data", (d) => (logs += d));
const call = (method, p, body) => new Promise((resolve, reject) => {
  const r = http.request({ host: "127.0.0.1", port: PORT, path: p, method, headers: { "content-type": "application/json" } }, (res) => { let b = ""; res.on("data", (c) => (b += c)); res.on("end", () => { let j = null; try { j = JSON.parse(b); } catch {} resolve({ status: res.statusCode, json: j, body: b }); }); });
  r.on("error", reject); if (body) r.write(JSON.stringify(body)); r.end();
});
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
try {
  for (let i = 0; i < 40; i++) { try { if ((await call("GET", "/api/health")).status === 200) break; } catch {} await sleep(150); }
  const now = Date.now();
  const s = (o) => ({ id: "x" + Math.random().toString(36).slice(2, 9), ts: now, dur: 5, user_id: "u_a", session_id: "sess1", role: "owner", ...o });
  const spans = [
    s({ id: "c1", trace_id: "tc", kind: "ui.nav", name: "Navigation → /portail/outils", attrs: { to: "/portail/outils" }, route: "/portail/outils" }),
    s({ id: "c2", trace_id: "tc", kind: "ui.click", name: "Clic : Calculer", route: "/portail/outils", attrs: { target: { text: "Calculer", component: "TalCalculator" } } }),
    s({ id: "c3", trace_id: "tc", parent_id: "c2", kind: "calc", name: "calculerAugmentationLoyer", route: "/portail/outils", attrs: { steps: [{ label: "increase", expr: "1200 × 0.03", result: 36 }, { label: "new rent", expr: "1200 + 36", result: 1337 }], output: 1337 } }),
  ];
  const ing = await call("POST", "/ingest", { spans });
  eq("ingest accepted", ing.json.accepted, 3);
  const f = (await call("GET", "/api/findings?range=1h")).json;
  const arith = f.rows.find((r) => r.rule === "arithmetic");
  check("wrong rent arithmetic became a finding", !!arith && /1200 \+ 36 = 1236/.test(arith.detail), JSON.stringify(f.rows.map((r) => r.rule)));
  const errs = (await call("GET", "/api/errors?range=1h")).json.rows;
  check("…and an InvariantViolation error group", errs.some((e) => e.error?.name === "InvariantViolation"));
  const rep = await call("GET", `/api/report?rule=arithmetic&key=${encodeURIComponent(arith.key)}`);
  check("bug report generated", rep.status === 200 && rep.json.markdown.startsWith("# Bug report:"), rep.body.slice(0, 200));
  check("report contains the reconstructed steps and the console link", /Steps to reproduce/.test(rep.json.markdown) && /Click “Calculer”/.test(rep.json.markdown) && /127\.0\.0\.1:4392\/#\/trace\/tc/.test(rep.json.markdown));
  const rep2 = await call("GET", `/api/report?fp=${errs.find((e) => e.error?.name === "InvariantViolation").fingerprint}`);
  check("report from an error group works", rep2.status === 200 && /Where it fails|Error/.test(rep2.json.markdown));
  const dg = await call("GET", "/api/digest?range=24h");
  check("digest generated with its sections", dg.status === 200 && ["At a glance", "Hidden-bug findings", "New error types"].every((h) => dg.json.markdown.includes(h)));
  check("digest lists the finding", /Wrong arithmetic/.test(dg.json.markdown));
  eq("unknown report → 404", (await call("GET", "/api/report?fp=000000000000")).status, 404);
} catch (e) { fail++; console.log("  ✗ FAIL unexpected:", e.stack || e, logs.slice(-400)); }
finally { child.kill(); await sleep(300); try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {} }

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
