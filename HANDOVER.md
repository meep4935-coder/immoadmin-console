# Handover — ImmoAdmin production recorder

**One page for the people who approve and deploy.** The full procedure is `DEPLOY-GUIDE.md`.

## What you are being handed

A recorder that tells developers **why** something broke on the live site (errors, crashes, slow pages and API calls), and a local console that shows it.
It is **off by default**: installing and deploying it changes nothing for any user. It switches on only when you set environment variables, and it can be
switched off again in under a minute without a deploy.

## What it touches

| | |
|---|---|
| New files | 13 (all under `src/app/lib/trace/`, `src/app/api/telemetry/`, `src/app/api/cron/telemetry-purge/`) |
| Existing files edited | `instrumentation.ts`, `instrumentation-client.ts`, `vercel.json` (one new daily cron), and `scripts/test-rbac-p3-gate-coverage-2026-06-19.ts` (2 allowlist entries with reasons, which that guard requires for any new /api route) — ~33 lines, runtime code all gated by flags |
| 🔴 Protected file | `src/proxy.ts` (+1 line in two lists) and its test mirror — **separate patch, applied only with `--with-proxy --approved-by="<name>"`** |
| Database | a **new, separate** Supabase project (`sql/telemetry.sql`). The main database is never read or written. |
| New secrets | `TRACE_PSEUDONYM_SECRET`, `TRACE_EXPORT_TOKEN`, and the telemetry project's service key — all set by you on Vercel; none are in the package |
| Removal | `node install/apply.mjs --repo=<path> --undo` before committing, or `git revert` after |

## Decisions you need to make (nobody else can)

1. **Approve (or refuse) the `proxy.ts` patch.** Without it the recorder cannot reach `/api/telemetry` while the founder lock or subscription wall is on.
2. **Which Supabase region** for the telemetry project (Loi 25 residency).
3. **Tier A without consent** (errors/timings, pseudonymous): acceptable as operational monitoring? Retention period (default 14 days)? Privacy-policy wording.
4. **Tier B** (clicks, navigation, messages): only after the above and only with each visitor's cookie consent. Leave off until decided.
5. **Who holds the export token and the telemetry service key** (that is who can read the data).
6. **Wire account deletion** (`DEPLOY-GUIDE.md` §8, one line in `cleanup-deleted-accounts`).

## Who does what

| Who | What |
|---|---|
| Kevin | hands over the zip; can run the console once data flows; cannot deploy (no access to the live repository / Vercel) |
| Owner / developer with repo access | installs (`install/apply.mjs`), reviews `git diff`, runs the project's guards, opens the PR |
| Frédérick | approves `proxy.ts`, privacy decisions |
| Whoever manages Vercel + Supabase | creates the telemetry project, runs `sql/telemetry.sql`, sets variables, runs the smoke test, flips stages |

## Order of operations (details in the guide)

1. New branch → `apply.mjs --dry-run` → `apply.mjs --verify` (add `--with-proxy --approved-by=…` once approved) → `git diff` → `npm run verify` → `npm run test:prelaunch`.
2. Create the telemetry Supabase project → run `sql/telemetry.sql`.
3. Deploy **dormant** to Preview → `smoke-test.mjs --expect=off`.
4. Add the variables on **Preview** (founders only) → rebuild → `smoke-test.mjs --expect=on` → use the site signed in → check rows.
5. Same on Production for founders → a week → open to everyone (tier A) → decide tier B.

## Guards (the project's own `npm run verify` family)

Measured on a clean copy of the repository (the clone this package was prepared from) with the package installed, 2026-10-08:

| Check | Result |
|---|---|
| Full guard run (`scripts/run-guards.ts`, 2,011 guards) | 25 red |
| Same 25 guards re-run on the **untouched** copy | **23 are red there too, with identical failing checks** — inherited, not caused by this package (the versioned baseline `guards-baseline.json` is dated 2026-09-09 and is stale: the verifier lists these as "regressions" against it) |
| `test-aucun-residu-de-banc` | red **only while the install is uncommitted** (it demands a clean `src/`); green after `git commit` — verified |
| `test-rbac-p3-gate-coverage` | **was a real failure**: `/api/telemetry` and `/api/telemetry/export` had no gate or allowlist entry. Fixed in `patches/01-…` (two allowlist entries with reasons); green after a fresh install — verified |
| Full `vitest run` | 8,593 passed, 1 failed (`importPalier200.test.ts`) — **the same single failure on the untouched copy** |
| `npm run test:prelaunch` | 21/21 with the proxy patch |
| `tsc --noEmit` | clean |

Not re-run after the allowlist fix: the *whole* guard suite (only the 25 red guards were, plus the two affected ones). The change was two allowlist lines.
**Do the same on your real repository:** run `npm run verify` on your branch *before* installing and again *after* committing, and compare. The inherited reds in your copy may differ from the ones above.

## What is not proven (honest list — the guide §0 has the detail)

* Never run against a **real Supabase project** or on **Vercel's runtime** — only on a local Next.js server with a stand-in database. Do stage 0–1 on Preview first.
* **Server-side request timing is not included**; server side records unhandled errors only. 4xx responses are stored but not flagged as errors.
* **Bundle-size impact** with the recorder enabled was not measured.
* **Signed-in identity** (`user_ref`) must be confirmed on Preview.
* **Legal review** is yours.

## If something looks wrong

Set the Upstash key `trace:enabled` to `0` (stops everything within ~60 s, no deploy). Then `DEPLOY-GUIDE.md` §7 "off switches" and §11 "troubleshooting".
