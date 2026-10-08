// Auto bug report: turns an error group, a finding, or a single trace into a markdown
// write-up a developer can act on without opening the console.
import fs from "node:fs";
import path from "node:path";
import { HERE, cfg } from "./config.mjs";

const REPO = path.resolve(HERE, "..", "..");
const fmtMs = (ms) => (ms == null ? "—" : ms < 1 ? "<1 ms" : ms < 1000 ? `${Math.round(ms)} ms` : `${(ms / 1000).toFixed(2)} s`);
const iso = (ts) => new Date(ts).toISOString().replace("T", " ").slice(0, 19) + " UTC";
const code = (s) => "`" + String(s).replace(/`/g, "'") + "`";
const json = (v, max = 1500) => { const t = JSON.stringify(v, null, 2) ?? ""; return t.length > max ? t.slice(0, max) + "\n…(truncated)" : t; };

// ── where in the source tree does a route live? ──────────────────────────────
const FILES = ["route.ts", "route.tsx", "page.tsx", "page.ts"];
function findRoute(dir, segs) {
  if (!segs.length) { for (const f of FILES) if (fs.existsSync(path.join(dir, f))) return path.join(dir, f); return null; }
  let entries; try { entries = fs.readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory()); } catch { return null; }
  const [seg, ...rest] = segs;
  const dynamic = seg.startsWith(":");
  const tries = [
    ...(dynamic ? [] : entries.filter((e) => e.name === seg)),
    ...entries.filter((e) => /^\[.+\]$/.test(e.name)),
    ...entries.filter((e) => /^\(.+\)$/.test(e.name)).map((e) => ({ ...e, group: true })),
  ];
  for (const e of tries) {
    const hit = findRoute(path.join(dir, e.name), e.group ? segs : rest);
    if (hit) return hit;
  }
  return null;
}
/** '/api/portal-kv/mutate' → 'src/app/api/portal-kv/mutate/route.ts' (null if unknown). */
export function resolveRouteFile(route) {
  if (!route || route === "/") return null;
  const hit = findRoute(path.join(REPO, "src", "app"), route.split("/").filter(Boolean));
  return hit ? path.relative(REPO, hit).replace(/\\/g, "/") : null;
}
/** Application frames (src/…) found in a stack trace that exist in the repo. */
export function stackLocations(stack, limit = 5) {
  const seen = new Set(), out = [];
  for (const m of String(stack || "").matchAll(/((?:src|scripts)[\\/][\w\-./\\()[\]@]+?\.(?:tsx?|jsx?|mjs)):(\d+)(?::(\d+))?/g)) {
    const file = m[1].replace(/\\/g, "/");
    const k = `${file}:${m[2]}`;
    if (seen.has(k)) continue; seen.add(k);
    out.push({ file, line: +m[2], exists: fs.existsSync(path.join(REPO, file)) });
    if (out.length >= limit) break;
  }
  return out;
}

function treeOf(spans) {
  const byId = new Map(spans.map((s) => [s.id, s])), kids = new Map();
  for (const s of spans) { const p = s.parent_id && byId.has(s.parent_id) ? s.parent_id : null; s._p = p; (kids.get(p) || kids.set(p, []).get(p)).push(s); }
  const ordered = [];
  (function walk(pid, depth) { for (const s of (kids.get(pid) || []).sort((a, b) => a.ts - b.ts)) { s._depth = depth; ordered.push(s); walk(s.id, depth + 1); } })(null, 0);
  const hasErrDesc = (s) => (kids.get(s.id) || []).some((k) => k.status === "error" || hasErrDesc(k));
  const origin = spans.filter((s) => s.status === "error" && !hasErrDesc(s)).sort((a, b) => a.ts - b.ts)[0] || null;
  const pathTo = (s) => { const o = []; for (let c = s; c; c = c._p ? byId.get(c._p) : null) o.unshift(c); return o; };
  return { ordered, origin, pathTo, byId };
}

function reproSteps(store, span) {
  if (!span?.session_id) return [];
  const ev = store.sessionEvents(span.session_id, span.ts - 5 * 60e3, span.ts + 1500, 40);
  const lines = [];
  for (const s of ev) {
    if (s.kind === "ui.nav") {
      if (/^Navigation/.test(s.name)) lines.push(`Go to ${code(s.attrs?.to ?? s.route)}`);
      else if (/^Chargement|^Page load/i.test(s.name)) lines.push(`Open ${code(s.route)}`);
    } else if (s.kind === "ui.click") {
      const t = s.attrs?.target ?? {};
      const what = t.text ? `“${t.text}”` : `<${t.tag ?? "element"}>`;
      lines.push(`Click ${what}${t.component ? ` (component ${code(t.component)})` : ""}${s.status === "error" ? " → **fails**" : s.status === "dead" ? " → *nothing happens*" : ""}`);
    }
  }
  // collapse consecutive duplicates
  return lines.filter((l, i) => l !== lines[i - 1]).slice(-12);
}

