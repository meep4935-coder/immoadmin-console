#!/usr/bin/env node
/**
 * Traffic simulator — exercises the console end to end without the real app.
 *
 *   node qa/console/sim.mjs --backfill=6h        # fill the past 6 h (for trends), then exit
 *   node qa/console/sim.mjs --duration=120       # live traffic for 2 min
 *   node qa/console/sim.mjs --duration=60 --storm=30   # + failing /api/zum/enroll for 30 s
 *   flags: --url --token --users=40 --rate=4 (actions/s) --seed=1
 */
import crypto from "node:crypto";
import { arg } from "./config.mjs";

const URL_ = String(arg("url", "http://127.0.0.1:4317")).replace(/\/$/, "");
const TOKEN = String(arg("token", process.env.CONSOLE_TOKEN || ""));
const N_USERS = Number(arg("users", 40));
const RATE = Number(arg("rate", 4));
const DURATION = Number(arg("duration", 0));
const STORM = Number(arg("storm", 0));
const BACKFILL = String(arg("backfill", ""));
const RELEASES = !!arg("releases", false); // two builds: sim-1, then sim-2 (slower dashboard) from 60 % into a backfill
let releaseAt = Infinity;                 // events at/after this time carry build "sim-2"
const versionAt = (t) => (RELEASES && t >= releaseAt ? "sim-2" : "sim-1");
const HIDDEN = !!arg("hidden", false); // also emit scenarios with NO error but something wrong (see hidden())

let seed = Number(arg("seed", Date.now() % 100000));
const rnd = () => { seed = (seed * 1664525 + 1013904223) % 4294967296; return seed / 4294967296; };
const pick = (a) => a[Math.floor(rnd() * a.length)];
const between = (a, b) => a + rnd() * (b - a);
const hex = (n = 6) => crypto.randomBytes(n).toString("hex");

const users = Array.from({ length: N_USERS }, (_, i) => ({
  id: "u_" + crypto.createHash("sha1").update("user" + i).digest("hex").slice(0, 10),
  role: i % 20 === 0 ? "delegate" : i % 4 === 0 ? "tenant" : "owner",
  session: "s_" + hex(5),
}));

let stormUntil = 0;

function err(name, message, frames, cause) {
  return {
    name, message,
    stack: `${name}: ${message}\n` + frames.map((f) => `    at ${f}`).join("\n"),
    cause,
  };
}

