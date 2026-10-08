# Deploying the ImmoAdmin recorder to the live site — step by step

For: whoever has write access to the main repository, Vercel and Supabase (Frédérick / Edouard).
Prepared by Kevin's assistant, 2026-10-08. Read **§0** first, then follow **§2 → §9** in order.

> **Nothing in this package runs, or changes any behaviour, until you set environment variables on Vercel.**
> You can install it, deploy it and leave it asleep indefinitely. The first deploy is *dormant*.

---

## 0. What this is, and what has and has not been proven

**What it does.** It records, for real users, *technical* events: errors and crashes, how long page loads and API calls take, and — only for
visitors who accepted cookies and only if you switch it on — clicks, navigation and on-screen error messages. The events are stored in a
**separate** Supabase project, and a developer reads them in the local **Trace Console** to find the root cause of bugs.

**What it never records:** request or response bodies, form input, query-string values, emails, phone numbers, names, amounts, addresses,
document contents, cookies or tokens. Everything is filtered on the **server** by a whitelist before it is stored; the browser is not trusted.
Users are identified only by a keyed hash (HMAC) of their account id.

**Proven (tested by the person who prepared this, 2026-10-08):**

| Check | Result |
|---|---|
| 63 unit tests of the recorder (privacy filter, consent, sampling, kill switch, rate limits, failures) | pass |
| 1,000 hostile events (emails, phones, tokens, JWTs, passwords…) pushed through the filter | none stored |
| `tsc --noEmit` after installing into a clean copy of the repository | clean |
| Installer: dry-run, install, **undo** → working tree byte-identical to the original | pass |
| `npm run test:prelaunch` (protected lock) with the proxy patch applied | 21/21 |
| Real Next.js server, dormant: `GET /api/telemetry` → `enabled:false`; a POST is refused; export closed | pass |
| Real Next.js server, active (storage = a local stand-in for Supabase): event accepted → stored → read back by the export route; wrong token → 401 | pass |
| Real browser on `/connexion`: recorder started, an unhandled error and a failing API call were stored; the e-mail, phone number, URL token and password I planted were **not** | pass |
| Console pull adapter: 23 tests incl. a real console and a fake export server | pass |
| Full repository guard run, before vs after install | **see `HANDOVER.md` §"Guards"** |

**NOT proven — you must check these on a Preview deployment before Production:**

