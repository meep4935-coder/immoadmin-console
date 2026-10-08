#!/usr/bin/env node
/**
 * Test de fumée d'un déploiement — à lancer APRÈS le déploiement (Preview d'abord).
 *
 *   node install/smoke-test.mjs --url=https://<votre-preview>.vercel.app              # état dormant ou actif
 *   TRACE_EXPORT_TOKEN=<jeton> node install/smoke-test.mjs --url=https://… --expect=on   # actif : envoie un événement et le retrouve
 *
 * --expect=off   (défaut si TRACE_EXPORT_TOKEN absent)  vérifie que l'enregistreur est bien DORMANT : rien n'est accepté.
 * --expect=on    vérifie qu'il est actif : la config est lue, un événement SYNTHÉTIQUE d'erreur est envoyé, et — si le jeton d'export
 *                est fourni — il est retrouvé dans le stockage, puis le jeton erroné est refusé.
 *
 * L'événement envoyé est reconnaissable (nom « SMOKE-TEST », session « smoke_… ») et ne contient aucune donnée réelle.
 * Le jeton n'est lu que dans l'environnement (jamais en argument).
 */
import crypto from "node:crypto";

const get = (n, d = "") => { const h = process.argv.slice(2).find((a) => a.startsWith(`--${n}=`)); return h ? h.slice(n.length + 3) : d; };
const base = get("url").replace(/\/$/, "");
const token = process.env.TRACE_EXPORT_TOKEN || "";
const expect = get("expect", token ? "on" : "off");
const bypass = process.env.VERCEL_AUTOMATION_BYPASS_SECRET || ""; // Preview protégée par Vercel : jeton de contournement (facultatif)

if (!/^https?:\/\//.test(base)) { console.error("Il manque --url=https://<site ou preview>"); process.exit(2); }
if (!["on", "off"].includes(expect)) { console.error("--expect doit valoir on ou off"); process.exit(2); }

let pass = 0, fail = 0;
const check = (name, ok, extra = "") => { ok ? pass++ : fail++; console.log(`  ${ok ? "✓" : "✗ ÉCHEC"} ${name}${ok ? "" : "\n      → " + extra}`); return ok; };
const headers = (h = {}) => ({ ...h, ...(bypass ? { "x-vercel-protection-bypass": bypass } : {}) });
const call = async (p, init = {}) => {
  try {
    const r = await fetch(base + p, { ...init, headers: headers(init.headers), redirect: "manual" });
    let body = null; const t = await r.text(); try { body = JSON.parse(t); } catch { /* pas du JSON */ }
    return { status: r.status, body, text: t.slice(0, 160), location: r.headers.get("location") };
  } catch (e) { return { status: 0, body: null, text: String(e.message) }; }
};

console.log(`\nTest de fumée : ${base}   (attendu : ${expect === "on" ? "ACTIF" : "DORMANT"})\n`);

const cfg = await call("/api/telemetry");
if (cfg.status === 401 || cfg.status === 403 || (cfg.status >= 300 && cfg.status < 400)) {
  check("la route /api/telemetry est joignable", false, `HTTP ${cfg.status}${cfg.location ? " → " + cfg.location : ""}. Preview protégée par Vercel ? définissez VERCEL_AUTOMATION_BYPASS_SECRET. Sinon : le patch de proxy.ts manque (verrou pré-lancement / abonnement) — DEPLOY-GUIDE.md §5.`);
} else if (check("la route /api/telemetry répond (GET → JSON)", cfg.status === 200 && cfg.body && typeof cfg.body.enabled === "boolean", `HTTP ${cfg.status} ${cfg.text}`)) {
  if (expect === "off") {
    check("l'enregistreur est DORMANT (enabled=false)", cfg.body.enabled === false, "enabled=true : TRACE_PROD_ENABLED est actif sur ce déploiement.");
    const ev = { id: "sp_smoke0001", trace_id: "t_smoke0001", ts: Date.now(), kind: "error", name: "SMOKE-TEST", status: "error", route: "/smoke", session_id: "smoke_" + crypto.randomBytes(4).toString("hex"), error: { name: "SmokeTestError", message: "synthetic" } };
    const post = await call("/api/telemetry", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ events: [ev] }) });
    check("un événement envoyé en mode dormant n'est PAS accepté", post.status === 200 && post.body?.enabled === false && !post.body?.accepted, `HTTP ${post.status} ${post.text}`);
    const exp = await call("/api/telemetry/export", { headers: { authorization: "Bearer " + "x".repeat(32) } });
    check("l'export est fermé (404 sans TRACE_EXPORT_TOKEN, 401 avec un mauvais jeton)", exp.status === 404 || exp.status === 401, `HTTP ${exp.status}`);
  } else {
    check("l'enregistreur est ACTIF (enabled=true)", cfg.body.enabled === true, cfg.body.killed ? "coupé par l'interrupteur Redis (trace:enabled=0)" : "enabled=false : vérifiez TRACE_PROD_ENABLED=1, TRACE_PSEUDONYM_SECRET (≥16 caractères) et, si définie, TRACE_PROD_ALLOWLIST (un visiteur anonyme n'y figure pas).");
    const sid = "smoke_" + crypto.randomBytes(4).toString("hex");
    const tag = "SMOKE-TEST " + sid;
    const ev = { id: "sp_" + sid, trace_id: "t_" + sid, ts: Date.now(), kind: "error", name: tag, status: "error", route: "/smoke", session_id: sid, error: { name: "SmokeTestError", message: "synthetic" } };
    const post = await call("/api/telemetry", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ events: [ev] }) });
    // Un visiteur anonyme est refusé quand une liste d'autorisation est définie : ce n'est pas une panne.
    if (post.body?.enabled === false) console.log("  · l'ingestion refuse ce visiteur anonyme (liste d'autorisation) : normal pendant l'étape « fondateurs » ; le reste du test est sauté.");
    else if (check("l'événement synthétique est accepté", post.status === 200 && post.body?.accepted === 1, `HTTP ${post.status} ${post.text}`)) {
      check("…et écrit dans le stockage (dropped = 0)", post.body.dropped === 0, "dropped>0 : le stockage a refusé l'écriture — TRACE_SINK=supabase, URL/clé du projet dédié, sql/telemetry.sql exécuté ?");
      if (token) {
        const bad = await call("/api/telemetry/export?after=0&limit=1", { headers: { authorization: "Bearer " + "x".repeat(token.length) } });
        check("un mauvais jeton d'export est refusé (401)", bad.status === 401, `HTTP ${bad.status}`);
        let found = false;
        for (let after = 0, page = 0; page < 40 && !found; page++) {
          const exp = await call(`/api/telemetry/export?after=${after}&limit=1000`, { headers: { authorization: "Bearer " + token } });
          if (!check(`export lisible (page ${page + 1})`, exp.status === 200 && Array.isArray(exp.body?.rows), `HTTP ${exp.status} ${exp.text}`)) break;
          found = exp.body.rows.some((r) => r.name === tag);
          if (!exp.body.more) break;
          after = exp.body.next;
        }
        check("l'événement synthétique est retrouvé via l'export", found, "écrit mais introuvable : vérifiez que l'export lit le même projet que l'ingestion.");
      } else console.log("  · TRACE_EXPORT_TOKEN absent : la relecture n'est pas testée.");
    }
  }
}

console.log(`\n  ${pass} réussi(s), ${fail} échec(s)\n`);
process.exit(fail ? 1 : 0);