/** Build one user action as a tree of spans. Returns spans[]. */
function action(t0, user) {
  const trace_id = "t_" + hex(8);
  const spans = [];
  const base = { trace_id, user_id: user.id, session_id: user.session, role: user.role, app_version: versionAt(t0), env: "sim" };
  const add = (o) => { const s = { id: "sp_" + hex(6), source: "sim", ...base, ...o }; spans.push(s); return s; };
  const r = rnd();
  const stormOn = Date.now() < stormUntil;
  if (HIDDEN && rnd() < 0.25) { hidden(t0, add, user); return spans; }
  if (rnd() < 0.18) { outside(t0, add, stormOn); return spans; }

  if (stormOn && r < 0.25) { enroll(t0, add, true); return spans; }

  if (r < 0.50) { // ── save a lease: click → fetch → API → auth → DB
    const net = between(90, 260), srv = net - between(25, 50), db = between(25, 90);
    const click = add({ ts: t0, dur: net + 30, kind: "ui.click", name: "Click: Save lease", route: "/portail/locataires",
      attrs: { target: { tag: "button", text: "Save lease", component: "LeaseForm", handler: "onSave" } } });
    const cl = add({ parent_id: click.id, ts: t0 + 4, dur: net, kind: "net.client", name: "POST /api/portal-kv/mutate", route: "/portail/locataires",
      attrs: { method: "POST", status: 200, request_bytes: 812, response_bytes: 96 } });
    const sv = add({ parent_id: cl.id, ts: t0 + 18, dur: srv, kind: "net.server", name: "POST /api/portal-kv/mutate", route: "/api/portal-kv/mutate", attrs: { status: 200 } });
    add({ parent_id: sv.id, ts: t0 + 20, dur: between(2, 6), kind: "fn", name: "requireAccess('admin','baux')", attrs: { input: { section: "admin", page: "baux" }, output: { ok: true, effectiveOwnerId: "owner_" + user.id.slice(2, 8) } } });
    add({ parent_id: sv.id, ts: t0 + 28, dur: db, kind: "db", name: "rpc kv_cas_save", attrs: { op: "rpc", rpc: "kv_cas_save", status: 200, rows: 1, input: { key: "baux", op: "patch", id: "lease_" + hex(3) } } });
    add({ parent_id: click.id, ts: t0 + net + 8, dur: between(6, 22), kind: "render", name: "Render <LeaseForm> (saved)", attrs: { component: "LeaseForm" } });
  } else if (r < 0.78) { // ── dashboard load
    const net = between(140, 520) * (versionAt(t0) === "sim-2" ? 3 : 1); // the new build regressed this page
    const nav = add({ ts: t0, dur: net + 60, kind: "ui.nav", name: "Navigate → /portail/dashboard", route: "/portail/dashboard" });
    const cl = add({ parent_id: nav.id, ts: t0 + 10, dur: net, kind: "net.client", name: "POST /api/portal-kv/load-batch", route: "/portail/dashboard", attrs: { status: 200 } });
    const sv = add({ parent_id: cl.id, ts: t0 + 22, dur: net - 30, kind: "net.server", name: "POST /api/portal-kv/load-batch", route: "/api/portal-kv/load-batch", attrs: { status: 200 } });
    let c = t0 + 30;
    for (const t of ["portal_kv:dashboard/resume", "portal_kv:finances/revenus", "portal_kv:admin/baux"]) {
      const d = between(20, 120);
      add({ parent_id: sv.id, ts: c, dur: d, kind: "db", name: `select ${t}`, attrs: { op: "select", table: "portal_kv", filters: { section: t.split(":")[1].split("/")[0] }, status: 200 } });
      c += d + 4;
    }
    add({ parent_id: nav.id, ts: t0 + net + 20, dur: between(30, 90), kind: "render", name: "Render <Dashboard>", attrs: { component: "Dashboard" } });
  } else if (r < 0.88) { // ── a calculation, explained step by step
    if (rnd() < 0.4) {
      const click = add({ ts: t0, dur: 3, kind: "ui.click", name: "Click: Compute", route: "/portail/outils" });
      add({ parent_id: click.id, ts: t0 + 1, dur: 0.2, kind: "calc", name: "add(1, 1)", attrs: {
        expr: "1 + 1", inputs: { a: 1, b: 1 },
        steps: [{ label: "add the two operands", expr: "1 + 1", result: 2 }], output: 2 } });
    } else {
      const loyer = pick([950, 1200, 1475, 1800]), tx = pick([0.021, 0.03, 0.038]);
      const aug = Math.round(loyer * tx * 100) / 100, nouveau = Math.round((loyer + aug) * 100) / 100;
      const click = add({ ts: t0, dur: 14, kind: "ui.click", name: "Click: Calculate rent increase", route: "/portail/outils",
        attrs: { target: { tag: "button", text: "Calculate", component: "TalCalculator" } } });
      add({ parent_id: click.id, ts: t0 + 2, dur: between(2, 8), kind: "calc", name: "calculerAugmentationLoyer", attrs: {
        inputs: { loyerActuel: loyer, tauxTAL: tx },
        steps: [
          { label: "increase = rent × rate", expr: `${loyer} × ${tx}`, result: aug },
          { label: "new rent = rent + increase", expr: `${loyer} + ${aug}`, result: nouveau },
          { label: "round to cents", expr: `round(${nouveau}, 2)`, result: nouveau },
        ], output: { augmentation: aug, nouveauLoyer: nouveau } } });
    }
  } else if (r < 0.93) { // ── slow database
    const db = between(1800, 4200);
    const click = add({ ts: t0, dur: db + 80, kind: "ui.click", name: "Click: Open rent report", route: "/portail/rapports" });
    const cl = add({ parent_id: click.id, ts: t0 + 4, dur: db + 40, kind: "net.client", name: "GET /api/rapports/grand-livre", route: "/portail/rapports", attrs: { status: 200 } });
    const sv = add({ parent_id: cl.id, ts: t0 + 15, dur: db + 10, kind: "net.server", name: "GET /api/rapports/grand-livre", route: "/api/rapports/grand-livre", attrs: { status: 200 } });
    add({ parent_id: sv.id, ts: t0 + 20, dur: db, kind: "db", name: "select gl_lines", attrs: { op: "select", table: "gl_lines", filters: { owner_id: "eq.…", date: "gte.2026-01-01" }, rows: 48211, status: 200, hint: "no index on (owner_id, date)" } });
  } else if (r < 0.955) { // ── failing save: DB conflict bubbling up to a toast
    const e1 = err("PostgrestError", 'duplicate key value violates unique constraint "tenant_units_tenant_id_building_id_key"',
      ["casUpsertKV (src/app/lib/server/casUpsertKV.ts:88:11)", "POST (src/app/api/portal-kv/mutate/route.ts:41:9)"]);
    e1.code = "23505";
    const click = add({ ts: t0, dur: 260, kind: "ui.click", name: "Click: Assign tenant to unit", route: "/portail/locataires",
      status: "error", error: err("Error", "Could not assign tenant", ["onAssign (LeaseForm.tsx:57:5)"], [{ name: "HttpError", message: "500 Internal Server Error" }, { name: "PostgrestError", message: e1.message }]),
      attrs: { target: { tag: "button", text: "Assign", component: "AssignTenantDialog" } } });
    const cl = add({ parent_id: click.id, ts: t0 + 4, dur: 240, kind: "net.client", name: "POST /api/portal-kv/mutate", route: "/portail/locataires",
      status: "error", error: err("HttpError", "500 Internal Server Error", ["apiPost (portalApi.ts:120:11)"]), attrs: { status: 500 } });
    const sv = add({ parent_id: cl.id, ts: t0 + 15, dur: 215, kind: "net.server", name: "POST /api/portal-kv/mutate", route: "/api/portal-kv/mutate",
      status: "error", error: err("Error", "mutate failed", ["POST (route.ts:55:7)"], [{ name: "PostgrestError", message: e1.message }]), attrs: { status: 500 } });
    add({ parent_id: sv.id, ts: t0 + 30, dur: 180, kind: "db", name: "upsert tenant_units", status: "error", error: e1,
      attrs: { op: "upsert", table: "tenant_units", status: 409, input: { tenant_id: "ten_" + hex(3), building_id: "bld_" + hex(3), unit_label: "4B" } } });
    add({ parent_id: click.id, ts: t0 + 262, dur: 4, kind: "render", name: "Render toast: 'Could not assign tenant'", attrs: { component: "Toast" } });
  } else if (r < 0.975) { // ── dead button
    add({ ts: t0, dur: 800, kind: "ui.click", name: "Click: Send reminder", route: "/portail/locataires", status: "dead",
      attrs: { reason: "no state change, DOM mutation or network request within 800 ms",
        target: { tag: "button", text: "Send reminder", component: "ReminderButton", handler: "onClick (undefined)", disabled: false } } });
  } else if (r < 0.98) { // ── render crash
    add({ ts: t0, dur: 3, kind: "crash", name: "Render crash <LocatairesTable>", route: "/portail/locataires", status: "error",
      error: err("TypeError", "Cannot read properties of undefined (reading 'map')",
        ["LocatairesTable (src/app/portail/locataires/LocatairesTable.tsx:142:38)", "renderWithHooks (react-dom)"]),
      attrs: { component: "LocatairesTable", boundary: "error.tsx", props_shape: { rows: "undefined" } } });
  } else { // ── enroll (healthy here; fails during a storm)
    enroll(t0, add, false);
  }
  return spans;
}

