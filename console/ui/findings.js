"use strict";
/* Findings, Digest and the bug-report modal. Loaded after app.js (shares its helpers: h, put, clear, api,
   badge, link, select, live, RANGES, fmtN, fmtMs, ago, fmtTime, fmtDateTime). */

// ── Triage: what a human decided about a problem ─────────────────────────────
Object.assign(ICON, { ack: "•", fixed: "✓", ignored: "–", reopened: "↺" });
Object.assign(LABEL, { ack: "acknowledged", ignored: "ignored", reopened: "came back" });
const TRIAGE_FILTER = [["open", "Open (hide fixed and ignored)"], ["all", "All, including fixed and ignored"]];

/** Small status badge; nothing is shown for a problem nobody has triaged. */
function triageBadge(t) { return t && t.status !== "new" ? badge(t.status) : null; }

async function setTriage(kind, ref, status, note) {
  await api("/api/triage", { method: "POST", headers: { "x-console": "1", "content-type": "application/json" }, body: JSON.stringify({ kind, ref, status, note }) });
}

/** Buttons + note for one problem. `onChange` reloads the list afterwards. */
function triageBar(kind, ref, current, onChange) {
  const t = current || { status: "new" };
  const note = h("input", { type: "text", placeholder: "Note (optional): who, ticket, why", value: t.note || "", "aria-label": "Triage note", style: { flex: "1", minWidth: "180px" } });
  const act = (status, label) => h("button", { class: "btn small", disabled: t.status === status ? "" : null, onclick: async () => { try { await setTriage(kind, ref, status, note.value); onChange(); } catch (e) { alert(`Could not save: ${e.message}`); } } }, label);
  return h("div", { class: "row", style: { marginBottom: "10px", padding: "8px 10px", border: "1px solid var(--grid)", borderRadius: "8px" } },
    h("span", { class: "faint" }, "Status:"), t.status === "new" ? h("span", null, "new — nobody has looked") : badge(t.status),
    t.status === "reopened" ? h("span", { class: "muted" }, `came back ${t.since_fix} time(s) after being marked fixed`) : null,
    act("ack", "Acknowledge"), act("fixed", "Mark fixed"), act("ignored", "Ignore"), t.status !== "new" ? act("new", "Reset") : null, note);
}

/** "Current release X · first seen 2 h ago" — null when no build id is recorded. */
function releaseLine(r) {
  return r ? h("p", { class: "faint", style: { margin: "4px 0 0" } }, `Current release ${r.current} · first seen ${ago(r.since)} · ${r.builds} build(s) recorded`) : null;
}

/** One-line intake health under the tiles: green = data flows and nothing is lost. */
function recorderHealthCard(h_) {
  if (!h_) return null;
  const ing = h_.ingest;
  const lagTxt = Object.entries(ing.lag || {}).map(([s, ms]) => `${s} ${ms < 1000 ? Math.round(ms) + " ms" : (ms / 1000).toFixed(1) + " s"}`).join(" · ") || "—";
  const when = ing.lastIngestAt ? ago(ing.lastIngestAt) : "never";
  return h("div", { class: "card pad", style: { marginTop: "12px" } },
    h("div", { class: "row" }, h("b", null, "Recorder health"), badge(h_.healthy ? "ok" : "warning"),
      h("span", { class: "muted" }, h_.healthy ? "data is flowing and nothing is being lost" : h_.issues.join(" · "))),
    h("div", { class: "faint", style: { marginTop: "6px", fontSize: "12.5px" } },
      `last ${ing.windowMin} min: ${fmtN(ing.accepted)} received, ${fmtN(ing.rejected)} rejected · last data ${when} · delay ${lagTxt} · ${h_.recorders.length} recorder(s) reporting, ${fmtN(h_.dropped)} event(s) dropped`));
}