function timeline(spans, tree) {
  const t0 = Math.min(...spans.map((s) => s.ts));
  return tree.ordered.slice(0, 40).map((s) => {
    const flag = s.status === "error" ? " ✕" : s.status === "slow" ? " ◔ slow" : s.status === "dead" ? " ∅ dead" : "";
    return `${"  ".repeat(s._depth)}- +${Math.round(s.ts - t0)} ms  \`${s.kind}\` ${s.name} — ${fmtMs(s.dur)}${flag}`;
  }).join("\n") + (tree.ordered.length > 40 ? `\n…(${tree.ordered.length - 40} more steps)` : "");
}

function link(trace, span) { return `http://127.0.0.1:${cfg.port}/#/trace/${encodeURIComponent(trace)}${span ? `?span=${encodeURIComponent(span)}` : ""}`; }

/**
 * @param {object} store
 * @param {{fingerprint?: string, trace?: string, rule?: string, key?: string}} q
 * @returns {{title: string, markdown: string} | null}
 */
export function buildReport(store, q, now = Date.now()) {
  let title, summary, severity = "—", category = "error", stats = [], traceId = null, spanId = null, finding = null, errGroup = null;

  if (q.fingerprint) {
    errGroup = store.errorGroup(q.fingerprint);
    if (!errGroup?.n) return null;
    const last = store.errorOccurrences(q.fingerprint, 1)[0];
    traceId = last.trace_id; spanId = last.id;
    const e = errGroup.error ?? {};
    title = `${e.name ?? "Error"}: ${String(e.message ?? errGroup.name).slice(0, 120)}`;
    const hour = store.get(`SELECT COUNT(*) n FROM spans WHERE fingerprint=? AND ts >= ?`, q.fingerprint, now - 3600e3).n;
    summary = `${code(errGroup.name)} (${errGroup.kind}) failed ${errGroup.n} time(s) for ${errGroup.users} user(s), ${hour} of them in the last hour.`;
    severity = errGroup.kind === "crash" ? "critical" : errGroup.users >= 3 ? "high" : "medium";
    stats = [["Occurrences", `${errGroup.n} (${hour} in the last hour)`], ["Users affected", errGroup.users], ["First seen", iso(errGroup.first_seen)], ["Last seen", iso(errGroup.last_seen)]];
  } else if (q.rule) {
    const g = store.listFindings({ since: 0, limit: 1000 }).find((f) => f.rule === q.rule && f.key === q.key);
    if (!g) return null;
    finding = g; title = g.title; category = g.category; severity = g.severity;
    summary = g.detail; traceId = g.trace_id; spanId = g.span_id;
    stats = [["Rule", `${g.rule} (${g.category})`], ["Occurrences", g.n], ["Users affected", g.users], ["First seen", iso(g.first_seen)], ["Last seen", iso(g.last_seen)]];
  } else if (q.trace) {
    traceId = q.trace;
  } else return null;

  const triageRef = q.fingerprint ? ["error", q.fingerprint] : q.rule ? ["finding", `${q.rule}|${q.key}`] : null;
  const tri = triageRef ? store.triageMap(triageRef[0]).get(triageRef[1]) : null;
  if (tri) stats.push(["Triage", `${tri.status}${tri.note ? ` — ${tri.note}` : ""} (${iso(tri.updated_ts)})`]);

  const t = traceId ? store.getTrace(traceId) : { trace: null, spans: [] };
  if (q.trace) {
    if (!t.spans.length) return null;
    const r = treeOf(t.spans).ordered[0];
    title = `Trace: ${r.name}`; summary = `One recorded user action (${t.trace.spans} steps, ${fmtMs(t.trace.dur)}), status ${t.trace.status}.`;
    stats = [["When", iso(t.trace.ts)], ["Steps", t.trace.spans], ["Duration", fmtMs(t.trace.dur)], ["Status", t.trace.status]];
  }

  const tree = t.spans.length ? treeOf(t.spans) : null;
  const focus = (spanId && tree?.byId.get(spanId)) || tree?.origin || tree?.ordered?.[0] || null;
  const sample = focus ?? t.spans[0] ?? null;
  const env = [sample?.env, cfg.mode === "prod" ? "console in prod mode (values masked)" : "console in dev mode (full values)", sample?.app_version && `build ${sample.app_version}`].filter(Boolean).join(" · ");

  const md = [];
  md.push(`# Bug report: ${title}`, "");
  md.push("| | |", "|---|---|", `| Severity | ${severity} |`, `| Category | ${category} |`);
  for (const [k, v] of stats) md.push(`| ${k} | ${v} |`);
  md.push(`| Environment | ${env || "—"} |`);
  if (traceId) md.push(`| Open in console | ${link(traceId, focus?.id)} |`);
  md.push("", "## What happened", "", summary ?? "—", "");

  if (tree && tree.origin) {
    md.push("## Where it fails", "", "From the user's action down to the step that failed:", "");
    md.push(tree.pathTo(tree.origin).map((s) => `\`${s.kind}\` ${s.name}`).join("  →  "), "");
  }

  const err = focus?.error ?? errGroup?.error;
  if (err) {
    md.push("## Error", "", `**${err.name ?? "Error"}**: ${err.message ?? ""}${err.code ? `  (code ${err.code})` : ""}`, "");
    if (err.cause?.length) md.push("Caused by (outermost → innermost):", ...err.cause.map((c) => `1. **${c.name}**: ${c.message}`), "");
    if (err.stack) md.push("```", String(err.stack).split("\n").slice(0, 12).join("\n"), "```", "");
  }

  // Likely code location
  const where = [];
  const routeFile = resolveRouteFile(sample?.route ?? t.spans.find((s) => s.kind === "net.server")?.route);
  if (routeFile) where.push(`Route handler / page: ${code(routeFile)}`);
  for (const l of stackLocations(err?.stack)) where.push(`${code(`${l.file}:${l.line}`)}${l.exists ? "" : " (not found in this checkout)"}`);
  if (focus?.attrs?.table) where.push(`Database table: ${code(focus.attrs.table)}${focus.attrs.op ? ` (${focus.attrs.op})` : ""}`);
  if (focus?.attrs?.target?.component) where.push(`UI component: ${code(focus.attrs.target.component)}${focus.attrs.target.handler ? ` — handler ${code(focus.attrs.target.handler)}` : ""}`);
  if (where.length) md.push("## Likely code location", "", ...where.map((w) => `- ${w}`), "");

  // Reproduction
  const root = tree?.ordered?.[0];
  const steps = reproSteps(store, root ?? sample);
  if (steps.length) md.push("## Steps to reproduce (reconstructed from the recorded session)", "", ...steps.map((s, i) => `${i + 1}. ${s}`), "", "_Typed values are never recorded; use realistic test data._", "");

  if (focus && (focus.attrs?.input !== undefined || focus.attrs?.output !== undefined || focus.attrs?.steps)) {
    md.push("## Failing step: input and output", "");
    if (focus.attrs.steps) md.push("Computation steps:", ...focus.attrs.steps.map((st, i) => `${i + 1}. ${st.label ?? ""} \`${st.expr ?? ""}\` → ${JSON.stringify(st.result)}`), "");
    if (focus.attrs.input !== undefined) md.push("Input:", "```json", json(focus.attrs.input), "```", "");
    if (focus.attrs.output !== undefined) md.push("Output:", "```json", json(focus.attrs.output), "```", "");
  }

  if (tree) md.push("## Timeline of one occurrence", "", timeline(t.spans, tree), "");

  if (errGroup) {
    const occ = store.errorOccurrences(q.fingerprint, 8);
    md.push("## Recent occurrences", "", ...occ.map((o) => `- ${iso(o.ts)} — user ${o.user_id ?? "?"} — ${link(o.trace_id, o.id)}`), "");
  } else if (finding) {
    const occ = store.findingOccurrences(finding.rule, finding.key, 8);
    md.push("## Recent occurrences", "", ...occ.map((o) => `- ${iso(o.ts)} — user ${o.user_id ?? "?"}${o.trace_id ? ` — ${link(o.trace_id, o.span_id)}` : ""}`), "");
  }
  md.push("---", `_Generated by Trace Console on ${iso(now)}. Verify against the code before acting: detections are heuristics, and recorded data may be test data._`);
  return { title, markdown: md.join("\n") };
}