/** Calls to outside services: Stripe, Twilio (fails during the storm), Anthropic (slow by nature), Supabase. */
function outside(t0, add, stormOn) {
  const r = rnd();
  const [label, route, host, name, lo, hi, failChance] =
    r < 0.35 ? ["Payer le loyer", "/api/stripe/create-payment", "api.stripe.com", "POST api.stripe.com/v1/payment_intents", 180, 500, 0.01]
      : r < 0.60 ? ["Envoyer un rappel (SMS)", "/api/sms/send", "api.twilio.com", "POST api.twilio.com/Messages", 120, 350, stormOn ? 0.7 : 0.01]
        : r < 0.85 ? ["Demander à l'assistant", "/api/ai/chat", "api.anthropic.com", "POST api.anthropic.com/v1/messages", 1400, 3800, 0.01]
          : ["Ouvrir la fiche", "/api/locataires/fiche", "abcd1234.supabase.co", "select tenant_profiles", 20, 90, 0.005];
  const dur = between(lo, hi), failed = rnd() < failChance;
  const click = add({ ts: t0, dur: dur + 60, kind: "ui.click", name: `Clic : ${label}`, route: "/portail/locataires", status: failed ? "error" : "ok",
    error: failed ? err("Error", `${label} a échoué`, ["onClick (Panel.tsx:40:9)"]) : undefined, attrs: { target: { tag: "button", text: label, component: "Panel" } } });
  const cl = add({ parent_id: click.id, ts: t0 + 4, dur: dur + 40, kind: "net.client", name: `POST ${route}`, route: "/portail/locataires", status: failed ? "error" : "ok", attrs: { method: "POST", status: failed ? 502 : 200 } });
  const sv = add({ parent_id: cl.id, ts: t0 + 15, dur: dur + 20, kind: "net.server", name: `POST ${route}`, route, status: failed ? "error" : "ok", attrs: { status: failed ? 502 : 200 } });
  const isDb = host.endsWith("supabase.co");
  add({ parent_id: sv.id, ts: t0 + 25, dur, kind: isDb ? "db" : "external", name, status: failed ? "error" : "ok",
    error: failed ? err("Error", `${host} responded 503 Service Unavailable`, ["fetch (node:internal)"]) : undefined,
    attrs: { host, ...(isDb ? { op: "select", table: "tenant_profiles" } : { path: name.split(" ")[1] }), status: failed ? 503 : 200 } });
}