/** Things that SHOULD happen (crons, webhooks) and whether they did. */
function expectationsPanel(ex) {
  if (!ex || !ex.enabled) {
    return h("div", { class: "card pad" }, h("div", { class: "muted" }, "Absence detection is off."),
      h("div", { class: "faint", style: { fontSize: "12.5px", marginTop: "4px" } }, "It alerts when a cron or webhook that should have run did not. Turn it on in qa/console/expectations.json — only when this console receives data from the environment where those jobs run (production); in development nothing schedules them."));
  }
  const rows = [...ex.rows].sort((a, b) => ({ missed: 0, never_seen: 1, on_time: 2 }[a.status] - { missed: 0, never_seen: 1, on_time: 2 }[b.status]));
  const bad = rows.filter((r) => r.status === "missed").length;
  const label = { on_time: "ok", missed: "critical", never_seen: "info" };
  return h("div", { class: "card" },
    h("div", { class: "row pad", style: { borderBottom: "1px solid var(--grid)" } }, h("b", null, `${rows.length} expectation(s)`), badge(bad ? "critical" : "ok"), h("span", { class: "muted" }, bad ? `${bad} missing` : "everything expected has been seen")),
    h("div", { class: "tablewrap" }, h("table", null,
      h("thead", null, h("tr", null, h("th", null, "What"), h("th", null, "Schedule"), h("th", null, "Last seen"), h("th", null, "Status"))),
      h("tbody", null, rows.map((r) => h("tr", null,
        h("td", { class: "mono" }, r.name), h("td", null, r.schedule), h("td", null, r.last_seen ? ago(r.last_seen) : "never"),
        h("td", null, r.status === "never_seen" ? h("span", { class: "faint" }, "not seen yet — not judged") : badge(r.status === "on_time" ? "ok" : (r.severity || "warning")), r.missed >= 2 ? h("span", { class: "faint" }, `  ${r.missed} missed in a row`) : null)))))));
}

// ── Bug report modal ─────────────────────────────────────────────────────────
async function showReport(url) {
  let data;
  try { data = await api(url); } catch (e) { alert(`Could not build the report: ${e.message}`); return; }
  const close = () => back.remove();
  const text = h("pre", { class: "md" }, data.markdown);
  const copy = h("button", {
    class: "btn small",
    onclick: async () => {
      try { await navigator.clipboard.writeText(data.markdown); copy.textContent = "Copied ✓"; }
      catch { const r = document.createRange(); r.selectNodeContents(text); getSelection().removeAllRanges(); getSelection().addRange(r); copy.textContent = "Selected — press Ctrl+C"; }
    },
  }, "Copy markdown");
  const download = h("button", {
    class: "btn small",
    onclick: () => h("a", { href: URL.createObjectURL(new Blob([data.markdown], { type: "text/markdown" })), download: `bug-report-${Date.now()}.md` }).click(),
  }, "Download .md");
  const back = h("div", { class: "modal-backdrop", onclick: (e) => { if (e.target === back) close(); } },
    h("div", { class: "card modal", role: "dialog", "aria-modal": "true", "aria-label": "Bug report" },
      h("div", { class: "row pad", style: { borderBottom: "1px solid var(--grid)" } },
        h("b", null, "Bug report"), h("span", { class: "faint" }, "ready to hand to a developer"),
        h("span", { style: { marginLeft: "auto", display: "flex", gap: "8px" } }, copy, download, h("button", { class: "btn small", onclick: close }, "Close"))),
      text));
  document.body.append(back);
  addEventListener("keydown", function esc(e) { if (e.key === "Escape") { close(); removeEventListener("keydown", esc); } });
}

// ── Findings (hidden bugs) ───────────────────────────────────────────────────
const CATS = [["", "All categories"], ["silent-wrong", "Silent wrong results"], ["integrity", "Data integrity"], ["performance", "Performance"], ["confusion", "User confusion"], ["drift", "Drift vs normal"]];
const CAT_LABEL = Object.fromEntries(CATS);

function findingsTile(counts) {
  const total = (counts || []).reduce((a, c) => a + c.kinds, 0);
  return h("a", { class: "card tile", href: link("findings"), style: { color: "inherit", textDecoration: "none" } },
    h("div", { class: "l" }, "Hidden-bug findings (24 h)"),
    h("div", { class: "n" }, fmtN(total)),
    h("div", { class: "s" }, total ? counts.map((c) => `${c.kinds} ${(CAT_LABEL[c.category] || c.category).toLowerCase()}`).join(" · ") : "nothing suspicious found"));
}

