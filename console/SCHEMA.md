# Span format (what senders POST to `/ingest`)

The console stores **spans**. A *span* is one thing that happened (a click, a request,
a database query, a calculation…) with a start time, a duration, a status and a parent.
Spans that share a `trace_id` form one **trace** = one user action and everything it caused.
Parent links make it a tree, which is how the UI shows *what ran, in what order, inside what*.

```
POST http://127.0.0.1:4317/ingest          header (only if the console has a token):  x-trace-token: <token>
{ "spans": [ { …span… }, … ] }              max 500 spans / batch, 2 MB body
```

Response: `{ "accepted": n, "rejected": [{ "index": i, "reason": "…" }] }`.
Span `id` is the primary key (`INSERT OR REPLACE`), so **retrying a batch is safe**.

## Fields

| field | type | required | notes |
|---|---|---|---|
| `id` | string ≤64 | yes | unique per span |
| `trace_id` | string ≤64 | yes | shared by every span of one user action. The browser creates it on the click/navigation and sends it on every request (header `x-trace-id`) so the server's spans join the same trace |
| `parent_id` | string \| null | | id of the span that caused this one; `null` = root |
| `ts` | number | yes | **start time, epoch milliseconds** (fractions allowed) |
| `dur` | number ≥0 | | duration in ms. Omit for instant events |
| `kind` | enum | yes | see below; unknown values become `fn` |
| `name` | string ≤200 | yes | human-readable: `Click: Save lease`, `POST /api/portal-kv/mutate`, `upsert tenant_units`, `calculerAugmentationLoyer` |
| `status` | `ok` \| `error` \| `slow` \| `dead` | | default `ok`. Sending an `error` object forces `error` (unless `dead`). `slow` is derived at ingest from `dur` and the per-kind limit in `config.mjs`. `dead` = a click that did nothing |
| `user_id` | string ≤64 | | **pseudonymous** id (e.g. an HMAC of the Supabase user id) — never an email or name |
| `session_id` | string ≤64 | | one browser session |
| `role` | `owner` \| `tenant` \| `delegate` \| `admin` \| `anonymous` | | |
| `route` | string ≤200 | | page path for browser spans, API path for `net.server` spans |
| `source` | string ≤16 | | `browser`, `server`, … |
| `attrs` | object | | free-form details; see conventions below. ≤64 KB after scrubbing |
| `error` | object | | `{ name, message, stack?, code?, cause?: [{ name, message, stack? }] }` — `cause` is outermost → innermost |
| `app_version`, `env` | string | | |

### `kind`

`ui.click` · `ui.input` · `ui.nav` · `render` · `longtask` · `net.client` · `net.server` · `db` · `external` · `calc` · `fn` · `invariant` · `log` · `error` · `crash` · `health`

* `health` spans are a recorder's heartbeat (`attrs: {dropped, sent, queued, client_now, skew_ms?}`). The console stores them apart from spans, so they
  never appear as user activity; they feed **Recorder health** and its alerts.
* A `render` span named `Message affiché : …` (with `attrs: {text, type}`) is a toast or banner the user saw. A `ui.click` with
  `attrs.feedback_tracked: true` opts in to the **no_feedback** / **false_success** checks.
* `attrs.host` on `external` / `db` spans feeds the **Dependencies** page.
* `invariant` spans are an application assertion that failed (`traceInvariant`). They become a **critical finding**.
* A `calc` span whose `steps` don't add up (or whose `output` differs from the last step) is **automatically** turned into an
  `InvariantViolation` error and a finding — the console re-computes `+ − × ÷ ( )` and `round(x, n)`.
* For `db` spans, `attrs.op`, `attrs.table`, `attrs.filters` (e.g. `{owner_id: "eq.…"}`) and `attrs.input` feed the isolation and
  duplicate-write checks. At ingest the console adds `attrs._owners` (hashed owner ids) and `attrs._write_hash`, which survive
  `--mode=prod` scrubbing.

* `net.server` spans (one per handled request, `route` = the API path) drive the request counts, error rate, latency percentiles and the route alerts.
* `crash` spans (render crash, unhandled exception, process crash) open a **critical** alert immediately.

### `attrs` conventions the UI understands

| key | rendered as |
|---|---|
| `steps: [{ label, expr?, result? }]` | **How it was computed** — numbered lines, e.g. `add the two operands · 1 + 1 → 2` |
| `expr` | the expression, when there are no steps |
| `input` / `inputs` / `args` | **Input** block |
| `output` / `result` | **Output** block |
| anything else | **Other details** (SQL-ish ones: `op`, `table`, `filters`, `rows`, `status`; UI ones: `target {tag,text,component,handler}`; etc.) |

Example — the “1 + 1” trace:

```json
{ "id":"sp_2", "trace_id":"t_1", "parent_id":"sp_1", "ts":1790878000001, "dur":0.2,
  "kind":"calc", "name":"add(1, 1)",
  "attrs": { "inputs": {"a":1,"b":1},
             "steps": [ { "label":"add the two operands", "expr":"1 + 1", "result":2 } ],
             "output": 2 } }
```

## Privacy / redaction (applied at ingest, whatever the sender did)

* **Always:** values under keys like `authorization`, `cookie`, `password`, `secret`, `token`, `api_key`, `otp`, `card_number`… become `[redacted]`; JWTs, Stripe/Anthropic/`ima_live_` keys and `Bearer …` strings are replaced.
* **`--mode=dev` (default):** everything else is kept verbatim (full inputs/outputs).
* **`--mode=prod`:** additionally strings are cut at 200 chars, e-mails and phone numbers are masked, and payload-like keys (`input`, `output`, `args`, `result`, `body`, `rows`, `filters`, `steps`…) are reduced to their **shape** (types / lengths) instead of values.

## How errors are grouped

`fingerprint = sha1(error name | message with numbers and UUIDs removed | first app stack frame | kind)`.
The **Errors** page counts only *root causes* — an error span with no failing child — so one failed action
(UI → request → route → database, four failing spans) is **one** error, attributed to the layer where it began.