/** Scenarios where NOTHING crashes but something is wrong — what the hidden-bug detectors look for. */
function hidden(t0, add, user) {
  const kind = Math.floor(rnd() * 6);
  const owner = "own_" + user.id.slice(2, 8);
  const reqChain = (name, route, dur) => {
    const click = add({ ts: t0, dur: dur + 40, kind: "ui.click", name: `Clic : ${name}`, route: "/portail/locataires", attrs: { target: { tag: "button", text: name, component: "Panel" } } });
    const cl = add({ parent_id: click.id, ts: t0 + 4, dur: dur + 20, kind: "net.client", name: `POST ${route}`, route: "/portail/locataires", attrs: { method: "POST", status: 200, request_bytes: 120 } });
    return add({ parent_id: cl.id, ts: t0 + 15, dur, kind: "net.server", name: `POST ${route}`, route, attrs: { status: 200 } });
  };
  if (kind === 0) { // the program's own math is wrong: rent + increase is recorded as 1337 instead of 1236
    const click = add({ ts: t0, dur: 14, kind: "ui.click", name: "Clic : Calculer", route: "/portail/outils", attrs: { target: { tag: "button", text: "Calculer", component: "TalCalculator" } } });
    add({ parent_id: click.id, ts: t0 + 2, dur: 3, kind: "calc", name: "calculerAugmentationLoyer", route: "/portail/outils", attrs: {
      inputs: { loyerActuel: 1200, taux: 0.03 },
      steps: [{ label: "increase = rent × rate", expr: "1200 × 0.03", result: 36 }, { label: "new rent = rent + increase", expr: "1200 + 36", result: 1337 }], output: 1337 } });
  } else if (kind === 1) { // N+1: one query per tenant instead of one query
    const sv = reqChain("Afficher les locataires", "/api/locataires/list", 900);
    for (let i = 0; i < 14; i++) add({ parent_id: sv.id, ts: t0 + 30 + i * 55, dur: 40, kind: "db", name: "select tenant_profiles", attrs: { op: "select", table: "tenant_profiles", filters: { id: `eq.ten_${i}` }, status: 200 } });
  } else if (kind === 2) { // the same insert twice: a double charge waiting to happen
    const sv = reqChain("Enregistrer le paiement", "/api/revenus/add", 160);
    for (let i = 0; i < 2; i++) add({ parent_id: sv.id, ts: t0 + 30 + i * 40, dur: 30, kind: "db", name: "insert revenus", attrs: { op: "insert", table: "revenus", input: { owner_id: owner, amount: 1236, month: "2026-10" }, status: 201 } });
  } else if (kind === 3) { // a request that touches two different owners' rows
    const sv = reqChain("Charger le tableau de bord", "/api/dashboard/summary", 220);
    add({ parent_id: sv.id, ts: t0 + 30, dur: 40, kind: "db", name: "select revenus", attrs: { op: "select", table: "revenus", filters: { owner_id: `eq.${owner}` }, status: 200 } });
    add({ parent_id: sv.id, ts: t0 + 80, dur: 40, kind: "db", name: "select depenses", attrs: { op: "select", table: "depenses", filters: { owner_id: "eq.own_SOMEONE_ELSE" }, status: 200 } });
  } else if (kind === 4) { // rage click: the button seems dead, the user hammers it
    for (let i = 0; i < 4; i++) add({ trace_id: "t_rage" + hex(5), ts: t0 + i * 300, dur: 5, kind: "ui.click", name: "Clic : Envoyer le rappel", route: "/portail/locataires", status: i === 0 ? "dead" : "ok", attrs: { target: { tag: "button", text: "Envoyer le rappel", component: "ReminderButton" } } });
  } else { // a lookup fails, the page still answers 200 and the user is told nothing
    const sv = reqChain("Ouvrir la fiche", "/api/locataires/fiche", 180);
    add({ parent_id: sv.id, ts: t0 + 30, dur: 60, kind: "db", name: "select notification_prefs", status: "error", error: err("PostgrestError", "canceling statement due to statement timeout", ["lirePreferences (src/app/api/locataires/fiche/route.ts:62:20)"]), attrs: { op: "select", table: "notification_prefs", status: 500 } });
  }
}