async function viewFindings(view, query) {
  const f = { category: query.category || "", range: query.range || "24h", triage: query.triage || "open" };
  const body = h("div"), count = h("span", { class: "faint" });
  view.append(
    h("h1", null, "Findings"),
    h("p", { class: "sub" }, "Problems that did not crash anything: wrong results, data-integrity risks, wasteful patterns, confused users, and drift away from normal."),
    h("div", { class: "filters" },
      select("Category", CATS, f.category, (v) => { f.category = v; setQuery({ category: v }); load(); }),
      select("Range", RANGES, f.range, (v) => { f.range = v; setQuery({ range: v }); load(true); }),
      select("Show", TRIAGE_FILTER, f.triage, (v) => { f.triage = v; setQuery({ triage: v }); load(true); }), count),
    h("div", { class: "card" }, body));

  async function load(force) {
    const p = new URLSearchParams({ range: f.range, triage: f.triage });
    if (f.category) p.set("category", f.category);
    const d = await api(`/api/findings?${p}`);
    count.textContent = `${d.rows.length} kind(s)`;
    if (!force && body.querySelector("tr[aria-expanded=true]")) return; // don't collapse a row the user is reading
    if (!d.rows.length) return clear(body).append(h("div", { class: "empty" }, "Nothing suspicious found in this range."));
    const tb = h("tbody");
    for (const r of d.rows) {
      const occ = h("tr", { hidden: true }, h("td", { colspan: 6 }, h("div", { class: "pad" })));
      const main = h("tr", { class: "click", tabindex: 0, "aria-expanded": "false" },
        h("td", null, badge(r.severity)),
        h("td", null, h("span", { class: "kind" }, r.rule), h("div", { class: "faint", style: { fontSize: "12px" } }, CAT_LABEL[r.category] || r.category)),
        h("td", null, h("b", null, r.title), " ", triageBadge(r.triage), h("div", { class: "muted" }, r.detail || "")),
        h("td", { class: "num" }, fmtN(r.n)), h("td", { class: "num" }, fmtN(r.users)), h("td", null, ago(r.last_seen)));
      const toggle = async () => {
        const on = occ.hidden;
        occ.hidden = !on; main.setAttribute("aria-expanded", String(on));
        if (!on || occ.dataset.loaded) return;
        occ.dataset.loaded = "1";
        const cell = $("div", occ); cell.append("Loading…");
        try {
          const rows = (await api(`/api/finding?rule=${encodeURIComponent(r.rule)}&key=${encodeURIComponent(r.key)}`)).occurrences;
          put(clear(cell),
            triageBar("finding", `${r.rule}|${r.key}`, r.triage, () => load(true)),
            h("div", { class: "row" }, h("span", { class: "faint" }, `First seen ${fmtDateTime(r.first_seen)}`),
              h("button", { class: "btn small", style: { marginLeft: "auto" }, onclick: () => showReport(`/api/report?rule=${encodeURIComponent(r.rule)}&key=${encodeURIComponent(r.key)}`) }, "Bug report")),
            h("div", { style: { marginTop: "8px" } }, h("b", null, "Recent occurrences: "),
              rows.slice(0, 10).map((o, i) => [i ? " · " : "", o.trace_id
                ? h("a", { href: link(`trace/${o.trace_id}`, o.span_id ? { span: o.span_id } : undefined) }, `${fmtTime(o.ts)}${o.user_id ? " " + o.user_id : ""}`)
                : fmtTime(o.ts)])));
        } catch (err) { clear(cell).append(`Failed to load: ${err.message}`); }
      };
      main.addEventListener("click", toggle);
      main.addEventListener("keydown", (e) => { if (e.key === "Enter") toggle(); });
      tb.append(main, occ);
    }
    clear(body).append(h("div", { class: "tablewrap" }, h("table", null,
      h("thead", null, h("tr", null, h("th", null, "Severity"), h("th", null, "Rule"), h("th", null, "Finding"), h("th", { class: "num" }, "Count"), h("th", { class: "num" }, "Users"), h("th", null, "Last seen"))), tb)));
  }
  live(load);
}

// ── Dependencies: the outside services we rely on ───────────────────────────
Object.assign(ICON, { down: "✕", idle: "–" });
Object.assign(LABEL, { down: "down", idle: "no recent calls" });

/** Tiny p95 line with a red tick under every period that had failures. */
function sparkline(buckets) {
  const W2 = 220, H2 = 44, pad = 4;
  const pts = buckets.filter((b) => b.p95 != null);
  const s = svg("svg", { viewBox: `0 0 ${W2} ${H2}`, width: "100%", height: H2, role: "img", "aria-label": "p95 latency over time" });
  if (pts.length < 2) { s.append(svg("text", { x: 4, y: 24 }, "not enough data")); return s; }
  const max = Math.max(...buckets.map((b) => b.p95 ?? 0), 1), n = buckets.length;
  const x = (i) => pad + (i * (W2 - 2 * pad)) / Math.max(1, n - 1), y = (v) => H2 - 10 - (v / max) * (H2 - 18);
  s.append(svg("line", { class: "axis", x1: pad, x2: W2 - pad, y1: H2 - 8, y2: H2 - 8 }));
  const line = buckets.map((b, i) => (b.p95 == null ? null : `${x(i).toFixed(1)},${y(b.p95).toFixed(1)}`)).filter(Boolean);
  s.append(svg("path", { d: `M${line.join(" L")}`, fill: "none", stroke: "var(--series1)", "stroke-width": 2, "stroke-linejoin": "round", "stroke-linecap": "round" }));
  buckets.forEach((b, i) => { if (b.errors) s.append(svg("rect", { x: x(i) - 2, y: H2 - 6, width: 4, height: 5, rx: 1, fill: "var(--crit)" })); });
  return s;
}

