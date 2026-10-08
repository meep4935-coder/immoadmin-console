#!/usr/bin/env node
/** Runs every console test suite and prints one summary.   node qa/console/test-all.mjs */
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SUITES = ["test", "test-detect", "test-alerts", "test-triage", "test-release", "test-monitor", "test-expect", "test-feedback", "test-deps", "test-pull"];
let total = 0, failed = 0;
console.log("");
for (const s of SUITES) {
  const r = spawnSync(process.execPath, [path.join(HERE, `${s}.mjs`)], { encoding: "utf8" });
  const m = (r.stdout || "").match(/(\d+) passed, (\d+) failed/);
  const p = m ? +m[1] : 0, f = m ? +m[2] : 1;
  total += p; failed += f + (r.status !== 0 && !f ? 1 : 0);
  console.log(`  ${f || r.status ? "✗" : "✓"} ${s.padEnd(14)} ${m ? `${p} passed${f ? `, ${f} FAILED` : ""}` : "did not finish"}`);
  if (f || r.status) console.log((r.stdout || "").split("\n").filter((l) => /FAIL/.test(l)).map((l) => "      " + l.trim()).join("\n") + (r.stderr ? "\n" + r.stderr.slice(0, 400) : ""));
}
console.log(`\n  ${total} tests passed, ${failed} failed across ${SUITES.length} suites\n`);
process.exit(failed ? 1 : 0);
