#!/usr/bin/env node
/**
 * Loads a vitest JSON report into the console as REAL traces.
 *   npx vitest run --reporter=json --outputFile=qa/reports/vitest.json
 *   node qa/console/adapters/vitest.mjs qa/reports/vitest.json [--url=http://127.0.0.1:4317] [--token=…]
 *
 * One trace per test file; one span per test (its real duration). A failing test
 * carries its failure message as the error, so it shows up under Errors, grouped
 * with identical failures, and opens in the trace view with a root-cause box.
 */
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { arg } from "../config.mjs";

const file = process.argv.slice(2).find((a) => !a.startsWith("--"));
if (!file) { console.error("usage: vitest.mjs <report.json> [--url=…] [--token=…]"); process.exit(2); }
const URL_ = String(arg("url", "http://127.0.0.1:4317")).replace(/\/$/, "");
const TOKEN = String(arg("token", process.env.CONSOLE_TOKEN || ""));
const REPO = process.cwd();

const report = JSON.parse(fs.readFileSync(file, "utf8"));
const runId = String(report.startTime || Date.now());
const h = (s) => crypto.createHash("sha1").update(s).digest("hex").slice(0, 10);

function toError(msgs) {
  const full = (msgs || []).join("\n\n");
  const first = full.split("\n").find((l) => l.trim()) || "test failed";
  const m = first.match(/^(\w*Error|AssertionError)\s*:?\s*(.*)$/);
  return { name: m ? m[1] : "TestFailure", message: (m ? m[2] || first : first).slice(0, 500), stack: full.slice(0, 6000) };
}

const spans = [];
let tests = 0, failed = 0;
for (const f of report.testResults || []) {
  const rel = path.relative(REPO, f.name).replace(/\\/g, "/");
  const trace_id = `t_vt_${h(rel + runId)}`;
  const rootId = `sp_vt_${h("root" + rel + runId)}`;
  const start = f.startTime || report.startTime || Date.now();
  let cursor = start;
  const children = [];
  for (const a of f.assertionResults || []) {
    if (a.status === "pending" || a.status === "skipped" || a.status === "todo") continue;
    tests++;
    const dur = a.duration ?? 0;
    const bad = a.status === "failed";
    if (bad) failed++;
    children.push({
      id: `sp_vt_${h(rel + a.fullName + runId)}`, trace_id, parent_id: rootId, ts: cursor, dur,
      kind: "fn", name: a.fullName || a.title, status: bad ? "error" : "ok", source: "vitest", route: rel,
      user_id: "vitest", session_id: `run_${runId}`, role: "admin", env: "test",
      attrs: { file: rel, ancestors: a.ancestorTitles, result: a.status },
      ...(bad ? { error: toError(a.failureMessages) } : {}),
    });
    cursor += dur;
  }
  const nFail = children.filter((c) => c.status === "error").length;
  const fileFailed = f.status === "failed" && nFail === 0; // failed to load/compile: no per-test results
  spans.push({
    id: rootId, trace_id, ts: start, dur: Math.max((f.endTime || cursor) - start, cursor - start), kind: "fn",
    name: `${rel} (${children.length} tests${nFail ? `, ${nFail} failed` : ""})`, source: "vitest", route: rel,
    user_id: "vitest", session_id: `run_${runId}`, role: "admin", env: "test",
    status: nFail || fileFailed ? "error" : "ok", attrs: { file: rel, tests: children.length, failed: nFail },
    ...(fileFailed ? { error: toError([f.message || "test file failed to run"]) } : {}),
  });
  spans.push(...children);
}

for (let i = 0; i < spans.length; i += 400) {
  const res = await fetch(URL_ + "/ingest", {
    method: "POST", headers: { "content-type": "application/json", ...(TOKEN ? { "x-trace-token": TOKEN } : {}) },
    body: JSON.stringify({ spans: spans.slice(i, i + 400) }),
  });
  if (!res.ok) { console.error(`ingest failed ${res.status}: ${await res.text()}`); process.exit(1); }
  const j = await res.json(); if (j.rejected?.length) console.error("rejected:", JSON.stringify(j.rejected.slice(0, 3)));
}
console.log(`loaded ${report.testResults?.length || 0} files, ${tests} tests (${failed} failed) → ${spans.length} spans`);
