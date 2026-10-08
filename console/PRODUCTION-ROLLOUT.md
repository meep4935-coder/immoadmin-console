> **Superseded (2026-10-08).** This was the *plan*. The recorder it describes has since been built and packaged for the owners:
> see `qa/dist/trace-prod-package.zip` → `DEPLOY-GUIDE.md` and `HANDOVER.md`. Differences from this plan: storage is a **dedicated Supabase project**
> (`sql/telemetry.sql`); the export route is `/api/telemetry/export` (bearer token, not an admin route); there is **no** server request timing and no per-minute
> unsampled aggregates (keep sampling at 100 %); the kill switch is the Upstash key `trace:enabled`. Keep this file for the reasoning, not as instructions.

# Putting the recorder on the live site — rollout guide

**Status: a plan. Nothing in this guide has been built, deployed or switched on.** It is written for whoever approves and deploys
(Frédérick / Edouard) and for Kevin. It lists exactly what would change, what needs an owner's approval, what is still undecided,
and how to roll out and roll back safely.

Prepared 2026-10-07. Based on the local Trace Console (`qa/console/`) and recorder (`src/app/lib/trace/`), which are tested in
development only: the dev recorder is **hard-blocked in production** (`NODE_ENV === "production"` disables it), so none of it runs live today.

---

## 1. Decisions already taken

| Question | Decision |
|---|---|
| Where are live events stored? | **Not decided — build storage-agnostic**, owners choose (see §3 and §8). |
| What may be recorded about real users? | **Tier A for everyone**: errors, crashes, timings. **Tier B only after the user accepted cookies**: clicks, navigation, on-screen messages. Nothing at "full detail". |
| Server-side depth in production | **Request timing and unhandled errors only.** No wrapping of database / outside-service calls. |
| Who approves and deploys? | **Owners**. This guide only; no pull request yet. |

## 2. What is recorded

| | Tier A — all users | Tier B — only if `window.__cookieConsent === "accepted"` |
|---|---|---|
| Errors and crashes | message, stack, route, build id | — |
| Page and request timing | page-load timing; same-origin API calls: normalised route, status, duration | — |
| Slowness | long frames / slow interactions with duration and script source (no element text) | adds the element description |
| Behaviour | — | clicks (control type, label ≤ 60 chars, React component name), dead clicks, navigation |
| What the user saw | — | text of toasts and error banners (digits, e-mails, phone numbers masked, ≤ 120 chars) |
| Identity | pseudonymous user id (**HMAC** of the account id with a server secret), role, random per-tab session id | same |
| **Never recorded** | request or response bodies, query values, form input, emails, names, inputs/outputs of any function, `Authorization`/cookies | same |

The production recorder is therefore a **reduced** version of the development one. Removed in production: input/output capture, SQL/filter detail,
the arithmetic/step capture, console.error capture beyond the message, session-level click text in tier A.

## 3. Architecture

```
browser recorder (tier A, tier B if consent)  ──POST same-origin──▶  /api/telemetry  (new route)
server hooks: onRequestError, request timing  ───────────────────▶       │  validate · scrub (authoritative) · rate-limit · pseudonymise · sample
                                                                          ▼
                                                              TraceSink interface  ──▶ adapter (owners choose one)
                                                                                         ├─ SupabaseSink  (new tables, needs a migration)
                                                                                         ├─ SentrySink    (no new vendor; least detail)
                                                                                         ├─ HostedSink    (separate event store; new vendor)
                                                                                         └─ NoopSink      (default: drops everything)
local console  ◀──pull (read-only, admin-only export endpoint)──  the chosen store
```

* **Why a sink interface:** the storage choice is a vendor / cost / data-residency call (Supabase is in the US; Vercel has no persistent disk).
  Everything else can be built and tested without it, and nothing breaks if the choice is made later.
* **Server-side scrubbing is authoritative.** The browser is not trusted: the route re-applies redaction, caps sizes, and drops unknown fields.
* **Two streams, because sampling distorts rates.** If errors are kept at 100 % but normal traffic at 5 %, *error rate* computed from stored traces is
  wrong. So: (1) **unsampled aggregates** — per-minute counters and latency histograms per route and status class (tiny, always on); and
  (2) **sampled traces** — all errors/crashes/dead clicks, ~5 % of normal actions, assembled "tail-based" from a short ring buffer in the browser that is
  flushed when something goes wrong. The console must compute rates from stream 1.

## 4. Exact list of changes

**New files** (nothing here runs unless enabled)