/** PAD enrollment flow; `add` pushes into the calling action's span list. */
function enroll(t0, add, fail) {
  const click = add({ ts: t0, dur: 400, kind: "ui.click", name: "Click: Enroll in PAD", route: "/locataire/paiements", status: fail ? "error" : "ok",
    error: fail ? err("Error", "Enrollment failed", ["onEnroll (PadEnroll.tsx:33:9)"]) : undefined });
  const cl = add({ parent_id: click.id, ts: t0 + 3, dur: 380, kind: "net.client", name: "POST /api/zum/enroll", route: "/locataire/paiements", status: fail ? "error" : "ok",
    error: fail ? err("HttpError", "502 Bad Gateway", ["apiPost (portalApi.ts:120:11)"]) : undefined, attrs: { status: fail ? 502 : 200 } });
  const sv = add({ parent_id: cl.id, ts: t0 + 15, dur: 350, kind: "net.server", name: "POST /api/zum/enroll", route: "/api/zum/enroll", status: fail ? "error" : "ok",
    error: fail ? err("Error", "Zum Rails request failed", ["zumFetch (src/app/lib/zumClient.ts:61:13)"], [{ name: "TimeoutError", message: "The operation was aborted due to timeout" }]) : undefined, attrs: { status: fail ? 502 : 200 } });
  add({ parent_id: sv.id, ts: t0 + 25, dur: fail ? 300 : 210, kind: "external", name: "POST api.zumrails.com/v1/enroll", status: fail ? "error" : "ok",
    error: fail ? err("TimeoutError", "The operation was aborted due to timeout", ["fetch (node:internal)"]) : undefined, attrs: { host: "api.zumrails.com", status: fail ? 0 : 200 } });
}

async function post(spans) {
  for (let i = 0; i < spans.length; i += 400) {
    const res = await fetch(URL_ + "/ingest", {
      method: "POST", headers: { "content-type": "application/json", ...(TOKEN ? { "x-trace-token": TOKEN } : {}) },
      body: JSON.stringify({ spans: spans.slice(i, i + 400) }),
    });
    if (!res.ok) throw new Error(`ingest ${res.status}: ${await res.text()}`);
  }
}

const parseRange = (s) => { const m = s.match(/^(\d+)(m|h|d)$/); return m ? Number(m[1]) * { m: 60e3, h: 3600e3, d: 86400e3 }[m[2]] : 0; };

async function main() {
  if (BACKFILL) {
    const range = parseRange(BACKFILL); const now = Date.now(); const spans = [];
    if (RELEASES) releaseAt = now - range * 0.4;
    // ~RATE/10 actions per second of history (6 h at the default rate ≈ 13k actions ≈ 50k spans)
    const total = Math.round((range / 1000) * RATE * 0.1);
    for (let i = 0; i < total; i++) {
      const t = now - range + (i / total) * range;
      // gentle daily-shaped load + one bad hour so the charts have something to show
      const bad = t > now - range * 0.35 && t < now - range * 0.3;
      const prev = stormUntil; if (bad) stormUntil = Date.now() + 1000;
      spans.push(...action(t, pick(users)));
      stormUntil = prev;
    }
    await post(spans);
    console.log(`backfilled ${spans.length} spans over ${BACKFILL}`);
    return;
  }
  if (RELEASES) releaseAt = 0; // live traffic runs on the newest build
  const end = DURATION ? Date.now() + DURATION * 1000 : Infinity;
  if (STORM) setTimeout(() => { stormUntil = Date.now() + STORM * 1000; console.log(`storm: /api/zum/enroll failing for ${STORM}s`); }, 10000);
  console.log(`simulating ${N_USERS} users at ~${RATE} actions/s → ${URL_}  (Ctrl+C to stop)`);
  let sent = 0;
  while (Date.now() < end) {
    const batch = [];
    const n = Math.max(1, Math.round(RATE));
    for (let i = 0; i < n; i++) batch.push(...action(Date.now() - between(0, 300), pick(users)));
    try { await post(batch); sent += batch.length; } catch (e) { console.error(e.message); }
    await new Promise((r) => setTimeout(r, 1000));
  }
  console.log(`done, ${sent} spans sent`);
}
main().catch((e) => { console.error(e); process.exit(1); });
