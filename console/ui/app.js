"use strict";
/* Trace Console UI. All data is rendered through h()/svg() (textContent), never innerHTML:
   span names, errors and payloads come from arbitrary user input. */

// ── DOM helpers ──────────────────────────────────────────────────────────────
const $ = (s, el = document) => el.querySelector(s);
function h(tag, props, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (v == null || v === false) continue;
    if (k === "class") el.className = v;
    else if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
    else if (k === "style" && typeof v === "object") Object.assign(el.style, v);
    else el.setAttribute(k, v === true ? "" : v);
  }
  for (const kid of kids.flat(Infinity)) { if (kid == null || kid === false) continue; el.append(kid.nodeType ? kid : document.createTextNode(String(kid))); }
  return el;
}
function svg(tag, props, ...kids) {
  const el = document.createElementNS("http://www.w3.org/2000/svg", tag);
  for (const [k, v] of Object.entries(props || {})) if (v != null) el.setAttribute(k, v);
  for (const kid of kids.flat(Infinity)) if (kid != null) el.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
  return el;
}
const clear = (el) => { while (el.firstChild) el.removeChild(el.firstChild); return el; };
/** Like el.append(), but flattens arrays and skips null/false (DOM append() would print "null"). */
function put(parent, ...kids) {
  for (const kid of kids.flat(Infinity)) { if (kid == null || kid === false) continue; parent.append(kid.nodeType ? kid : document.createTextNode(String(kid))); }
  return parent;
}