| File | Purpose |
|---|---|
| `src/app/lib/trace/prod/config.ts` | reads the flags (below); single place that decides "is recording on, at which tier, at which sample rate" |
| `src/app/lib/trace/prod/client.ts` | production browser recorder: tier A always, tier B on consent; ring buffer + flush-on-problem; hard caps |
| `src/app/lib/trace/prod/pseudonym.ts` | `HMAC-SHA256(secret, accountId)` → `u_xxxxxxxxxx` |
| `src/app/lib/trace/prod/scrub.ts` | server-side redaction and size limits (reuses the rules in `qa/console/scrub.mjs`) |
| `src/app/lib/trace/prod/sink.ts` | `TraceSink` interface + `NoopSink` + the adapter the owners choose |
| `src/app/api/telemetry/route.ts` | the ingest route |
| `src/app/api/admin/telemetry/export/route.ts` | read-only, admin-only export that the local console pulls |
| `qa/console/sources/pull.mjs` | console adapter that pulls from the export endpoint instead of receiving pushes |
| tests for each of the above | see §9 |

**Small edits to existing files** — each needs a reviewer

| File | Edit | Risk |
|---|---|---|
| `instrumentation-client.ts` | one gated call that loads the production recorder after idle, only if the flag is on and the session is sampled | low (same pattern as today) |
| `instrumentation.ts` | `onRequestError` already exists (dev-gated); extend the gate to production; request-timing hook (see §8, open item) | medium |
| `src/app/lib/rateLimiter.ts` | add one limiter name for the ingest route (**fail-closed = drop events**, not fail-open) | low |
| `vercel.json` | one new cron: `telemetry-purge` (retention) | low |
| `cleanup-deleted-accounts` cron | also delete telemetry for the deleted account's pseudonym (deterministic, so it can be computed) | low |

**🔴 Protected file — needs Frédérick's explicit approval: `src/proxy.ts`**

`/api/telemetry` is called from public pages *and* from the signed-in portal, so it must not be blocked by the walls that exist for good reasons
elsewhere. From a read of the file (**to be re-verified by whoever edits it**), it needs adding to **two** lists:

1. `ALWAYS_OPEN_PATHS` (the founder / pre-launch lock is deny-by-default: anything not listed there is rewritten to `/pre-launch` when the lock is on),
2. `API_BILLING_EXEMPT` (otherwise accounts behind the subscription wall get **402**, and the recorder never hears from the users most likely to hit it).

Checked and **not** needed: the MFA gate. It only applies to *page* paths starting with `/portail` or `/locataire`, not to `/api/*`.
(Worth a second look by the reviewer, since an `/api` route that requires a session would be a different matter — this route accepts anonymous traffic by design.)

CLAUDE.md requires: ask first, then run `npm run test:prelaunch`. `isPortalLocked` is duplicated in `scripts/test-prelaunch-redirect.ts`, with the
`CRE-WHITELIST-START/END` block copied byte-for-byte, so any change to the lock logic must be mirrored there. The maintenance-mode page should **not**
be exempted (nothing is lost if telemetry pauses).

**Configuration (all default to OFF/safe)**

| Variable | Default | Meaning |
|---|---|---|
| `TRACE_PROD_ENABLED` | `0` | master switch |
| `TRACE_PROD_TIER_B` | `0` | allow tier B (consent-gated) at all |
| `TRACE_PROD_SAMPLE_PCT` | `0` | % of sessions that record normal traces (errors are always kept once enabled) |
| `TRACE_PSEUDONYM_SECRET` | *(none)* | **new secret**; without it the recorder refuses to start |
| `TRACE_SINK` | `noop` | which adapter |
| `TRACE_RETENTION_DAYS` | `14` | purge horizon |

**A real kill switch must not wait for a deploy.** Vercel applies environment-variable changes only to *new* deployments. For an instant off, the ingest
route should also read one remote flag (Upstash Redis is already a dependency, e.g. key `trace:enabled`, cached ~60 s) and answer `{enabled:false}`;
the recorder stops on the next response. This is an open decision (§8).

## 5. Privacy and Loi 25 checklist — needs owner / legal sign-off

*This is an engineering checklist, not legal advice.*

- [ ] Decide whether **tier A** (errors/crashes/timings, pseudonymous) can run without consent as operational monitoring, and say so in the privacy policy.
- [ ] Tier B is gated on the existing cookie choice (`window.__cookieConsent` and the `cookie-consent` event). Refusing must stop it immediately and drop the buffer.
- [ ] Pseudonymisation uses a **keyed** HMAC. Rotating the key unlinks old data; deleting the key makes it unrecoverable. Store the key like the other secrets.
- [ ] **Retention** (default 14 days) enforced by a purge job, not by hope.
- [ ] **Erasure**: account deletion removes the pseudonym's events; a data-export request can include them.
- [ ] **Where the data lives** (Supabase is `us-east-1`; CLAUDE.md already records the open residency question). Pick the store with that in mind.
- [ ] **Who can read it**: the export endpoint is admin-only (`ADMIN_EMAILS`) and should log each read.
- [ ] Update the privacy / cookie policy text.
- [ ] Session replay stays **off** (it was disabled in 2026-08 for Loi 25); nothing here records the screen.

## 6. Safety and performance budgets

