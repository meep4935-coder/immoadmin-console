# Trace Console

A local console that records **what a program executes, how long each step takes, and where and why
it fails** — down to the inputs, outputs and steps of a calculation — and finds the problems that
**don't crash anything**: wrong results, data-integrity risks, drift away from normal, confused users,
and things that should have happened but didn't. It watches active users (pseudonymous ids) and writes
bug reports a developer can act on.

Runs on **Node ≥ 22.5 with no npm dependencies** (built-in `node:sqlite`, `node:http`).

```bash
node qa/console/server.mjs                                  # http://127.0.0.1:4317   (loopback only)
node qa/console/sim.mjs --hidden --releases --duration=60   # simulated users: hidden bugs, two builds, outside services
node qa/console/sim.mjs --backfill=6h --hidden --releases   # fill 6 h of history (Trends, baselines, release markers)
node qa/console/sim.mjs --duration=60 --storm=30            # + a failing route / failing Twilio for 30 s
node qa/console/test-all.mjs                                # every suite below, one summary (257 tests)
```

Individual suites: `test` (ingest, redaction, alerts, security) · `test-detect` (detectors, drift, privacy, report, digest) ·
`test-alerts` · `test-triage` · `test-release` · `test-monitor` · `test-expect` · `test-feedback` · `test-deps` · `test-pull`.

Flags (`config.mjs`): `--port`, `--db`, `--mode=dev|prod`, `--token`, `--retention-days` (14), `--eval-every` (alerts, s),
`--drift-every` (baselines + feedback, s), `--silence-min`. Env: `CONSOLE_TOKEN`, `CONSOLE_MODE`, `CONSOLE_WEBHOOK`.

## Pages

| page | answers |
|---|---|
| **Overview** | current release, **recorder health**, active users, failing users, requests, error rate, p95, findings; open alerts; users needing attention; live stream |
| **Traces / Trace detail** | every user action; one trace = likely root cause, execution timeline, and per step its input, output, computation steps, error. **Bug report** button |
| **Users** | each user's health (failing = ≥3 failed actions and ≥25 % of them; degraded = ≥5 % failed or ≥25 % slow) |
| **Errors** | identical failures grouped by **root cause**, with the release each was **introduced in**; triage buttons; **Bug report** |
| **Findings** | hidden-bug detections (below), grouped; triage buttons; **Bug report** |
| **Trends** | requests, errors, active users, slowest routes — with a line where each new release appeared |
| **Dependencies** | Stripe, Zūm Rails, Twilio, Anthropic, Supabase…: status, latency trend, failure rate, common error |
| **Alerts** | open / resolved alerts, and the **Expected activity** panel (crons and webhooks that should have run) |
| **Digest** | what got worse / better / is new versus the previous period; copy or download as markdown |

## What it detects

**Alerts** (`alerts.mjs`) — crash · error spike · route failing / slow · **users struggling** (one grouped alert; only users whose
actions mostly failed, and only for failures no other alert explains) · new error type · silence · **a recorder is losing events** ·
**clocks disagree** · **console is rejecting data** · **expected activity is missing** · **a dependency is down or degraded**.
Every alert shows when the problem *last happened* and how long the alert has been open.

**Findings — rules that need no history** (`detectors.mjs`)

| category | rule | catches |
|---|---|---|
| silent-wrong | `arithmetic` | every recorded calculation step is **re-computed**; `1200 + 36` recorded as `1337` is flagged (checked on raw values, so it works in prod mode) |
| silent-wrong | `invariant` | an assertion written in the application (`traceInvariant(...)`) failed |
| silent-wrong | `swallowed_error` | a call failed deeper down but the request still answered 200 |
| silent-wrong | `no_feedback` | an action failed and the user was shown **no message** |
| silent-wrong | `false_success` | the user saw a **success** message while the request failed |
| integrity | `multi_owner_access`, `duplicate_write`, `double_submit` | one request touching several owners' rows; the same write / POST twice |
| performance | `n_plus_one`, `duplicate_request`, `retry_storm` | same query ≥8× in one request; same GET ≥3×; same call failing ≥3× |
| confusion | `rage_click`, `needed_second_click`, `repeated_failure`, `navigation_loop` | hammering a control; a dead click followed by another; the same action failing 3×; A→B→A→B |

**Findings — learned from history** (`baseline.mjs`): `latency_drift`, `error_rate_drift`, `volume_drop`, `slow_creep`,
`dead_click_drift`, and **`release_regression`** (the newest release versus the one before it, per route).

All rules have tests for the **negative** case too: normal traffic must raise nothing.

## Triage, releases, absence, health — how they work

* **Triage** (`triage.mjs`): mark an error group or finding *acknowledged*, *fixed*, *ignored* (with a note). Ignored items leave the default views,
  the overview counts, the digest, and "new error type" alerts. **A "fixed" item reopens automatically** if it happens again after the fix, and
  says how many times.
