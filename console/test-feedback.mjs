#!/usr/bin/env node
/** What the user was told versus what happened: silent failures and false successes. */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { cfg } from "./config.mjs";
import { openStore } from "./store.mjs";
import { normalizeSpan } from "./ingest.mjs";
import { detectFeedback } from "./detectors.mjs";
import { analyzeFeedback } from "./pipeline.mjs";

let pass = 0, fail = 0;
const check = (name, ok, extra = "") => { ok ? pass++ : fail++; console.log(`${ok ? "  ✓" : "  ✗ FAIL"} ${name}${ok ? "" : "  " + extra}`); };
const eq = (name, a, b) => check(name, JSON.stringify(a) === JSON.stringify(b), `got ${JSON.stringify(a)} expected ${JSON.stringify(b)}`);
const rules = (fs_) => fs_.map((f) => f.rule).sort();

let n = 0;
const sp = (o) => ({ id: `s${++n}`, trace_id: "t", ts: 1_000_000 + n * 10, dur: 10, status: "ok", user_id: "u", session_id: "ss", ...o });
const click = (extra = {}, attrs = {}) => sp({ id: "root", kind: "ui.click", name: "Clic : Enregistrer", attrs: { target: { text: "Enregistrer" }, feedback_tracked: true, ...attrs }, ...extra });
const call = (status = "error") => sp({ kind: "net.client", name: "POST /api/save", parent_id: "root", status, error: status === "error" ? { name: "HttpError", message: "500" } : undefined });
const msg = (type, text) => sp({ kind: "render", name: `Message affiché : ${text}`, parent_id: "root", attrs: { text, type } });

console.log("\nsilent failures");
eq("failed + a visible error message → fine", detectFeedback([click({ status: "error" }), call(), msg("error", "Impossible d'enregistrer")]), []);
eq("failed and the user saw NOTHING → no_feedback", rules(detectFeedback([click({ status: "error" }), call()])), ["no_feedback"]);
check("…and it names what failed", /POST \/api\/save/.test(detectFeedback([click({ status: "error" }), call()])[0].detail));
eq("succeeded with no message → nothing to say", detectFeedback([click(), call("ok")]), []);
eq("a recorder WITHOUT message tracking is not judged (can't tell 'none shown' from 'not recorded')", detectFeedback([click({ status: "error" }, { feedback_tracked: false }), call()]), []);
eq("a click that failed with no failing request/query (nothing to blame) is not reported", detectFeedback([click({ status: "error" })]), []);

console.log("\nfalse successes");
eq("told 'saved' but the request failed → false_success (critical)", detectFeedback([click({ status: "error" }), call(), msg("success", "Bail enregistré")]).map((f) => [f.rule, f.severity]), [["false_success", "critical"]]);
check("…quoting what the user was told", /Bail enregistré/.test(detectFeedback([click({ status: "error" }), call(), msg("success", "Bail enregistré")])[0].detail));
eq("told 'saved' and it did succeed → fine", detectFeedback([click(), call("ok"), msg("success", "Bail enregistré")]), []);
eq("an error message after a failure is not a false success", rules(detectFeedback([click({ status: "error" }), call(), msg("error", "Échec")])), []);
eq("a status/info message is not treated as a success claim", detectFeedback([click({ status: "error" }), call(), msg("status", "Chargement…")]).filter((f) => f.rule === "false_success"), []);

console.log("\ntiming (analyzeFeedback runs later than ingest)");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "console-feedback-"));
const store = openStore(path.join(tmp, "f.db"));
const NOW = Date.now();
const put = (spans) => store.insertSpans(spans.map((s) => normalizeSpan(s, cfg).row));
let tseq = 0;
const trace = (ts, { message = false, tracked = true } = {}) => {
  const tid = `tt${++tseq}`;
  const base = { trace_id: tid, user_id: "u", session_id: "ss" };
  const spans = [
    { ...base, id: `r${tseq}`, ts, dur: 900, kind: "ui.click", name: "Clic : Payer", status: "error", attrs: { feedback_tracked: tracked } },
    { ...base, id: `c${tseq}`, parent_id: `r${tseq}`, ts: ts + 5, dur: 300, kind: "net.client", name: "POST /api/pay", error: { name: "HttpError", message: "502" } },
  ];
  if (message) spans.push({ ...base, id: `m${tseq}`, parent_id: `r${tseq}`, ts: ts + 400, kind: "render", name: "Message affiché : Paiement refusé", attrs: { text: "Paiement refusé", type: "error" } });
  put(spans);
};
trace(NOW - 3000);                 // only 3 s old: the message might still be on its way
eq("a 3-second-old failure is NOT judged yet (its message may still be in flight)", analyzeFeedback(store, NOW).length, 0);
eq("…but is judged once it is old enough", analyzeFeedback(store, NOW + 10_000).map((f) => f.rule), ["no_feedback"]);
eq("judging twice does not duplicate the finding", analyzeFeedback(store, NOW + 20_000).length, 0);
trace(NOW - 20_000, { message: true });
eq("an old failure that DID show a message is fine", analyzeFeedback(store, NOW).filter((f) => f.title.includes("Payer")).length, 0);
trace(NOW - 30_000, { tracked: false });
eq("an old failure from an untracked recorder is not judged", analyzeFeedback(store, NOW).length, 0);

console.log(`\n${pass} passed, ${fail} failed\n`);
try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
process.exit(fail ? 1 : 0);
