#!/usr/bin/env node
/**
 * Tire la télémétrie de PRODUCTION vers la console locale.
 *
 *   TRACE_EXPORT_TOKEN=<jeton> node qa/console/sources/pull.mjs --source=https://immoadmin.ca/api/telemetry/export
 *
 * Options :  --once            une seule passe puis quitte (sinon boucle)
 *            --interval=15     secondes entre deux passes (défaut 15)
 *            --console=http://127.0.0.1:4317   où poster (défaut : la console locale)
 *            --from-start      ignore le curseur enregistré et relit depuis le début
 *            --dry-run         affiche ce qui serait envoyé, ne poste rien
 *
 * Lecture seule côté serveur (jeton porteur, route /api/telemetry/export). Le curseur (dernier id lu) est gardé dans
 * qa/console/data/pull-cursor.json : on peut arrêter et relancer sans doublon ni trou.
 * Le jeton n'est JAMAIS passé en argument (il resterait dans l'historique du terminal) : variable d'environnement seulement.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CURSOR_FILE = path.join(HERE, "..", "data", "pull-cursor.json");

/** Ligne de stockage (TelemetryRow) → span de la console (SCHEMA.md). Pure. */
export function rowToSpan(r) {
  const ts = Date.parse(r.ts);
  const attrs = { ...(r.attrs && typeof r.attrs === "object" ? r.attrs : {}), tier: r.tier };
  if (r.release == null) delete attrs.release;
  return {
    id: String(r.span_id), trace_id: String(r.trace_id), parent_id: r.parent_id ?? null,
    ts: Number.isFinite(ts) ? ts : Date.now(), dur: r.dur ?? null,
    kind: r.kind, name: r.name, status: r.status,
    user_id: r.user_ref ?? null, session_id: r.session_id, role: r.role ?? null, route: r.route ?? null,
    attrs, error: r.error && typeof r.error === "object" ? r.error : null,
    app_version: r.release ?? null, source: "prod", env: "production",
  };
}

const readCursor = () => { try { return Number(JSON.parse(fs.readFileSync(CURSOR_FILE, "utf8")).after) || 0; } catch { return 0; } };
const writeCursor = (after) => { fs.mkdirSync(path.dirname(CURSOR_FILE), { recursive: true }); fs.writeFileSync(CURSOR_FILE, JSON.stringify({ after, at: new Date().toISOString() })); };

/**
 * Une passe : lit toutes les pages disponibles, poste à la console, avance le curseur APRÈS un envoi réussi.
 * @returns {{pulled:number, posted:number, after:number}}
 */
export async function pullOnce({ source, token, consoleUrl, after, dryRun = false, fetchImpl = fetch, save = writeCursor, pageSize = 500, maxPages = 40 }) {
  let pulled = 0, posted = 0;
  for (let page = 0; page < maxPages; page++) {
    const res = await fetchImpl(`${source}?after=${after}&limit=${pageSize}`, { headers: { authorization: `Bearer ${token}` } });
    if (res.status === 404) throw new Error("Export désactivé côté serveur (TRACE_EXPORT_TOKEN absent ou trop court).");
    if (res.status === 401) throw new Error("Jeton refusé (401) : TRACE_EXPORT_TOKEN ne correspond pas à celui du serveur.");
    if (!res.ok) throw new Error(`Export en erreur : HTTP ${res.status}`);
    const body = await res.json();
    const rows = Array.isArray(body.rows) ? body.rows : [];
    if (!rows.length) break;
    pulled += rows.length;
    if (!dryRun) {
      for (let i = 0; i < rows.length; i += 400) {
        const spans = rows.slice(i, i + 400).map(rowToSpan);
        const r = await fetchImpl(`${consoleUrl}/ingest`, { method: "POST", headers: { "content-type": "application/json", "x-console": "1", ...(process.env.CONSOLE_TOKEN ? { "x-trace-token": process.env.CONSOLE_TOKEN } : {}) }, body: JSON.stringify({ spans }) });
        if (!r.ok) throw new Error(`La console a refusé le lot : HTTP ${r.status}`);
        posted += spans.length;
      }
    }
    after = Number(body.next) || after;
    if (!dryRun) save(after);
    if (!body.more) break;
  }
  return { pulled, posted, after };
}

async function main() {
  const args = process.argv.slice(2);
  const get = (n, d) => { const h = args.find((a) => a === `--${n}` || a.startsWith(`--${n}=`)); return !h ? d : h.includes("=") ? h.slice(h.indexOf("=") + 1) : true; };
  const source = String(get("source", "")).replace(/\/$/, "");
  const token = process.env.TRACE_EXPORT_TOKEN || "";
  if (!source) { console.error("Il manque --source=https://<votre-site>/api/telemetry/export"); process.exit(2); }
  if (!/^https:\/\//.test(source) && !/^http:\/\/(localhost|127\.0\.0\.1)(:|\/|$)/.test(source)) { console.error("La source doit être en https (ou localhost pour un essai)."); process.exit(2); }
  if (token.length < 24) { console.error("Définissez TRACE_EXPORT_TOKEN (24 caractères ou plus) dans l'environnement — pas en argument."); process.exit(2); }
  const consoleUrl = String(get("console", "http://127.0.0.1:4317")).replace(/\/$/, "");
  const intervalS = Math.max(5, parseInt(String(get("interval", "15")), 10) || 15);
  const once = !!get("once", false), dryRun = !!get("dry-run", false);
  let after = get("from-start", false) ? 0 : readCursor();
  console.log(`Pull ${source} → ${consoleUrl}  (curseur ${after}${dryRun ? ", dry-run" : ""})`);
  for (;;) {
    try {
      const r = await pullOnce({ source, token, consoleUrl, after, dryRun });
      after = r.after;
      if (r.pulled) console.log(`[${new Date().toLocaleTimeString()}] ${r.pulled} événements lus, ${r.posted} envoyés (curseur ${after})`);
    } catch (e) {
      console.error(`[${new Date().toLocaleTimeString()}] ${e.message}`);
      if (/désactivé|refusé/.test(e.message)) process.exit(1); // inutile de réessayer en boucle
    }
    if (once) break;
    await new Promise((r) => setTimeout(r, intervalS * 1000));
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
