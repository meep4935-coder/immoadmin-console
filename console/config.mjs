// Trace Console — configuration (flags > env > defaults). No dependencies.
import path from "node:path";
import { fileURLToPath } from "node:url";

export const HERE = path.dirname(fileURLToPath(import.meta.url));

const args = process.argv.slice(2);
export function arg(name, def) {
  const hit = args.find((a) => a === `--${name}` || a.startsWith(`--${name}=`));
  if (!hit) return def;
  const i = hit.indexOf("=");
  return i === -1 ? true : hit.slice(i + 1);
}
const int = (v, d) => { const n = parseInt(v, 10); return Number.isFinite(n) ? n : d; };

export const cfg = {
  port: int(arg("port", process.env.CONSOLE_PORT), 4317),
  // Loopback only. The console holds trace data; it must never listen on the LAN.
  host: "127.0.0.1",
  // dev  = keep real inputs/outputs (secrets are still redacted).
  // prod = pseudonymous mode: values are truncated, emails/phones masked,
  //        payload keys (input/output/body…) reduced to their shape.
  mode: String(arg("mode", process.env.CONSOLE_MODE || "dev")) === "prod" ? "prod" : "dev",
  // If set, POST /ingest must carry header  x-trace-token: <token>.
  token: String(arg("token", process.env.CONSOLE_TOKEN || "")),
  dbFile: String(arg("db", path.join(HERE, "data", "console.db"))),
  retentionDays: int(arg("retention-days"), 14),
  maxBodyBytes: 2 * 1024 * 1024,
  maxBatch: 500,
  maxAttrBytes: 64 * 1024,
  // A span longer than this (by kind) is flagged "slow" at ingest.
  slowMs: {
    "net.client": 3000, "net.server": 2000, db: 1000, external: 4000,
    "ui.click": 300, "ui.input": 300, render: 200, calc: 500, fn: 1000, default: 1500,
  },
  alerts: {
    evalEverySec: int(arg("eval-every"), 15),
    windowMin: 5,          // "recent" window for rate-based rules
    errorSpikeMin: 5,      // at least this many errors in the window…
    errorSpikeFactor: 3,   // …and this many times the previous-hour baseline
    routeMinRequests: 5,
    routeFailRate: 0.3,
    routeSlowMinRequests: 10,
    routeSlowP95Ms: 3000,
    skewMs: 5000,          // browser ↔ server clock difference worth a warning
    rejectMin: 5,          // rejected spans in the window worth a warning
    struggleMinUsers: 3,   // ONE grouped alert once this many users are "failing" (health.mjs) for unexplained reasons
    newErrorWindowMin: 10,
    silenceMin: int(arg("silence-min"), 15), // 0 disables the "no data" alert
  },
  // Baseline / drift detection (baseline.mjs): last `recentMin` minutes versus the `baselineDays` before them.
  drift: {
    everySec: int(arg("drift-every"), 60),
    recentMin: 60, baselineDays: 7,
    minSamples: 30,        // baseline requests needed before a route is judged
    minRecent: 10,         // recent requests needed
    p95Ratio: 1.5, p95MinDiffMs: 150,
    errRatio: 3, errAbs: 0.05,
    volumeDropRatio: 0.3, minExpectedVolume: 20,
    creepDays: 4, creepRatio: 1.3, creepMinPerDay: 20,
  },
  // Third-party health (dependencies.mjs): the last `recentMin` minutes versus the rest of the viewed range.
  dependencies: { recentMin: 15, minRecent: 5, minBaseline: 30, errorRate: 0.25, downRate: 0.9, slowRatio: 2, slowMinDiffMs: 300 },
  // Detectors that run on every ingested trace / session (detectors.mjs).
  detect: { nPlusOne: 8, getDuplicates: 3, retryStorm: 3 },
  // Optional: POST each newly opened warning/critical alert here (off by default).
  webhookUrl: String(process.env.CONSOLE_WEBHOOK || ""),
};