* **Browser:** loaded only after the page is interactive (same approach as Sentry's deferred load in `instrumentation-client.ts`), target **≤ 15 KB gzip**
  added (to be measured, not assumed — the file's own comments record that a 447 KB script once made the portal feel slow).
* **Never throws, never blocks.** Every hook is wrapped; failures are swallowed; a full or failing queue drops events.
* **Caps:** ≤ 30 events per session per minute, batches ≤ 100 events, payload ≤ 64 KB, ring buffer ≤ 200 events, back off on 429/5xx.
* **Server:** with the decided depth (request timing + unhandled errors) there is **no wrapping of `fetch` or Supabase calls** on the live server.
* **If the sink is down**, the ingest route answers 204 and drops; it never affects a user's request.

## 7. Rollout stages, with go/no-go and rollback

| Stage | What | Watch | Go if | Roll back by |
|---|---|---|---|---|
| 0 | Vercel **preview** deployment, dev Supabase, flag on | everything in §9 | all checks pass | discard the preview |
| 1 | Merge to production with `TRACE_PROD_ENABLED=0` (dormant) | bundle size, `npm run verify`, `npm run test:prelaunch`, **zero** telemetry requests with the flag off | no behaviour or size change | revert the merge |
| 2 | On for **founder accounts only** | ingest volume, errors in the ingest route, page speed | a week with no regression | remote flag off |
| 3 | **1 %** of sessions, tier A | Core Web Vitals, error rate (unchanged), ingest cost | stable for a few days | remote flag off |
| 4 | 10 % → 100 % of tier A | same | stable at each step | remote flag off |
| 5 | Tier B (consent-gated) | consent handling, privacy scan (§9) | privacy sign-off done | `TRACE_PROD_TIER_B=0` |
| 6 | Turn on **absence detection** for crons (needs server timing or cron instrumentation, §8) | missed-run alerts make sense | no false alarms for a week | disable in `expectations.json` |

## 8. Open decisions and unverified assumptions

| # | Open item | Owner |
|---|---|---|
| 1 | **Storage**: Supabase tables / Sentry / separate store (cost, vendor, US residency) | Frédérick / Edouard |
| 2 | **Instant kill switch** mechanism (remote flag in Upstash vs something else) | Frédérick / Edouard |
| 3 | Tier A without consent: acceptable? Retention period? Wording in the policy | owners / legal |
| 4 | **Server request timing on Vercel is unverified.** The dev recorder hooks `http.Server.emit`; whether that fires for requests on Vercel's runtime is untested. Fallback if not: unhandled errors + browser-measured timings only | to test on a Preview deployment |
| 5 | How the console sees **cron runs** (needed for absence detection): server timing, or one-line heartbeat calls inside each cron | after (4) |
| 6 | Who may read the console and the export | owners |

**Verified vs assumed.** Verified by reading the code: the cookie consent global and event exist; `proxy.ts` has the founder lock
(`ALWAYS_OPEN_PATHS`), the subscription wall (`API_BILLING_EXEMPT`) and a mirrored guard test, and the MFA gate does not cover `/api`; rate limiters are
named and central; the dev recorder is production-gated. **Not verified:** that those two lists are the *only* things that could block the route,
Vercel runtime behaviour, the browser-size budget, and any legal question. (One claim in an earlier draft of this guide — that MFA needed an
exemption — was wrong and has been corrected; treat the `proxy.ts` section as a starting point for the reviewer, not as proof.)

## 9. Test plan before any user is recorded

1. **Flag off = no effect**: zero `/api/telemetry` requests, identical bundle size, `npm run verify` and `npm run test:prelaunch` green.
2. **Privacy scan**: send ≥ 1,000 realistic events through the route and automatically assert that no stored field contains an e-mail, phone number,
   UUID of another account, token, JWT, `Authorization`, cookie, or free text beyond the allowed fields.
3. **Consent**: with `refused`, tier B events are never produced; withdrawing consent mid-session drops the buffer.
4. **Load**: the route sustains ≥ 200 events/s with the sink slow or down, and still answers fast.
5. **Failure**: kill the sink, the rate limiter, and the secret; a user's page and API calls are unaffected in every case.
6. **Kill-switch drill**: flip the remote flag; recorders stop within ~60 s.
7. **Walls**: the route answers correctly for an anonymous visitor, a signed-in owner, a tenant, an unpaid account, and a user mid-MFA.
8. **Sampling maths**: the console's error rate and latency percentiles match the unsampled aggregates.

## 10. What will **not** be done without the owners

Push to `main`; edit `src/proxy.ts`; apply a migration; set or rotate an environment variable or secret in Vercel; switch the recorder on for any user.

## 11. Suggested order of work once approved

1. Owners decide §8 items 1–3.
2. Build `config`, `pseudonym`, `scrub`, `sink` (with `NoopSink`), the ingest route and its tests, plus the console pull adapter — all dormant.
3. Preview deployment, §9 tests 1–8, **including item 4 (server timing on Vercel)**.
4. Owners review the `proxy.ts` edit; stage 1 → 6.

Rough size: the dormant build is a few days of focused work; the preview validation and the privacy/legal pieces are what set the calendar.
