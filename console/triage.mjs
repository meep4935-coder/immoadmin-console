// Triage: a human's decision about a problem, layered over the detections.
//   new       nobody has looked (the default; no row stored)
//   ack       someone is aware of it
//   fixed     believed fixed — REOPENS automatically if it happens again afterwards
//   ignored   known / not a bug — hidden from the default views and from "new error" alerts
export const STATUSES = ["new", "ack", "fixed", "ignored"];
export const KINDS = ["error", "finding"];

export const findingRef = (f) => `${f.rule}|${f.key}`;
export const errorRef = (e) => e.fingerprint;

/**
 * Annotates rows with `triage: {status, note, updated_ts, since_fix?}` and, in "open" mode, drops the
 * ones that are fixed (and have not come back) or ignored.
 * @param rows   grouped rows with `last_seen`
 * @param mode   "open" (default) | "all"
 */
export function applyTriage(store, kind, rows, refOf, mode = "open") {
  const map = store.triageMap(kind);
  const out = [];
  for (const r of rows) {
    const ref = refOf(r);
    const t = map.get(ref);
    let status = t?.status ?? "new";
    let since_fix;
    if (status === "fixed" && r.last_seen > t.updated_ts + 1000) {
      status = "reopened";
      since_fix = store.countSince(kind, ref, t.updated_ts);
    }
    r.triage = { status, ...(t?.note ? { note: t.note } : {}), ...(t ? { updated_ts: t.updated_ts } : {}), ...(since_fix !== undefined ? { since_fix } : {}) };
    if (mode === "open" && (status === "fixed" || status === "ignored")) continue;
    out.push(r);
  }
  return out;
}

/** Per-category counts of finding KINDS (and occurrences) over already-filtered rows. */
export function countFindings(rows) {
  const m = new Map();
  for (const r of rows) {
    const e = m.get(r.category) || { category: r.category, n: 0, kinds: 0 };
    e.n += r.n; e.kinds += 1; m.set(r.category, e);
  }
  return [...m.values()];
}