// ── formatting ───────────────────────────────────────────────────────────────
const fmtMs = (ms) => ms == null ? "—" : ms < 1 ? "<1 ms" : ms < 1000 ? `${Math.round(ms)} ms` : ms < 60000 ? `${(ms / 1000).toFixed(ms < 10000 ? 2 : 1)} s` : `${(ms / 60000).toFixed(1)} min`;
const fmtTime = (ts) => new Date(ts).toLocaleTimeString("en-GB");
const fmtDateTime = (ts) => new Date(ts).toLocaleString("en-GB", { month: "short", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" });
const fmtN = (n) => n == null ? "—" : n >= 10000 ? `${(n / 1000).toFixed(1)}K` : n.toLocaleString("en-US");
const pct = (r) => `${(r * 100).toFixed(r > 0 && r < 0.001 ? 2 : 1)}%`;
function ago(ts) { const s = Math.max(0, (Date.now() - ts) / 1000); return s < 60 ? `${Math.round(s)}s ago` : s < 3600 ? `${Math.round(s / 60)}m ago` : s < 86400 ? `${Math.round(s / 3600)}h ago` : `${Math.round(s / 86400)}d ago`; }
const shortId = (id) => (id || "").replace(/^(t_|sp_)/, "").slice(0, 8);

const ICON = { ok: "✓", healthy: "✓", resolved: "✓", slow: "◔", degraded: "▲", warning: "▲", error: "✕", failing: "✕", critical: "✕", dead: "∅", info: "i" };
const LABEL = { dead: "dead click" };
const badge = (s) => h("span", { class: `badge b-${s}` }, h("i", { "aria-hidden": "true" }, ICON[s] || "•"), LABEL[s] || s);

async function api(path, opts) {
  const r = await fetch(path, opts);
  if (!r.ok) { let m = r.status; try { m = (await r.json()).error || m; } catch {} throw new Error(m); }
  return r.json();
}

// ── tooltip ──────────────────────────────────────────────────────────────────
const tipEl = () => $("#tip");
function showTip(x, y, node) {
  const t = tipEl(); clear(t).append(node); t.hidden = false;
  const r = t.getBoundingClientRect();
  t.style.left = `${Math.min(x + 14, innerWidth - r.width - 8)}px`;
  t.style.top = `${Math.min(y + 14, innerHeight - r.height - 8)}px`;
}
const hideTip = () => { tipEl().hidden = true; };

// ── router ───────────────────────────────────────────────────────────────────
const NAV = [["overview", "Overview"], ["traces", "Traces"], ["users", "Users"], ["errors", "Errors"], ["findings", "Findings"], ["trends", "Trends"], ["dependencies", "Dependencies"], ["alerts", "Alerts"], ["digest", "Digest"]];
const state = { refresh: null, openAlerts: 0, feed: [], feedPaused: false, feedErrorsOnly: false, mode: "dev" };

function parseHash() {
  const raw = location.hash.replace(/^#\/?/, "");
  const [pathPart, q = ""] = raw.split("?");
  return { parts: pathPart.split("/").filter(Boolean).map(decodeURIComponent), query: Object.fromEntries(new URLSearchParams(q)) };
}
const link = (path, query) => `#/${path}${query && Object.keys(query).length ? "?" + new URLSearchParams(query) : ""}`;
function setQuery(patch) {
  const { parts, query } = parseHash(); const q = { ...query, ...patch };
  for (const k of Object.keys(q)) if (q[k] === "" || q[k] == null) delete q[k];
  history.replaceState(null, "", link(parts.join("/"), q));
}

function renderNav(active) {
  const nav = clear($("#nav"));
  for (const [id, label] of NAV) {
    nav.append(h("a", { href: link(id), "aria-current": id === active ? "page" : null }, label,
      id === "alerts" && state.openAlerts ? h("span", { class: "count" }, state.openAlerts) : null));
  }
}

async function route() {
  state.refresh = null; hideTip();
  const { parts, query } = parseHash();
  const view = $("#view");
  const name = parts[0] || "overview";
  renderNav(name === "trace" ? "traces" : name === "user" ? "users" : name);
  clear(view);
  try {
    if (name === "overview") await viewOverview(view);
    else if (name === "traces") await viewTraces(view, query);
    else if (name === "trace" && parts[1]) await viewTrace(view, parts[1], query);
    else if (name === "users") await viewUsers(view, query);
    else if (name === "user" && parts[1]) await viewUser(view, parts[1], query);
    else if (name === "errors") await viewErrors(view, query);
    else if (name === "trends") await viewTrends(view, query);
    else if (name === "alerts") await viewAlerts(view);
    else if (name === "findings") await viewFindings(view, query);
    else if (name === "digest") await viewDigest(view, query);
    else if (name === "dependencies") await viewDependencies(view, query);
    else view.append(h("div", { class: "empty" }, "Not found."));
  } catch (e) { view.append(h("div", { class: "card empty" }, `Could not load this view: ${e.message}`)); }
  window.scrollTo(0, 0);
}
addEventListener("hashchange", route);

/** Body that re-renders itself every few seconds while visible. */
function live(load) {
  const run = () => Promise.resolve(load()).catch((e) => console.error("refresh failed:", e));
  run();
  state.refresh = run;
}
setInterval(() => { if (state.refresh && !document.hidden && !document.activeElement?.matches?.("input,select")) state.refresh(); }, 5000);

// ── shared components ────────────────────────────────────────────────────────
function select(name, options, value, onchange) {
  const s = h("select", { "aria-label": name, onchange: (e) => onchange(e.target.value) });
  for (const [v, l] of options) s.append(h("option", { value: v, selected: v === value }, l));
  return s;
}
const RANGES = [["15m", "Last 15 min"], ["1h", "Last hour"], ["6h", "Last 6 hours"], ["24h", "Last 24 hours"], ["7d", "Last 7 days"], ["14d", "Last 14 days"]];

function tracesTable(rows, { showUser = true } = {}) {
  if (!rows.length) return h("div", { class: "empty" }, "No traces match.");
  return h("div", { class: "tablewrap" }, h("table", null,
    h("thead", null, h("tr", null, h("th", null, "When"), h("th", null, "Action"), h("th", null, "Route"), showUser && h("th", null, "User"),
      h("th", { class: "num" }, "Spans"), h("th", { class: "num" }, "Errors"), h("th", { class: "num" }, "Duration"), h("th", null, "Status"))),
    h("tbody", null, rows.map((t) => h("tr", { class: "click", tabindex: 0, onclick: () => (location.hash = link(`trace/${t.trace_id}`)),
      onkeydown: (e) => { if (e.key === "Enter") location.hash = link(`trace/${t.trace_id}`); } },
      h("td", { title: fmtDateTime(t.ts) }, fmtTime(t.ts), " ", h("span", { class: "faint" }, ago(t.ts))),
      h("td", { class: "trunc" }, t.root_name || shortId(t.trace_id)),
      h("td", { class: "trunc mono" }, t.route || "—"),
      showUser && h("td", { class: "mono" }, t.user_id ? h("a", { href: link(`user/${t.user_id}`), onclick: (e) => e.stopPropagation() }, t.user_id) : "—"),
      h("td", { class: "num" }, t.spans), h("td", { class: "num" }, t.errors || ""), h("td", { class: "num" }, fmtMs(t.dur)),
      h("td", null, badge(t.status)))))));
}

// ── Overview ─────────────────────────────────────────────────────────────────
async function viewOverview(view) {
  const body = h("div"); view.append(h("h1", null, "Overview"), h("p", { class: "sub" }, "Live health of everything the console receives."), body);
  const feedRows = h("div", { class: "feed" });
  const feedCard = h("div", { class: "card" },
    h("div", { class: "row pad", style: { borderBottom: "1px solid var(--grid)" } },
      h("b", null, "Live feed"), h("span", { class: "faint", id: "feedCount" }),
      h("label", { class: "row", style: { marginLeft: "auto", gap: "6px" } }, h("input", { type: "checkbox", onchange: (e) => { state.feedErrorsOnly = e.target.checked; drawFeed(); } }), "problems only"),
      h("button", { class: "btn small", onclick: (e) => { state.feedPaused = !state.feedPaused; e.target.textContent = state.feedPaused ? "Resume" : "Pause"; if (!state.feedPaused) drawFeed(); } }, "Pause")),
    feedRows);
  const top = h("div");
  view.append(top, h("h2", null, "Live events"), feedCard);

  function drawFeed() {
    clear(feedRows);
    const list = state.feed.filter((s) => !state.feedErrorsOnly || s.status !== "ok").slice(0, 150);
    if (!list.length) feedRows.append(h("div", { class: "empty" }, "Waiting for events…"));
    for (const s of list) {
      feedRows.append(h("div", { class: "f", tabindex: 0, onclick: () => (location.hash = link(`trace/${s.trace_id}`)), onkeydown: (e) => { if (e.key === "Enter") location.hash = link(`trace/${s.trace_id}`); } },
        h("span", { class: "faint" }, fmtTime(s.ts)), h("span", null, h("span", { class: "kind" }, s.kind)),
        h("span", { class: "nm", title: s.name }, h("span", { class: s.status === "ok" ? "" : "faint" }, s.status === "ok" ? "" : `${ICON[s.status]} `), s.name),
        h("span", { class: "faint", style: { textAlign: "right" } }, fmtMs(s.dur))));
    }
    const c = $("#feedCount"); if (c) c.textContent = `${state.feed.length} buffered`;
  }
  state.drawFeed = drawFeed; drawFeed();

  live(async () => {
    const [o, rh] = await Promise.all([api("/api/overview"), api("/api/recorder-health").catch(() => null)]);
    state.mode = o.mode; state.openAlerts = o.openAlerts.length; renderNav("overview");
    const tile = (l, n, s, cls) => h("div", { class: "card tile" }, h("div", { class: "l" }, l), h("div", { class: "n", style: cls ? { color: `var(--${cls})` } : null }, n), s && h("div", { class: "s" }, s));
    put(clear(top), releaseLine(o.release), recorderHealthCard(rh),
      h("div", { class: "tiles" },
        tile("Active users (15 min)", fmtN(o.activeUsers15m), `${o.degradedUsers} degraded`),
        tile("Failing users", fmtN(o.failingUsers), "most of their recent actions failed", o.failingUsers ? "crit" : null),
        tile("Requests (1 h)", fmtN(o.requests1h), `${fmtN(o.counts.spans)} spans stored`),
        tile("Error rate (1 h)", pct(o.errorRate1h), "failed server requests", o.errorRate1h >= 0.05 ? "crit" : null),
        tile("Latency p95 (1 h)", fmtMs(o.p95_1h), `median ${fmtMs(o.p50_1h)}`),
        findingsTile(o.findings24h)),
      h("div", { class: "grid2" },
        h("div", null, h("h2", null, `Open alerts (${o.openAlerts.length})`), h("div", { class: "card" }, alertList(o.openAlerts, { compact: true }))),
        h("div", null, h("h2", null, "Users needing attention"), h("div", { class: "card" }, userTable(o.attention, { compact: true })))));
  });
}

// ── Traces ───────────────────────────────────────────────────────────────────
async function viewTraces(view, query) {
  const f = { q: query.q || "", status: query.status || "", user: query.user || "", range: query.range || "24h" };
  const body = h("div"), count = h("span", { class: "faint" });
  const search = h("input", { type: "search", placeholder: "Search action, route or trace id", value: f.q, "aria-label": "Search", style: { minWidth: "260px" },
    oninput: (e) => { f.q = e.target.value; setQuery({ q: f.q }); load(); } });
  const user = h("input", { type: "search", placeholder: "User id", value: f.user, "aria-label": "User id", oninput: (e) => { f.user = e.target.value; setQuery({ user: f.user }); load(); } });
  view.append(h("h1", null, "Traces"), h("p", { class: "sub" }, "One trace = one user action and everything it triggered, in order."),
    h("div", { class: "filters" }, search, user,
      select("Status", [["", "Any status"], ["error", "Errors"], ["dead", "Dead clicks"], ["slow", "Slow"], ["ok", "OK"]], f.status, (v) => { f.status = v; setQuery({ status: v }); load(); }),
      select("Range", RANGES, f.range, (v) => { f.range = v; setQuery({ range: v }); load(); }), count),
    h("div", { class: "card" }, body));
  async function load() {
    const p = new URLSearchParams({ range: f.range, limit: 200 }); for (const k of ["q", "status", "user"]) if (f[k]) p.set(k, f[k]);
    const d = await api(`/api/traces?${p}`);
    count.textContent = `${fmtN(d.total)} traces${d.total > d.rows.length ? ` (showing ${d.rows.length})` : ""}`;
    clear(body).append(tracesTable(d.rows));
  }
  live(load);
}

// ── Trace detail ─────────────────────────────────────────────────────────────
function analyze(spans) {
  const byId = new Map(spans.map((s) => [s.id, s])), kids = new Map();
  for (const s of spans) { const p = s.parent_id && byId.has(s.parent_id) ? s.parent_id : null; s._p = p; if (!kids.has(p)) kids.set(p, []); kids.get(p).push(s); }
  const ordered = [];
  (function walk(pid, depth) { for (const s of (kids.get(pid) || []).sort((a, b) => a.ts - b.ts)) { s._depth = depth; ordered.push(s); walk(s.id, depth + 1); } })(null, 0);
  const t0 = Math.min(...spans.map((s) => s.ts)), tEnd = Math.max(...spans.map((s) => s.ts + (s.dur || 0)));
  for (const s of spans) { const c = (kids.get(s.id) || []).reduce((a, k) => a + (k.dur || 0), 0); s._self = Math.max(0, (s.dur || 0) - c); }
  const hasErrDesc = (s) => (kids.get(s.id) || []).some((k) => k.status === "error" || hasErrDesc(k));
  const origins = spans.filter((s) => s.status === "error" && !hasErrDesc(s)).sort((a, b) => a.ts - b.ts);
  const pathTo = (s) => { const out = []; for (let c = s; c; c = c._p ? byId.get(c._p) : null) out.unshift(c); return out; };
  return { ordered, t0, total: Math.max(1, tEnd - t0), origin: origins[0] || null, origins, pathTo };
}

async function viewTrace(view, id, query) {
  const { trace, spans } = await api(`/api/trace/${encodeURIComponent(id)}`);
  const A = analyze(spans);
  const root = A.ordered[0];
  // Open on the most informative step: the failure, else a dead click, the slowest slow step, a calculation, or the root.
  const slowStep = spans.filter((s) => s.status === "slow").sort((a, b) => b._self - a._self)[0];
  let selected = (query.span && spans.find((s) => s.id === query.span)) || A.origin
    || spans.find((s) => s.status === "dead") || slowStep || spans.find((s) => s.kind === "calc") || root;
  const detail = h("div", { class: "card detail" });
  const rows = new Map();

  view.append(
    h("div", { class: "row", style: { justifyContent: "space-between" } }, h("a", { href: link("traces") }, "← Traces"),
      h("button", { class: "btn small", onclick: () => showReport(`/api/report?trace=${encodeURIComponent(trace.trace_id)}`) }, "Bug report")),
    h("h1", null, root.name),
    h("p", { class: "sub" }, `${fmtDateTime(trace.ts)} · `, h("span", { class: "mono" }, trace.trace_id), " · ",
      trace.user_id ? h("a", { href: link(`user/${trace.user_id}`) }, trace.user_id) : "anonymous", trace.role ? ` (${trace.role})` : "", " · ", `${spans.length} spans · ${fmtMs(trace.dur)} · `, badge(trace.status)));

  if (A.origin) {
    const o = A.origin, e = o.error || {};
    view.append(h("div", { class: "card rootcause" },
      h("div", { class: "row" }, h("b", null, A.origins.length > 1 ? `Likely root cause (1 of ${A.origins.length} failing leaves)` : "Likely root cause"), badge("error")),
      h("p", { style: { margin: "6px 0 4px" } }, h("b", null, `${e.name || "Error"}: `), e.message || "(no message)", e.code ? h("span", { class: "faint" }, `  [${e.code}]`) : null),
      h("div", { class: "faint", style: { fontSize: "12px" } }, "Path from the user's action down to where it failed:"),
      h("div", { class: "crumbs" }, A.pathTo(o).flatMap((s, i, arr) => [
        h("button", { class: "chip", onclick: () => select_(s) }, h("span", { class: "kind" }, s.kind), " ", s.name),
        i < arr.length - 1 ? h("span", { class: "sep" }, "→") : null])),
      e.cause?.length ? h("div", null, h("div", { class: "faint", style: { fontSize: "12px" } }, "Caused by (outermost → innermost):"),
        h("ol", { class: "chain" }, e.cause.map((c) => h("li", null, h("b", null, c.name + ": "), c.message)))) : null));
  }

  // waterfall
  const ticks = [0, 0.25, 0.5, 0.75, 1];
  const wf = h("div", { class: "card wf" }, h("div", { class: "wf-head" }, h("div", { class: "wf-label" }, "What ran"),
    h("div", { class: "ruler" }, ticks.map((t) => h("span", { style: { left: `${t * 100}%` } }, t === 0 ? "0" : fmtMs(A.total * t))))));
  for (const s of A.ordered) {
    const left = ((s.ts - A.t0) / A.total) * 100, width = Math.max(0.3, ((s.dur || 0) / A.total) * 100);
    // Duration text: inside the bar when it is wide enough (white/ink picked for contrast on the fill),
    // otherwise just beyond its end, or before its start when the bar touches the right edge.
    const inside = width >= 16, labelRight = !inside && left + width > 80;
    const durStyle = inside ? { left: `${left + 0.8}%`, color: s.status === "slow" ? "#0b0b0b" : "#ffffff", fontWeight: 600 }
      : labelRight ? { right: `${100 - left + 0.5}%` } : { left: `${left + width + 0.5}%` };
    const row = h("div", { class: "wf-row", tabindex: 0, role: "button", onclick: () => select_(s), onkeydown: (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); select_(s); } } },
      h("div", { class: "wf-label", style: { paddingLeft: `${8 + s._depth * 16}px` } }, h("span", { class: "kind" }, s.kind), h("span", { class: "nm", title: s.name }, s.name),
        s.status !== "ok" ? badge(s.status) : null),
      h("div", { class: "wf-bar" }, h("div", { class: "track" },
        h("div", { class: `bar ${s.status}`, style: { left: `${left}%`, width: `${width}%` } }),
        h("div", { class: "dur", style: durStyle }, fmtMs(s.dur)))));
    rows.set(s.id, row); wf.append(row);
  }
  view.append(h("h2", null, "Execution timeline"), wf, h("h2", null, "Selected step"), detail);

  const slowest = [...spans].sort((a, b) => b._self - a._self).slice(0, 3).filter((s) => s._self >= 1);
  if (slowest.length) view.append(h("p", { class: "faint", style: { marginTop: "10px" } }, "Most own time: ",
    slowest.map((s, i) => [i ? " · " : "", h("a", { href: "#", onclick: (e) => { e.preventDefault(); select_(s); } }, `${s.name} (${fmtMs(s._self)})`)])));

  function select_(s) { selected = s; draw(); rows.get(s.id)?.scrollIntoView({ block: "nearest" }); }
  function draw() {
    for (const [sid, r] of rows) r.classList.toggle("sel", sid === selected.id);
    setQuery({ span: selected.id });
    const s = selected, a = s.attrs || {}, e = s.error;
    put(clear(detail),
      h("h3", null, h("span", { class: "kind" }, s.kind), " ", s.name, " ", badge(s.status)),
      h("dl", { class: "kv" },
        h("dt", null, "Started"), h("dd", null, `+${fmtMs(s.ts - A.t0)} (${fmtTime(s.ts)})`),
        h("dt", null, "Duration"), h("dd", null, `${fmtMs(s.dur)}${s.dur >= 1 ? ` — ${fmtMs(s._self)} in itself, ${fmtMs(s.dur - s._self)} in what it called` : ""}`),
        s.route && [h("dt", null, "Route"), h("dd", { class: "mono" }, s.route)],
        s.source && [h("dt", null, "Recorded by"), h("dd", null, s.source)],
        s.parent_id && [h("dt", null, "Called by"), h("dd", null, h("a", { href: "#", onclick: (ev) => { ev.preventDefault(); const p = spans.find((x) => x.id === s.parent_id); if (p) select_(p); } }, spans.find((x) => x.id === s.parent_id)?.name || s.parent_id))]),
      Array.isArray(a.steps) && a.steps.length ? [h("h4", null, "How it was computed"),
        h("ol", { class: "steps" }, a.steps.map((st) => h("li", null, h("span", null, st.label || ""), h("span", { class: "expr" }, st.expr != null ? String(st.expr) : ""), h("span", { class: "res" }, st.result !== undefined ? `→ ${JSON.stringify(st.result)}` : ""))))] : null,
      a.expr && !a.steps ? [h("h4", null, "Expression"), h("pre", null, String(a.expr))] : null,
      jsonBlock("Input", a.input ?? a.inputs ?? a.args), jsonBlock("Output", a.output ?? a.result),
      jsonBlock("Other details", omit(a, ["steps", "input", "inputs", "args", "output", "result"])),
      e ? [h("h4", null, "Error"), h("p", { style: { margin: "0 0 6px" } }, h("b", null, `${e.name}: `), e.message, e.code ? h("span", { class: "faint" }, `  [${e.code}]`) : null),
        e.stack ? h("pre", null, e.stack) : null,
        e.cause?.length ? [h("h4", null, "Cause chain"), h("ol", { class: "chain" }, e.cause.map((c) => h("li", null, h("b", null, c.name + ": "), c.message)))] : null] : null);
  }
  draw();
}
const omit = (o, keys) => { const r = {}; for (const k of Object.keys(o || {})) if (!keys.includes(k)) r[k] = o[k]; return r; };
function jsonBlock(title, v) {
  if (v === undefined || v === null || (typeof v === "object" && !Object.keys(v).length)) return null;
  return [h("h4", null, title), h("pre", null, typeof v === "string" ? v : JSON.stringify(v, null, 2))];
}

// ── Users ────────────────────────────────────────────────────────────────────
function userTable(rows, { compact = false } = {}) {
  if (!rows.length) return h("div", { class: "empty" }, compact ? "Everyone is healthy." : "No users in this range.");
  return h("div", { class: "tablewrap" }, h("table", null,
    h("thead", null, h("tr", null, h("th", null, "User"), h("th", null, "Health"), !compact && h("th", null, "Role"), h("th", null, "Last seen"), !compact && h("th", null, "Last route"),
      h("th", { class: "num" }, "Errors"), h("th", { class: "num" }, "Dead"), h("th", { class: "num" }, "Slow"), !compact && h("th", { class: "num" }, "Traces"), !compact && h("th", { class: "num" }, "Sessions"))),
    h("tbody", null, rows.map((u) => h("tr", { class: "click", tabindex: 0, onclick: () => (location.hash = link(`user/${u.user_id}`)), onkeydown: (e) => { if (e.key === "Enter") location.hash = link(`user/${u.user_id}`); } },
      h("td", { class: "mono" }, u.user_id), h("td", null, badge(u.health)), !compact && h("td", null, u.role || "—"), h("td", null, ago(u.last_seen)),
      !compact && h("td", { class: "mono trunc" }, u.last_route || "—"),
      h("td", { class: "num" }, u.errors || ""), h("td", { class: "num" }, u.dead || ""), h("td", { class: "num" }, u.slow || ""),
      !compact && h("td", { class: "num" }, u.traces), !compact && h("td", { class: "num" }, u.sessions))))));
}

async function viewUsers(view, query) {
  const f = { range: query.range || "15m", health: query.health || "", q: query.q || "" };
  const body = h("div"), count = h("span", { class: "faint" });
  view.append(h("h1", null, "Users"), h("p", { class: "sub" }, "Pseudonymous ids, worst health first. Failing: ≥3 errors or dead clicks and ≥25% of the user's actions. Degraded: ≥5% of actions failed, or ≥25% were slow."),
    h("div", { class: "filters" },
      h("input", { type: "search", placeholder: "Filter by user id", value: f.q, "aria-label": "Filter users", oninput: (e) => { f.q = e.target.value; setQuery({ q: f.q }); draw(); } }),
      select("Health", [["", "Any health"], ["failing", "Failing"], ["degraded", "Degraded"], ["healthy", "Healthy"]], f.health, (v) => { f.health = v; setQuery({ health: v }); draw(); }),
      select("Range", RANGES.slice(0, 5), f.range, (v) => { f.range = v; setQuery({ range: v }); load(); }), count),
    h("div", { class: "card" }, body));
  let data = [];
  function draw() {
    const rows = data.filter((u) => (!f.health || u.health === f.health) && (!f.q || u.user_id.includes(f.q)));
    count.textContent = `${rows.length} of ${data.length} users`;
    clear(body).append(userTable(rows));
  }
  async function load() { data = (await api(`/api/users?range=${f.range}`)).rows; draw(); }
  live(load);
}

async function viewUser(view, id, query) {
  const range = query.range || "24h";
  const d = await api(`/api/user/${encodeURIComponent(id)}?range=${range}`);
  const s = d.summary;
  const tile = (l, n) => h("div", { class: "card tile" }, h("div", { class: "l" }, l), h("div", { class: "n" }, n));
  view.append(h("p", null, h("a", { href: link("users") }, "← Users")),
    h("h1", { class: "mono" }, id), h("p", { class: "sub" }, `${s.role || "unknown role"} · first seen ${fmtDateTime(s.first_seen)} · last seen ${ago(s.last_seen)} · `, badge(d.health)),
    h("div", { class: "filters" }, select("Range", RANGES.slice(1, 6), range, (v) => { setQuery({ range: v }); route(); })),
    h("div", { class: "tiles" }, tile("Traces", fmtN(s.traces)), tile("Sessions", fmtN(s.sessions)), tile("Errors", fmtN(s.errors)), tile("Dead clicks", fmtN(s.dead)), tile("Slow actions", fmtN(s.slow))),
    h("h2", null, "Error types this user hit"), h("div", { class: "card" }, errorTable(d.errors)),
    h("h2", null, "Recent traces"), h("div", { class: "card" }, tracesTable(d.traces, { showUser: false })));
}

// ── Errors ───────────────────────────────────────────────────────────────────
function errorTable(rows, onTriage = () => route()) {
  if (!rows.length) return h("div", { class: "empty" }, "No errors in this range.");
  const body = h("tbody");
  for (const r of rows) {
    const e = r.error || {}; const open = { v: false };
    const detail = h("tr", { hidden: true }, h("td", { colspan: 6 }, h("div", { class: "pad" })));
    const main = h("tr", { class: "click", tabindex: 0, "aria-expanded": "false" },
      h("td", null, h("b", null, e.name || "Error"), " ", triageBadge(r.triage), h("div", { class: "muted trunc", style: { maxWidth: "460px" }, title: e.message }, e.message || ""), r.introduced_in ? h("div", { class: "faint", style: { fontSize: "12px" } }, `introduced in release ${r.introduced_in}`) : null),
      h("td", null, h("span", { class: "kind" }, r.kind)), h("td", { class: "mono trunc" }, r.route || "—"),
      h("td", { class: "num" }, fmtN(r.n)), h("td", { class: "num" }, fmtN(r.users)), h("td", null, ago(r.last_seen)));
    const toggle = async () => {
      open.v = !open.v; detail.hidden = !open.v; main.setAttribute("aria-expanded", String(open.v));
      if (!open.v || detail.dataset.loaded) return;
      detail.dataset.loaded = "1";
      const cell = $("div", detail); cell.append("Loading…");
      try {
        const occ = (await api(`/api/error/${r.fingerprint}`)).occurrences;
        put(clear(cell),
          triageBar("error", r.fingerprint, r.triage, onTriage),
          h("div", { class: "row" }, h("span", { class: "faint" }, `Fingerprint ${r.fingerprint} · first seen ${fmtDateTime(r.first_seen)}`),
            h("button", { class: "btn small", style: { marginLeft: "auto" }, onclick: () => showReport(`/api/report?fp=${r.fingerprint}`) }, "Bug report")),
          e.stack ? h("pre", { style: { margin: "8px 0" } }, e.stack) : null,
          h("div", null, h("b", null, "Recent occurrences: "), occ.slice(0, 8).map((o, i) => [i ? " · " : "", h("a", { href: link(`trace/${o.trace_id}`, { span: o.id }) }, `${fmtTime(o.ts)}${o.user_id ? " " + o.user_id : ""}`)])));
      } catch (err) { clear(cell).append(`Failed to load: ${err.message}`); }
    };
    main.addEventListener("click", toggle); main.addEventListener("keydown", (ev) => { if (ev.key === "Enter") toggle(); });
    body.append(main, detail);
  }
  return h("div", { class: "tablewrap" }, h("table", null,
    h("thead", null, h("tr", null, h("th", null, "Error"), h("th", null, "Where"), h("th", null, "Route"), h("th", { class: "num" }, "Count"), h("th", { class: "num" }, "Users"), h("th", null, "Last seen"))), body));
}
async function viewErrors(view, query) {
  const f = { range: query.range || "24h", triage: query.triage || "open", release: query.release || "" }; const body = h("div");
  view.append(h("h1", null, "Errors"), h("p", { class: "sub" }, "Identical failures grouped together. Open a row for the stack, recent occurrences and to mark it acknowledged, fixed or ignored."),
    h("div", { class: "filters" }, select("Range", RANGES, f.range, (v) => { f.range = v; setQuery({ range: v }); load(true); }), select("Show", TRIAGE_FILTER, f.triage, (v) => { f.triage = v; setQuery({ triage: v }); load(true); }),
      select("Introduced", [["", "In any release"], ["latest", "In the latest release only"]], f.release, (v) => { f.release = v; setQuery({ release: v }); load(true); })), h("div", { class: "card" }, body));
  async function load(force) { const d = await api(`/api/errors?range=${f.range}&triage=${f.triage}${f.release ? "&release=" + f.release : ""}`); if (!force && body.querySelector("tr[aria-expanded=true]")) return; clear(body).append(errorTable(d.rows, () => load(true))); }
  live(load);
}

// ── Alerts ───────────────────────────────────────────────────────────────────
function alertList(rows, { compact = false } = {}) {
  if (!rows.length) return h("div", { class: "empty" }, "Nothing open. All clear.");
  return h("div", null, rows.map((a) => {
    const target = a.data?.trace_id ? link(`trace/${a.data.trace_id}`) : a.data?.user_id ? link(`user/${a.data.user_id}`) : a.data?.users ? link("users", { health: "failing", range: "1h" }) : a.data?.route ? link("traces", { q: a.data.route, status: "error" }) : null;
    return h("div", { class: `alert${a.ack ? " acked" : ""}` }, badge(a.state === "resolved" ? "resolved" : a.severity),
      h("div", null, h("div", { class: "t" }, target ? h("a", { href: target }, a.title) : a.title), h("div", { class: "muted" }, a.detail || ""),
        h("div", { class: "faint", style: { fontSize: "12px" } }, `opened ${ago(a.opened_ts)} · last happened ${ago(a.data?.last_event_ts ?? a.last_ts)}${a.last_ts - a.opened_ts >= 60e3 ? ` · open for ${fmtMs(a.last_ts - a.opened_ts)}` : ""}${a.state === "resolved" ? ` · resolved ${ago(a.resolved_ts)}` : ""}`)),
      !compact && a.state === "open" && !a.ack ? h("button", { class: "btn small", onclick: async () => { await api(`/api/alerts/${a.id}/ack`, { method: "POST", headers: { "x-console": "1" } }); route(); } }, "Acknowledge") : (a.ack ? h("span", { class: "faint" }, "acknowledged") : null));
  }));
}
async function viewAlerts(view) {
  const body = h("div");
  view.append(h("h1", null, "Alerts"), h("p", { class: "sub" }, "Rules: crashes, error spikes, failing or slow routes, struggling users, new error types, and silence (no data received)."), body);
  live(async () => {
    const [open, done] = await Promise.all([api("/api/alerts?state=open"), api("/api/alerts?state=resolved")]);
    state.openAlerts = open.rows.length; renderNav("alerts");
    const ex = await api("/api/expectations").catch(() => null);
    put(clear(body), h("h2", null, `Open (${open.rows.length})`), h("div", { class: "card" }, alertList(open.rows)),
      h("h2", null, "Expected activity"), expectationsPanel(ex),
      h("h2", null, "Recently resolved"), h("div", { class: "card" }, alertList(done.rows.slice(0, 30), { compact: true })));
  });
}

// ── Charts ───────────────────────────────────────────────────────────────────
function niceTicks(max, n = 4) {
  if (max <= 0) return [0, 1];
  const raw = max / n, mag = 10 ** Math.floor(Math.log10(raw)), norm = raw / mag;
  const step = (norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 5 ? 5 : 10) * mag, t = [];
  for (let v = 0; ; v += step) { t.push(v); if (v >= max) break; }
  return t;
}
const W = 640, M = { l: 46, r: 10, t: 10, b: 24 };
function timeLabel(ts, bucketMs) { const d = new Date(ts); return bucketMs >= 3600e3 ? d.toLocaleString("en-GB", { month: "short", day: "2-digit", hour: "2-digit" }) + "h" : d.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" }); }

function axes(data, ticks, H, labelOf) {
  const iw = W - M.l - M.r, ih = H - M.t - M.b, top = ticks[ticks.length - 1];
  const g = svg("g");
  for (const t of ticks) { const y = M.t + ih - (t / top) * ih; g.append(svg("line", { class: t === 0 ? "axis" : "grid", x1: M.l, x2: W - M.r, y1: y, y2: y }), svg("text", { x: M.l - 8, y: y + 4, "text-anchor": "end" }, fmtN(t))); }
  const every = Math.ceil(data.length / 6);
  data.forEach((d, i) => { if (i % every === 0) g.append(svg("text", { x: M.l + (i + 0.5) * (iw / data.length), y: H - 6, "text-anchor": "middle" }, labelOf(d))); });
  return { g, iw, ih, top };
}
function hover(box, svgEl, n, tipFor) {
  const move = (ev) => {
    const r = svgEl.getBoundingClientRect(), x = ((ev.clientX - r.left) / r.width) * W;
    const i = Math.floor(((x - M.l) / (W - M.l - M.r)) * n);
    if (i < 0 || i >= n) return hideTip();
    showTip(ev.clientX, ev.clientY, tipFor(i)); box.dispatchEvent(new CustomEvent("idx", { detail: i }));
  };
  svgEl.addEventListener("mousemove", move); svgEl.addEventListener("mouseleave", () => { hideTip(); box.dispatchEvent(new CustomEvent("idx", { detail: -1 })); });
}
const tipNode = (title, value) => h("div", null, h("div", { class: "faint" }, title), h("b", null, value));

/** Vertical line where a new release first appeared, labelled with its version. */
function drawMarkers(s, data, bucketMs, markers, iw, ih) {
  const slot = iw / data.length;
  for (const m of (markers || []).slice(0, 4)) {
    const i = Math.floor((m.first_seen - data[0].x) / bucketMs);
    if (i < 0 || i >= data.length) continue;
    const x = M.l + i * slot;
    s.append(svg("line", { x1: x, x2: x, y1: M.t, y2: M.t + ih, stroke: "var(--accent)", "stroke-width": 1 }),
      svg("text", { class: "rel", x: Math.min(x + 4, W - 60), y: M.t + 10 }, `release ${String(m.version).slice(0, 12)}`));
  }
}

function columnChart(data, { color, name, bucketMs, markers = [] }) {
  const H = 200, max = Math.max(1, ...data.map((d) => d.y)), ticks = niceTicks(max), box = h("div", { class: "chartbox" });
  const s = svg("svg", { viewBox: `0 0 ${W} ${H}`, width: "100%", role: "img", "aria-label": `${name} per period` });
  const { g, iw, ih, top } = axes(data, ticks, H, (d) => timeLabel(d.x, bucketMs)); s.append(g);
  const slot = iw / data.length, bw = Math.min(24, Math.max(2, slot - 2)), hi = svg("rect", { fill: "var(--hover)", y: M.t, height: ih, width: slot, display: "none" });
  s.append(hi);
  data.forEach((d, i) => {
    const bh = (d.y / top) * ih; if (bh <= 0) return;
    const x = M.l + i * slot + (slot - bw) / 2, y = M.t + ih - bh, r = Math.min(4, bw / 2, bh);
    s.append(svg("path", { fill: color, d: `M${x},${y + bh} V${y + r} Q${x},${y} ${x + r},${y} H${x + bw - r} Q${x + bw},${y} ${x + bw},${y + r} V${y + bh} Z` }));
  });
  drawMarkers(s, data, bucketMs, markers, iw, ih);
  box.addEventListener("idx", (e) => { const i = e.detail; hi.setAttribute("display", i < 0 ? "none" : "block"); if (i >= 0) hi.setAttribute("x", M.l + i * slot); });
  hover(box, s, data.length, (i) => tipNode(`${timeLabel(data[i].x, bucketMs)} · ${name}`, fmtN(data[i].y)));
  box.append(s); return box;
}

function lineChart(data, { color, name, bucketMs, markers = [] }) {
  const H = 200, max = Math.max(1, ...data.map((d) => d.y)), ticks = niceTicks(max), box = h("div", { class: "chartbox" });
  const s = svg("svg", { viewBox: `0 0 ${W} ${H}`, width: "100%", role: "img", "aria-label": name });
  const { g, iw, ih, top } = axes(data, ticks, H, (d) => timeLabel(d.x, bucketMs)); s.append(g);
  const px = (i) => M.l + (i + 0.5) * (iw / data.length), py = (v) => M.t + ih - (v / top) * ih;
  const pts = data.map((d, i) => `${px(i).toFixed(1)},${py(d.y).toFixed(1)}`);
  s.append(svg("path", { d: `M${px(0)},${M.t + ih} L${pts.join(" L")} L${px(data.length - 1)},${M.t + ih} Z`, fill: color, "fill-opacity": ".10" }),
    svg("path", { d: `M${pts.join(" L")}`, fill: "none", stroke: color, "stroke-width": 2, "stroke-linejoin": "round", "stroke-linecap": "round" }));
  const cross = svg("line", { y1: M.t, y2: M.t + ih, stroke: "var(--axis)", "stroke-width": 1, display: "none" }), dot = svg("circle", { r: 4, fill: color, stroke: "var(--surface)", "stroke-width": 2, display: "none" });
  const last = data.length - 1;
  s.append(cross, dot, svg("circle", { cx: px(last), cy: py(data[last].y), r: 4, fill: color, stroke: "var(--surface)", "stroke-width": 2 }));
  drawMarkers(s, data, bucketMs, markers, iw, ih);
  box.addEventListener("idx", (e) => { const i = e.detail, on = i >= 0; cross.setAttribute("display", on ? "block" : "none"); dot.setAttribute("display", on ? "block" : "none"); if (on) { cross.setAttribute("x1", px(i)); cross.setAttribute("x2", px(i)); dot.setAttribute("cx", px(i)); dot.setAttribute("cy", py(data[i].y)); } });
  hover(box, s, data.length, (i) => tipNode(`${timeLabel(data[i].x, bucketMs)} · ${name}`, fmtN(data[i].y)));
  box.append(s); return box;
}

function hbarChart(rows, { color }) {
  const rowH = 30, H = rows.length * rowH + 12, labelW = 210, box = h("div", { class: "chartbox" });
  const max = Math.max(1, ...rows.map((r) => r.p95)), ticks = niceTicks(max, 3), top = ticks[ticks.length - 1], bw = W - labelW - 70;
  const s = svg("svg", { viewBox: `0 0 ${W} ${H}`, width: "100%", role: "img", "aria-label": "p95 latency by route" });
  rows.forEach((r, i) => {
    const y = 6 + i * rowH, len = Math.max(3, (r.p95 / top) * bw), t = r.route.length > 30 ? r.route.slice(0, 29) + "…" : r.route;
    const rr = Math.min(4, len / 2);
    s.append(svg("text", { class: "lbl", x: labelW - 10, y: y + 17, "text-anchor": "end", "font-size": 12 }, t),
      svg("path", { fill: color, d: `M${labelW},${y + 5} H${labelW + len - rr} Q${labelW + len},${y + 5} ${labelW + len},${y + 5 + rr} V${y + 15 - rr} Q${labelW + len},${y + 15} ${labelW + len - rr},${y + 15} H${labelW} Z` }),
      svg("text", { class: "val", x: labelW + len + 8, y: y + 15, "font-size": 12 }, fmtMs(r.p95)),
      svg("rect", { x: 0, y, width: W, height: rowH, fill: "transparent", onmousemove: null, "data-i": i }));
  });
  s.addEventListener("mousemove", (ev) => { const el = document.elementFromPoint(ev.clientX, ev.clientY), i = el?.dataset?.i; if (i == null) return hideTip(); const r = rows[+i]; showTip(ev.clientX, ev.clientY, h("div", null, h("b", { class: "mono" }, r.route), h("div", null, `p95 ${fmtMs(r.p95)} · median ${fmtMs(r.p50)}`), h("div", { class: "faint" }, `${fmtN(r.n)} requests, ${fmtN(r.errors)} failed`))); });
  s.addEventListener("mouseleave", hideTip);
  box.append(s); return box;
}

function chartCard(title, sub, chart, cols, rows) {
  let table = false; const holder = h("div"), btn = h("button", { class: "btn small", "aria-pressed": "false" }, "Table view");
  const draw = () => { clear(holder).append(table ? h("div", { class: "tablewrap" }, h("table", null, h("thead", null, h("tr", null, cols.map((c) => h("th", { class: c.num ? "num" : "" }, c.h)))),
    h("tbody", null, rows.map((r) => h("tr", null, cols.map((c) => h("td", { class: c.num ? "num" : "" }, c.v(r)))))))) : chart); btn.textContent = table ? "Chart view" : "Table view"; btn.setAttribute("aria-pressed", String(table)); };
  btn.addEventListener("click", () => { table = !table; draw(); }); draw();
  return h("div", { class: "card chart-card" }, h("div", { class: "chart-head" }, h("h3", null, title), h("span", { class: "faint" }, sub), btn), holder);
}

async function viewTrends(view, query) {
  const f = { range: query.range || "24h" }, body = h("div");
  view.append(h("h1", null, "Trends"), h("p", { class: "sub" }, "Usage and reliability over time."),
    h("div", { class: "filters" }, select("Range", RANGES.slice(1), f.range, (v) => { f.range = v; setQuery({ range: v }); load(); })), body);
  async function load() {
    const d = await api(`/api/stats?range=${f.range}`); const b = d.buckets;
    if (!b.length) return clear(body).append(h("div", { class: "card empty" }, "No data in this range yet."));
    const mk = (key) => b.map((x) => ({ x: x.b, y: x[key] || 0 }));
    const when = (r) => timeLabel(r.b, d.bucketMs), per = d.bucketMs >= 3600e3 ? "per hour" : d.bucketMs >= 300e3 ? "per 5 min" : "per minute";
    const totalReq = b.reduce((a, x) => a + x.requests, 0), totalErr = b.reduce((a, x) => a + x.errors, 0);
    clear(body).append(
      h("div", { class: "grid2" },
        chartCard("Server requests", per, columnChart(mk("requests"), { color: "var(--series1)", name: "requests", bucketMs: d.bucketMs, markers: d.releases }), [{ h: "Period", v: when }, { h: "Requests", num: 1, v: (r) => fmtN(r.requests) }], b),
        chartCard("Errors", `${per} · ${fmtN(totalErr)} total, ${fmtN(totalReq)} requests`, columnChart(mk("errors"), { color: "var(--crit)", name: "errors", bucketMs: d.bucketMs, markers: d.releases }), [{ h: "Period", v: when }, { h: "Errors", num: 1, v: (r) => fmtN(r.errors) }, { h: "Failed requests", num: 1, v: (r) => fmtN(r.server_errors) }], b),
        chartCard("Active users", per, lineChart(mk("users"), { color: "var(--series1)", name: "active users", bucketMs: d.bucketMs, markers: d.releases }), [{ h: "Period", v: when }, { h: "Distinct users", num: 1, v: (r) => fmtN(r.users) }], b),
        d.routes.length ? chartCard("Slowest routes", "p95 latency", hbarChart(d.routes, { color: "var(--series1)" }), [{ h: "Route", v: (r) => r.route }, { h: "p50", num: 1, v: (r) => fmtMs(r.p50) }, { h: "p95", num: 1, v: (r) => fmtMs(r.p95) }, { h: "Requests", num: 1, v: (r) => fmtN(r.n) }, { h: "Failed", num: 1, v: (r) => fmtN(r.errors) }], d.routes) : null));
  }
  live(load);
}

// ── live stream, theme, boot ─────────────────────────────────────────────────
function connectStream() {
  const pill = $("#livePill"), txt = $("#liveText");
  const es = new EventSource("/api/stream");
  es.onopen = () => { pill.className = "pill live"; txt.textContent = "live"; };
  es.onerror = () => { pill.className = "pill down"; txt.textContent = "reconnecting"; };
  es.addEventListener("span", (e) => {
    const s = JSON.parse(e.data); state.feed.unshift(s); if (state.feed.length > 500) state.feed.length = 500;
    if (state.drawFeed && !state.feedPaused && parseHash().parts[0] !== "trace" && ($("#feedCount"))) state.drawFeed();
  });
  es.addEventListener("alert", async () => { try { state.openAlerts = (await api("/api/alerts?state=open")).rows.length; renderNav(parseHash().parts[0] || "overview"); } catch {} });
}
$("#themeBtn").addEventListener("click", () => {
  const cur = document.documentElement.dataset.theme || (matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light");
  const next = cur === "dark" ? "light" : "dark"; document.documentElement.dataset.theme = next;
  try { localStorage.setItem("console-theme", next); } catch {}
});
(async () => {
  try { const hc = await api("/api/health"); $("#modePill").textContent = hc.mode === "prod" ? "prod · scrubbed" : "dev · full values"; $("#modePill").title = "Scrubbing mode (--mode)"; } catch {}
  connectStream(); route();
})();
