#!/usr/bin/env node
/** Dependencies: naming services, spotting failure / slowness, avoiding false alarms, alerts. */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { cfg } from "./config.mjs";
import { openStore } from "./store.mjs";
import { normalizeSpan } from "./ingest.mjs";
import { evaluate } from "./alerts.mjs";
import { serviceOf, analyzeDependencies, evaluateDependencies } from "./dependencies.mjs";

let pass = 0, fail = 0;
const check = (name, ok, extra = "") => { ok ? pass++ : fail++; console.log(`${ok ? "  ✓" : "  ✗ FAIL"} ${name}${ok ? "" : "  " + extra}`); };
const eq = (name, a, b) => check(name, JSON.stringify(a) === JSON.stringify(b), `got ${JSON.stringify(a)} expected ${JSON.stringify(b)}`);
const NOW = Date.UTC(2026, 10, 8, 12, 0, 0), MIN = 60e3, H = 3600e3;
const D = cfg.dependencies;

console.log("\nnaming services");
eq("hosts → friendly names", ["api.stripe.com", "api.zumrails.com", "api.twilio.com", "api.anthropic.com", "abcd.supabase.co", "api.resend.com"].map(serviceOf), ["Stripe", "Zūm Rails", "Twilio", "Anthropic", "Supabase", "Resend"]);
eq("a port is ignored", serviceOf("api.stripe.com:443"), "Stripe");
eq("an unknown host keeps its own name", serviceOf("example.org"), "example.org");

const rows = (host, count, from, to, dur, errRate = 0, msg = "503 Service Unavailable") =>
  Array.from({ length: count }, (_, i) => ({ host, dur: dur + (i % 13), status: i < count * errRate ? "error" : "ok", ts: from + ((to - from) * i) / count, msg: i < count * errRate ? msg : null }));
const run = (r, rangeMs = 24 * H) => analyzeDependencies(r, { now: NOW, rangeMs, bucketMs: H }, D);
const one = (r, name) => run(r).find((s) => s.name === name);

console.log("\nhealth of a service");
{
  const normal = [...rows("api.stripe.com", 300, NOW - 24 * H, NOW - 16 * 60e3, 200, 0.01), ...rows("api.stripe.com", 20, NOW - 14 * 60e3, NOW, 205, 0)];
  eq("steady → healthy", one(normal, "Stripe").status, "healthy");
  const down = [...rows("api.twilio.com", 300, NOW - 24 * H, NOW - 16 * 60e3, 150, 0.01), ...rows("api.twilio.com", 20, NOW - 14 * 60e3, NOW, 150, 1)];
  const t = one(down, "Twilio");
  eq("everything failing recently → down", t.status, "down");
  check("…saying so in numbers", /100% of the last 20 calls failed/.test(t.reasons[0]), t.reasons.join());
  eq("…and naming the most common error", t.top_error?.message, "503 Service Unavailable");
  const deg = [...rows("api.zumrails.com", 300, NOW - 24 * H, NOW - 16 * 60e3, 200, 0.01), ...rows("api.zumrails.com", 20, NOW - 14 * 60e3, NOW, 200, 0.4)];
  eq("40% of recent calls failing → degraded (not down)", one(deg, "Zūm Rails").status, "degraded");
  const slow = [...rows("api.anthropic.com", 300, NOW - 24 * H, NOW - 16 * 60e3, 1500), ...rows("api.anthropic.com", 20, NOW - 14 * 60e3, NOW, 4200)];
  const a = one(slow, "Anthropic");
  eq("3× slower than its own normal → degraded", a.status, "degraded");
  check("…with the latency comparison", /p95 latency/.test(a.reasons.join()), a.reasons.join());
  const naturally = rows("api.anthropic.com", 3000, NOW - 24 * H, NOW, 3000); // ≈ 30 calls per 15 min
  eq("a service that is ALWAYS slow is not 'degraded' (compared with itself, not a fixed limit)", one(naturally, "Anthropic").status, "healthy");
  const quiet = [...rows("api.resend.com", 300, NOW - 24 * H, NOW - 2 * H, 200), ...rows("api.resend.com", 2, NOW - 10 * 60e3, NOW, 200, 1)];
  eq("too few recent calls → 'idle', never an alarm", one(quiet, "Resend").status, "idle");
  const oldFailure = [...rows("api.stripe.com", 100, NOW - 24 * H, NOW - 20 * H, 200, 0.9), ...rows("api.stripe.com", 100, NOW - 14 * 60e3, NOW, 200, 0)];
  eq("an outage that ENDED hours ago is not current", one(oldFailure, "Stripe").status, "healthy");
  eq("worst first in the list", run([...normal, ...down]).map((s) => s.name), ["Twilio", "Stripe"]);
}
{
  const s = one([...rows("abcd.supabase.co", 50, NOW - 3 * H, NOW, 40), ...rows("x.supabase.co", 10, NOW - 3 * H, NOW, 40)], "Supabase");
  eq("several hosts of one service are merged", [s.calls, s.hosts.length], [60, 2]);
  check("buckets are provided for the sparkline", s.buckets.length >= 3 && s.buckets.every((b) => b.n > 0));
}

console.log("\nthrough the store and the alert loop");
{
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "console-deps-"));
  const store = openStore(path.join(tmp, "d.db"));
  const put = (host, ts, dur, failed, kind = "external") => store.insertSpans([normalizeSpan({
    id: `x${Math.random()}`, trace_id: `t${Math.random()}`, ts, dur, kind, name: `POST ${host}`, attrs: { host }, source: "server",
    ...(failed ? { error: { name: "Error", message: `${host} 503` } } : {}),
  }, cfg).row]);
  for (let i = 0; i < 200; i++) put("api.stripe.com", NOW - 23 * H + i * 6 * MIN, 200, false);
  for (let i = 0; i < 200; i++) put("api.twilio.com", NOW - 23 * H + i * 6 * MIN, 150, i % 100 === 0);
  for (let i = 0; i < 12; i++) { put("api.stripe.com", NOW - 10 * MIN + i * 30e3, 210, false); put("api.twilio.com", NOW - 10 * MIN + i * 30e3, 150, true); }
  put("abcd.supabase.co", NOW - 5 * MIN, 30, false, "db");
  const svc = evaluateDependencies(store, cfg, NOW);
  eq("both external and database calls are included", svc.map((s) => s.name).sort(), ["Stripe", "Supabase", "Twilio"]);
  eq("Twilio is down, Stripe fine", [svc.find((s) => s.name === "Twilio").status, svc.find((s) => s.name === "Stripe").status], ["down", "healthy"]);
  await evaluate(store, cfg, NOW, () => {}, {});
  const a = store.listAlerts({ state: "open" }).filter((x) => x.key.startsWith("dependency:"));
  eq("one alert, for the failing service only", a.map((x) => [x.key, x.severity]), [["dependency:Twilio", "critical"]]);
  check("…with a plain-language reason and a real 'last happened'", /failed/.test(a[0].detail) && a[0].data.last_event_ts > NOW - 11 * MIN, a[0].detail);
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
}

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