* **Releases**: the build id sent with every span (`NEXT_PUBLIC_BUILD_ID` / `VERCEL_GIT_COMMIT_SHA`). Trends marks each new build; Errors shows
  where each problem was introduced and can filter to "the latest release only".
* **Absence** (`expectations.mjs`, **off by default**): reads every cron from `vercel.json`, works out when each last should have run (UTC), and alerts
  if the console did not see it (2 misses in a row = critical). Plus "this should be seen at least every N minutes" rules for webhooks. Edit
  `expectations.json` (re-read live). **Only turn it on when the console receives data from the environment where the jobs actually run** —
  in development nothing schedules them.
* **Recorder health**: every recorder sends a heartbeat (events dropped, browser↔server clock difference). The console also counts what it accepts and
  rejects and how late events arrive. Heartbeats are kept apart from spans, so they never look like user activity.
* **Feedback capture**: the browser recorder notes toasts and error banners (`[data-sonner-toast]`, `role=alert/status`, `aria-live`). A click is
  only judged on "no message shown" if its recorder says it tracked messages, and only once it is ≥6 s old (the message may still be in flight).

## Bug report and digest

* **Bug report** (`report.mjs`, `GET /api/report?fp=|trace=|rule=&key=`): severity, triage status, counts, the path from the user's action to the failing
  step, error and cause chain, **likely code location** (route → source file, stack frames that exist in the repo), steps to reproduce reconstructed from
  the session, failing input/output/computation, a timeline, recent occurrences with console links.
* **Digest** (`digest.mjs`, `GET /api/digest?range=24h`): at-a-glance table vs the previous period, slower/faster routes, new and most frequent errors,
  findings, users who struggled, alerts raised. Triaged-away items are left out.

## Sending data

See **[SCHEMA.md](SCHEMA.md)** — `POST /ingest` with spans. In ImmoAdmin the recorders (`src/app/lib/trace/`) send automatically when
`TRACE_CONSOLE=1` / `NEXT_PUBLIC_TRACE_CONSOLE=1` (development only, never in production). Application code can add:

```ts
import { traceInvariant, traceViolations, traced } from "@/app/lib/trace/api";   // no-ops unless the recorder is active
traceViolations("import.plan.comptabilite", checkPlanAccounting(compteRendu, plan.actions.length), { batchId });
const doc = await traced("parseOneValidatedFile", () => parse(file), { input: { name: file.name } });
```

`src/app/lib/trace/importChecks.ts` holds the AI-import consistency rules as pure, tested functions.

## Measured on this machine (Windows, Node 24, simulated data)

* Ingest ≈ 2,000 spans/s into SQLite; 500 active users at ~1 action / 10 s ≈ 200 spans/s.
* Queries at ~78k spans: errors 117 ms, users 12 ms, overview 24 ms, stats(24 h) 92 ms. (The dependency, drift and absence checks scan wider ranges
  and are memoised or run every 60 s; re-profile them on large data.)
* Single-threaded and synchronous: a slow query delays ingest.

## Security

* Listens on **127.0.0.1 only**; a `Host` other than `127.0.0.1:<port>`/`localhost:<port>` gets 403 (DNS-rebinding guard).
* `/ingest` needs `x-trace-token` when a token is set; body ≤ 2 MB, ≤ 500 spans. State-changing calls (acknowledge, triage) need `x-console: 1`.
  The UI never uses `innerHTML`.
* Secrets are scrubbed at ingest in every mode. `--mode=prod` also masks e-mails/phones and keeps only the *shape* of payloads — while
  pseudonymous fingerprints (which owners a query touched, a hash of what it wrote) are kept so isolation and duplicate-write checks still work.

## Not built yet

* **Wiring the import checks into the import pipeline** (one-line `traceViolations(...)` calls). The checks exist and are tested; the pipeline code is
  critical and money-adjacent, so it needs review first.
* **Linking background jobs to their cause** (carrying the trace id through Inngest events and webhooks) — touches critical job code.
* **A production data source** now exists as a package (`qa/dist/trace-prod-package.zip`): a production recorder + `sources/pull.mjs`, which pulls
  events from the site's read-only export route into this console. It is **not deployed anywhere** — the owners install it (see its `DEPLOY-GUIDE.md`).
  Pull usage: `TRACE_EXPORT_TOKEN=… node qa/console/sources/pull.mjs --source=https://<site>/api/telemetry/export`.
* Funnels / goal completion, concurrent-edit detection, cross-module money rules, AI spend vs billing, reproduction scripts, real pseudonymous user ids
  from the app (the recorder uses an anonymous browser id), authentication for the console itself, per-user erasure.