async function viewDependencies(view, query) {
  const f = { range: query.range || "24h" }, body = h("div");
  view.append(
    h("h1", null, "Dependencies"),
    h("p", { class: "sub" }, "The outside services ImmoAdmin relies on, from the calls the server makes. A service that slows down or fails shows up elsewhere as “everything is slow” — this names the culprit. Recent = the last 15 minutes versus the rest of the range."),
    h("div", { class: "filters" }, select("Range", RANGES.slice(1, 5), f.range, (v) => { f.range = v; setQuery({ range: v }); load(); })), body);

  async function load() {
    const d = await api(`/api/dependencies?range=${f.range}`);
    if (!d.services.length) return clear(body).append(h("div", { class: "card empty" }, "No outbound calls recorded in this range yet. They appear once the server recorder sees calls to Supabase, Stripe, Twilio and so on."));
    const cards = d.services.map((s) => h("div", { class: "card pad" },
      h("div", { class: "row" }, h("b", null, s.name), badge(s.status), h("span", { class: "faint", style: { marginLeft: "auto", fontSize: "12px" } }, s.hosts.join(", "))),
      h("div", { class: "muted", style: { margin: "6px 0 8px", minHeight: "20px" } }, s.reasons.length ? s.reasons.join("; ") : s.status === "idle" ? "Too few recent calls to judge." : "Responding normally."),
      sparkline(s.buckets),
      h("dl", { class: "kv", style: { marginTop: "8px" } },
        h("dt", null, "Calls"), h("dd", null, `${fmtN(s.calls)} (${fmtN(s.errors)} failed, ${pct(s.error_rate)})`),
        h("dt", null, "Latency"), h("dd", null, `median ${fmtMs(s.p50)} · p95 ${fmtMs(s.p95)}`),
        h("dt", null, "Last failure"), h("dd", null, s.last_error ? ago(s.last_error) : "none"),
        s.top_error ? [h("dt", null, "Common error"), h("dd", { class: "mono", style: { fontSize: "12px" } }, `${s.top_error.message.slice(0, 90)} (×${s.top_error.count})`)] : null)));
    put(clear(body), h("div", { style: { display: "grid", gap: "14px", gridTemplateColumns: "repeat(auto-fill, minmax(300px, 1fr))" } }, cards));
  }
  live(load);
}

// ── Digest ───────────────────────────────────────────────────────────────────
async function viewDigest(view, query) {
  const f = { range: query.range || "24h" }, body = h("div");
  view.append(
    h("h1", null, "Digest"),
    h("p", { class: "sub" }, "What got worse, what got better and what is new, compared with the previous period of the same length."),
    h("div", { class: "filters" }, select("Range", RANGES.slice(1), f.range, (v) => { f.range = v; setQuery({ range: v }); load(); })),
    h("div", { class: "card" }, body));

  async function load() {
    const d = await api(`/api/digest?range=${f.range}`);
    const copy = h("button", { class: "btn small", onclick: async () => { try { await navigator.clipboard.writeText(d.markdown); copy.textContent = "Copied ✓"; } catch { copy.textContent = "Copy failed"; } } }, "Copy markdown");
    const dl = h("button", { class: "btn small", onclick: () => h("a", { href: URL.createObjectURL(new Blob([d.markdown], { type: "text/markdown" })), download: `digest-${f.range}-${new Date().toISOString().slice(0, 10)}.md` }).click() }, "Download .md");
    put(clear(body),
      h("div", { class: "row pad", style: { borderBottom: "1px solid var(--grid)" } },
        h("span", { class: "faint" }, "Markdown — paste into a ticket, chat or email"), h("span", { style: { marginLeft: "auto", display: "flex", gap: "8px" } }, copy, dl)),
      h("pre", { class: "md" }, d.markdown));
  }
  await load();
}