1. **Storage.** The tests used a local stand-in for PostgREST, not a real Supabase project. `sql/telemetry.sql` has not been run on a real database.
2. **Identity.** The route reads the user from the Supabase auth cookie with `getSession()`. That works in the code path tested here with *no* cookie
   (anonymous). Confirm on Preview that a signed-in user gets a `user_ref` (the smoke test's anonymous event will show `null`; log in and use the site, then look at the table).
3. **Vercel runtime.** Everything above ran on `next dev`. Behaviour on Vercel's runtime (cold starts, the 2.5 s storage timeout, Upstash rate limiter) is untested.
4. **Server request timing is not included.** Server side you get *unhandled errors* only (`onRequestError`). Timings come from the browser (page load, same-origin API calls).
   Cron-run absence detection in the console therefore stays off.
5. **4xx responses** (e.g. a 404 or 422 from your own API) are stored with their status in the event data but are **not flagged as errors**; only 5xx and network failures are.
   The console can show them in a trace; its alerts will not fire on them.
6. **Bundle size** has not been measured. With `NEXT_PUBLIC_TRACE_PROD` unset the recorder is not in the bundle at all; measure once with it set (the file comments in
   `instrumentation-client.ts` record that a 447 KB script once made the portal feel slow).
7. **Sampling and rates.** With `TRACE_PROD_SAMPLE_PCT` below 100, error *rates* in the console describe the sampled traffic only (errors are always sent). Keep it at 100 while the user base is small.
8. **Legal.** This is an engineering package, not legal advice. See §9 before switching on anything beyond "founders only".
9. **Account deletion is not wired.** `deleteTelemetryForUser(userId)` exists but `cleanup-deleted-accounts` does not call it yet (§8). Until you add that one line, erasure is covered only by the 14-day retention.

---

## 1. What is in the package

```
trace-prod-package/
├─ HANDOVER.md                  one page: what to decide and who does what
├─ DEPLOY-GUIDE.md              this file
├─ install/
│   ├─ apply.mjs                the installer (dry-run, install, undo)
│   └─ smoke-test.mjs           checks a deployed URL (dormant or active)
├─ app/                         the new files, laid out exactly as in the repository
│   └─ src/app/{lib/trace, api/telemetry, api/cron/telemetry-purge}
├─ patches/
│   ├─ 01-instrumentation-cron-guard.patch        4 existing files: instrumentation.ts, instrumentation-client.ts, vercel.json, + the RBAC-coverage guard allowlist
│   └─ 02-proxy-PROTEGE-approbation-requise.patch   src/proxy.ts + its test mirror — PROTECTED, see §5
├─ sql/telemetry.sql            the table, for the separate telemetry Supabase project
├─ env/.env.example.telemetry   every variable, explained, no secrets
├─ console/                     the Trace Console (runs on a developer's machine, not on the server)
└─ MANIFEST.sha256              checksums; the installer refuses a tampered or incomplete package
```

---

## 2. Before you start

* **Node ≥ 22.5** on the machine that runs the installer and the console (Node 24 was used).
* A **git clone of the real repository** with a clean working tree on the files concerned, on a **new branch** (never straight on `main`).
* The repository must be the same generation as the one the patches were made from. If `apply.mjs` says a patch does not apply, see §4 (manual fallback).
* Decisions to take (see `HANDOVER.md`): storage region, who may read the console, the legal wording, and who approves the `proxy.ts` change.

---

## 3. The short path (about 30 minutes, none of it risky)

```bash
# 0. In the repository: start from a clean tree on a NEW branch (never straight on main)
git checkout -b feat/telemetry-recorder

# 1. Unzip the package next to the repository, then from the package folder:
node install/apply.mjs --repo=<path to the repository> --dry-run      # shows exactly what would happen; writes nothing
node install/apply.mjs --repo=<path to the repository> --verify       # installs + runs tsc and the recorder's 63 tests
```

`--verify` is optional (takes a few minutes). The installer **does not commit, push, or touch `src/proxy.ts`** unless you add `--with-proxy` (see §5).

```bash
# 2. In the repository:
git diff                                    # 4 existing files changed (about 33 added lines, 1 replaced); new files: git status
git add -A -- . ":!.trace-install.json" && git commit -m "feat: telemetry recorder (dormant)"   # guards want a committed tree (see §4)
npm run verify                              # the project's guards — compare with your usual baseline (see HANDOVER.md "Guards")
npm run test:prelaunch                      # the protected lock test
```

Then: create the telemetry database (§6) → deploy **dormant** to Preview (§7) → smoke-test (§7) → switch on for founders (§7).

Undo at any time before you commit: `node install/apply.mjs --repo=<path> --undo` (files and patches are removed; anything you edited since is left alone and reported).
`.trace-install.json` in the repository root records what was installed — **do not commit it**; add it to `.gitignore` or delete it after you commit.

---

## 4. What the installer does, and the manual fallback

It checks, **before writing anything**: the package checksums; that the repository is a Next.js project with the expected files; that the files it will touch have no uncommitted
changes; that none of the 13 new files already exists with different content; and that each patch applies. Any failure stops it with a plain explanation and changes nothing.

Changes to **existing** files (all inert while the flags are off):

| File | Change |
|---|---|
| `instrumentation.ts` | adds `onRequestError`. First line returns immediately unless `TRACE_PROD_ENABLED=1` (and Node runtime). Wrapped in `try/catch`; never affects a request. |
| `instrumentation-client.ts` | adds a block guarded by `process.env.NEXT_PUBLIC_TRACE_PROD === "1"`. That variable is inlined at **build** time: unset ⇒ the block and the recorder are removed from the bundle. Set ⇒ the recorder loads when the browser is idle, then asks the server whether to record. |
| `vercel.json` | adds one cron: `/api/cron/telemetry-purge` daily at 04:00 UTC (retention). |
| `scripts/test-rbac-p3-gate-coverage-2026-06-19.ts` | adds `telemetry` and `telemetry/export` to that guard's `ALLOWLIST`, each with its reason. **Required:** the guard fails on any `/api` route that has neither a recognised gate nor an allowlist entry (found when the full guard run was done on a clean install). |

**Run the guards after you commit, not before.** `test-aucun-residu-de-banc.ts` fails by design while a file under `src/` has uncommitted changes (it failed on the prepared copy only because
`src/proxy.ts` was modified and not yet committed; see HANDOVER "Guards").

**If a patch does not apply** (the repository moved on since the package was made): the changes are small. Open the `.patch` files — they are plain text — and make the same edits by hand,
then copy the folders under `app/` into the repository. Run `npm run verify`. (The installer's `--undo` will not know about hand edits.)

---

## 5. 🔴 The protected file: `src/proxy.ts` (needs Frédérick's explicit approval)

`/api/telemetry` must be reachable (a) by visitors who are not signed in (login-page errors are the ones you most want to see), (b) while the founder / pre-launch lock is on, and
(c) by accounts behind the subscription wall (otherwise they receive a 402 and you hear nothing from the users most likely to be struggling). The patch adds `"/api/telemetry"` to
the existing lists `ALWAYS_OPEN_PATHS` and `API_BILLING_EXEMPT` (+1 line in each) and mirrors the first one in `scripts/test-prelaunch-redirect.ts`, as `CLAUDE.md` requires.
It is **3 added lines**, no logic change.

The MFA gate does not need an exemption (it only covers page paths, not `/api`). The maintenance-mode page is deliberately **not** exempted.

Apply it only with approval, in the same command, naming the approver:

```bash
node install/apply.mjs --repo=<path> --with-proxy --approved-by="<name>"
npm run test:prelaunch          # must stay green (it was 21/21 on the prepared copy)
```

If approval comes later, run `--undo` and re-install with `--with-proxy` (the installer installs everything in one go).
Without the patch the recorder is **dormant-safe**: it simply cannot reach `/api/telemetry` when the lock or the wall is on, and the smoke test will say so.

---

## 6. Create the telemetry database (Supabase, separate project)

1. Create a **new** Supabase project dedicated to telemetry. Pick a Canadian region if one is available to you (Loi 25 residency). **Do not use the main database.**
2. SQL editor → paste and run `sql/telemetry.sql`. It is idempotent. It creates `telemetry_events`, indexes, and enables RLS **with no policies** (only the service-role key can read or write).
3. Check (the last lines of the file): `relrowsecurity = true`, and `0` policies.
4. Keep for §7: the project URL and the **service-role** key of this telemetry project.

This is *not* a migration of the main project: do not copy `telemetry.sql` into `supabase/migrations/`.

---

## 7. Deploy and switch on, in stages

Environment variables are listed, with comments, in `env/.env.example.telemetry`. **Generate two new secrets** (any machine with Node):

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"     # run twice: TRACE_PSEUDONYM_SECRET and TRACE_EXPORT_TOKEN
```

Store them like your other secrets. Losing `TRACE_PSEUDONYM_SECRET` only unlinks old data from users (fine); leaking it lets someone confirm whether a given account id appears in the data (rotate it).

Vercel applies variable changes only to the **next deployment** — and `NEXT_PUBLIC_TRACE_PROD` is read at build time, so changing it needs a fresh build.

| Stage | Where | Variables | Then |
|---|---|---|---|
| **0 Dormant** | Preview, then Production | none (or `TRACE_PROD_ENABLED=0`) | `node install/smoke-test.mjs --url=<preview url> --expect=off` → all ✓. Also check `npm run verify`, page speed unchanged. |
| **1 Founders** | **Preview first** | `TRACE_PROD_ENABLED=1`, `NEXT_PUBLIC_TRACE_PROD=1`, `TRACE_PSEUDONYM_SECRET`, `TRACE_SINK=supabase`, `TRACE_SUPABASE_URL`, `TRACE_SUPABASE_SERVICE_KEY`, `TRACE_PROD_SAMPLE_PCT=100`, `TRACE_PROD_ALLOWLIST=<founder emails>`, `TRACE_EXPORT_TOKEN` | Use the Preview signed in as a founder; trigger a real error; confirm rows in `telemetry_events` with a non-null `user_ref`. Then the same on Production. |
| **2 Everyone, tier A** | Production | empty `TRACE_PROD_ALLOWLIST`; keep `SAMPLE_PCT=100` while < a few thousand sessions | watch the rows/day, storage size, page speed for a week |
| **3 Tier B** (clicks, navigation, messages) | Production | `TRACE_PROD_TIER_B=1` | **only after the legal review (§9).** Still requires each visitor's cookie consent; a visitor who refuses or withdraws stops tier B immediately. |

Smoke test of an **active** deployment (the event it sends is synthetic and named `SMOKE-TEST …`):

```bash
TRACE_EXPORT_TOKEN=<the token> node install/smoke-test.mjs --url=https://<preview or site> --expect=on
```

If the Preview is behind Vercel's deployment protection, set `VERCEL_AUTOMATION_BYPASS_SECRET` (Vercel → Settings → Deployment Protection) in your shell first.
During stage 1 the allowlist rejects the anonymous smoke event — the script says so and skips the rest; that is expected.

Common failures the script names: HTTP 3xx/401/403 → the proxy patch is missing; `dropped > 0` → storage refused the write (wrong URL/key, or `telemetry.sql` not run);
`enabled=false` although you set the flag → `TRACE_PSEUDONYM_SECRET` shorter than 16 characters, or the visitor is not on the allowlist.

**The off switches**

| Speed | How | Effect |
|---|---|---|
| **Instant (≤ 60 s), no deploy** | In Upstash Redis (already a project dependency) set the key `trace:enabled` to `0` | every recorder stops on its next response and the server stops accepting. Delete the key (or set `1`) to resume. |
| Next deploy | `TRACE_PROD_ENABLED=0` | server and `onRequestError` stop; browsers already loaded stop on their next response. |
| Next build | unset `NEXT_PUBLIC_TRACE_PROD` | the recorder is gone from the bundle. |
| Full removal | `node install/apply.mjs --repo=<path> --undo` (before commit) or `git revert` | back to the original code. Optionally drop the `telemetry_events` table. |

A Redis outage does **not** switch the recorder off by itself (it keeps its previous decision); it never affects a user's request either way.

---

## 8. Account deletion (Loi 25) — one line to add

`src/app/api/cron/cleanup-deleted-accounts/route.ts` should call, for each account it deletes:

```ts
import { deleteTelemetryForUser } from "@/app/lib/trace/prod/server";
// … inside the loop, after the account is removed (it never throws; returns the number of rows deleted):
await deleteTelemetryForUser(userId);
```

The pseudonym is recomputed from the id and the secret, so no lookup table is needed. This was **not** applied by the installer because that cron is outside the recorder's scope and
you should review it. Until it is applied, deleted accounts' events disappear only through the retention purge (default 14 days, set `TRACE_RETENTION_DAYS`, max 90).

---

## 9. Privacy and Loi 25 — checklist for the owners (not legal advice)

- [ ] Decide whether **tier A** (errors, crashes, timings, pseudonymous) may run without consent as operational monitoring, and state it in the privacy policy.
- [ ] Tier B is gated by the existing cookie choice (`window.__cookieConsent` and the `cookie-consent` event); refusing or withdrawing stops it and drops the buffer.
- [ ] Update the privacy / cookie policy wording.
- [ ] Residency: choose the telemetry project's region knowingly (CLAUDE.md already records the open question for the main project).
- [ ] Retention: 14 days by default and enforced by the daily purge cron, not by hope. Confirm the cron appears in Vercel → Cron Jobs after deploy.
- [ ] Access: the export route is closed unless `TRACE_EXPORT_TOKEN` (≥ 24 chars) is set; who holds the token and the Supabase key is who can read the data.
- [ ] Error message text is kept by default (needed to diagnose). A message can in principle carry a free-text secret that no filter can recognise (known limit; emails, phones, tokens,
      JWTs and URL query values are masked). To keep only the error type and location: `TRACE_PROD_ERROR_MESSAGE=0`.
- [ ] Button/message **text** capture is off (`TRACE_PROD_CLICK_TEXT`, `TRACE_PROD_MESSAGE_TEXT` default `0`) because a label can contain a person's name. Leave it off.
- [ ] Session replay stays off (nothing here records the screen).

---

## 10. Reading the data: the Trace Console (on a developer's machine)

```bash
# terminal 1 — the console (loopback only, http://127.0.0.1:4317)
node console/server.mjs --mode=prod

# terminal 2 — pull production events into it (every 15 s; resumes where it stopped)
TRACE_EXPORT_TOKEN=<the token> node console/sources/pull.mjs --source=https://<your site>/api/telemetry/export
```

`--mode=prod` makes the console treat data as production (values truncated, extra masking). The token is read from the environment only, never from an argument.
The pull is read-only and never writes to the site. Pages, alerts, findings, bug reports and the digest are described in `console/README.md`.
Run `node console/test-all.mjs` to confirm the console itself works on that machine (all suites should pass).

---

## 11. Troubleshooting

| Symptom | Likely cause |
|---|---|
| `apply.mjs`: "Paquet altéré" | the zip was modified or partly extracted — re-extract / re-request it |
| `apply.mjs`: files "have uncommitted changes" | commit or stash first; the install is meant to be one reviewable diff |
| `apply.mjs`: a patch "ne s'applique pas" | the repo moved on — §4 manual fallback |
| smoke test: HTTP 3xx / 401 / 403 on `/api/telemetry` | proxy patch not applied (§5), or Preview protection (set `VERCEL_AUTOMATION_BYPASS_SECRET`) |
| smoke test: `dropped > 0` | `TRACE_SINK` not `supabase`, wrong URL/key, `telemetry.sql` not run, or the telemetry project is paused |
| no rows although enabled | `NEXT_PUBLIC_TRACE_PROD` was added without a **new build**; or sampling < 100 and no error occurred |
| rows but `user_ref` always null | the Supabase auth cookie is not readable by the route — check the cookie name/domain used by your auth setup |
| console shows nothing | `pull.mjs` message says what failed: 404 = export disabled (`TRACE_EXPORT_TOKEN` missing/short), 401 = token mismatch |

Anything else: send the output of the failing command to whoever prepared the package.
