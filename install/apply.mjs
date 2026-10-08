#!/usr/bin/env node
/**
 * Installateur du paquet de télémétrie ImmoAdmin.
 *
 *   node install/apply.mjs --repo=<dossier du dépôt> --dry-run      # montre ce qui serait fait, ne touche à rien
 *   node install/apply.mjs --repo=<dossier du dépôt>                # installe (fichiers + instrumentation + cron)
 *   node install/apply.mjs --repo=<dossier du dépôt> --with-proxy --approved-by="Frédérick"   # + patch du verrou protégé
 *   node install/apply.mjs --repo=<dossier du dépôt> --undo         # retire tout ce qui a été installé
 *
 * Garanties :
 *  • AUCUN changement de comportement : tout est éteint tant que TRACE_PROD_ENABLED n'est pas « 1 » ET TRACE_PSEUDONYM_SECRET défini.
 *  • Atomique : tout est vérifié AVANT d'écrire quoi que ce soit (intégrité du paquet, dépôt, conflits, patchs applicables).
 *  • Réversible : .trace-install.json garde la liste exacte des fichiers et des patchs ; --undo les retire.
 *  • Ne touche JAMAIS src/proxy.ts sans --with-proxy ET --approved-by (fichier protégé : approbation explicite requise).
 *  • N'écrit aucun secret, ne lit aucune variable d'environnement de l'application, ne fait aucun appel réseau.
 *  • Ne commit pas, ne pousse pas : les changements restent dans l'arbre de travail pour relecture.
 */
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const PKG = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const flag = (n) => args.includes(`--${n}`);
const val = (n) => { const h = args.find((a) => a.startsWith(`--${n}=`)); return h ? h.slice(n.length + 3) : ""; };

const REPO = path.resolve(val("repo") || "");
const DRY = flag("dry-run"), UNDO = flag("undo"), WITH_PROXY = flag("with-proxy"), VERIFY = flag("verify");
const APPROVER = val("approved-by").trim();
const RECORD = path.join(REPO, ".trace-install.json");

const say = (m = "") => console.log(m);
const ok = (m) => say(`  ✓ ${m}`);
const die = (m, hint) => { console.error(`\n  ✗ ${m}${hint ? `\n    → ${hint}` : ""}\n`); process.exit(1); };
const sha = (buf) => crypto.createHash("sha256").update(buf).digest("hex");
const norm = (buf) => sha(Buffer.from(buf.toString("utf8").replace(/\r\n/g, "\n"))); // CRLF/LF n'est pas une différence
const git = (a, opts = {}) => spawnSync("git", a, { cwd: REPO, encoding: "utf8", ...opts });

function walk(dir, base = dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    return e.isDirectory() ? walk(p, base) : [path.relative(base, p).split(path.sep).join("/")];
  });
}

if (!val("repo")) die("Il manque --repo=<dossier du dépôt ImmoAdmin>.", "Exemple : node install/apply.mjs --repo=C:\\projets\\immoadmin --dry-run");
if (!fs.existsSync(path.join(REPO, "package.json"))) die(`Pas de package.json dans ${REPO}.`, "Pointez --repo vers la racine du dépôt (le dossier qui contient package.json et src/).");

// ── annulation ───────────────────────────────────────────────────────────────
if (UNDO) {
  if (!fs.existsSync(RECORD)) die("Rien à annuler : .trace-install.json est absent.", "Le paquet n'a pas été installé avec cet outil dans ce dépôt.");
  const rec = JSON.parse(fs.readFileSync(RECORD, "utf8"));
  say(`\nAnnulation de l'installation du ${rec.at}${DRY ? "  (essai à blanc)" : ""}\n`);
  for (const p of [...rec.patches].reverse()) {
    const patch = path.join(PKG, "patches", p);
    const args2 = ["apply", "-R", "--ignore-whitespace"];
    const chk = git([...args2, "--check", patch]);
    if (chk.status !== 0) die(`Le patch ${p} ne peut plus être retiré proprement (le fichier a changé depuis).`, "Retirez ses lignes à la main (elles sont marquées « Télémétrie ») ou faites : git checkout -- <fichier>.");
    if (!DRY) git([...args2, patch]);
    ok(`patch retiré : ${p}`);
  }
  for (const f of rec.files) {
    const target = path.join(REPO, f.path);
    if (!fs.existsSync(target)) continue;
    if (norm(fs.readFileSync(target)) !== f.norm) { say(`  ! ${f.path} a été modifié depuis l'installation : laissé en place`); continue; }
    if (!DRY) fs.rmSync(target);
    ok(`fichier retiré : ${f.path}`);
  }
  if (!DRY) {
    // retire les dossiers vides laissés derrière
    for (const f of rec.files) { let d = path.dirname(path.join(REPO, f.path)); while (d.startsWith(REPO) && d !== REPO) { try { fs.rmdirSync(d); } catch { break; } d = path.dirname(d); } }
    fs.rmSync(RECORD);
  }
  say(`\n  Terminé${DRY ? " (essai à blanc : rien n'a été modifié)" : ""}. Pensez à retirer aussi les variables TRACE_* de Vercel si vous les aviez ajoutées.\n`);
  process.exit(0);
}

say(`\nInstallation de la télémétrie dans ${REPO}${DRY ? "  (ESSAI À BLANC : rien ne sera écrit)" : ""}\n`);

// ── 1. intégrité du paquet ──────────────────────────────────────────────────
const manifestPath = path.join(PKG, "MANIFEST.sha256");
if (!fs.existsSync(manifestPath)) die("MANIFEST.sha256 introuvable : le paquet est incomplet.");
const bad = [];
for (const line of fs.readFileSync(manifestPath, "utf8").split(/\r?\n/).filter(Boolean)) {
  const m = line.match(/^([0-9a-f]{64})\s+\*?(.+)$/); if (!m) continue;
  const f = path.join(PKG, m[2]);
  if (!fs.existsSync(f) || sha(fs.readFileSync(f)) !== m[1]) bad.push(m[2]);
}
if (bad.length) die(`Paquet altéré ou corrompu (${bad.length} fichier(s) ne correspondent pas) : ${bad.slice(0, 5).join(", ")}`, "Redemandez le paquet à la source ; ne l'installez pas.");
ok("intégrité du paquet vérifiée (MANIFEST.sha256)");

// ── 2. le dépôt est-il le bon, est-il propre ? ──────────────────────────────
const pj = JSON.parse(fs.readFileSync(path.join(REPO, "package.json"), "utf8"));
if (!(pj.dependencies?.next || pj.devDependencies?.next)) die("Ce dépôt n'utilise pas Next.js : ce paquet ne lui est pas destiné.");
for (const need of ["src/proxy.ts", "instrumentation.ts", "instrumentation-client.ts", "vercel.json", "src/app/api/_lib/cron-auth.ts"]) {
  if (!fs.existsSync(path.join(REPO, need))) die(`Fichier attendu absent : ${need}.`, "Ce n'est pas la même version du dépôt que celle pour laquelle le paquet a été préparé.");
}
for (const dep of ["@supabase/supabase-js", "@supabase/ssr"]) if (!(pj.dependencies?.[dep] || pj.devDependencies?.[dep])) die(`Dépendance manquante : ${dep}.`);
ok(`dépôt reconnu : ${pj.name ?? "(sans nom)"}, Next ${pj.dependencies?.next ?? pj.devDependencies?.next}`);
if (fs.existsSync(RECORD)) die("Déjà installé (.trace-install.json existe).", "Faites d'abord --undo si vous voulez réinstaller.");
const isGit = git(["rev-parse", "--is-inside-work-tree"]).stdout?.trim() === "true";
if (!isGit) die("Ce dossier n'est pas un dépôt git.", "Initialisez-le ou installez dans le clone git, afin que tout changement soit relisible (git diff).");
const dirty = git(["status", "--porcelain", "--", "src", "instrumentation.ts", "instrumentation-client.ts", "vercel.json", "scripts"]).stdout.trim();
if (dirty) die("Des fichiers concernés ont déjà des modifications non enregistrées :\n" + dirty.split("\n").slice(0, 8).map((l) => "      " + l).join("\n"), "Enregistrez-les (commit) ou rangez-les (git stash) d'abord, pour que l'installation soit relisible seule.");
ok("arbre de travail propre sur les fichiers concernés");

// ── 3. fichiers à copier : aucun conflit ────────────────────────────────────
const APP = path.join(PKG, "app");
const toCopy = []; const conflicts = [];
for (const rel of walk(APP)) {
  const src = fs.readFileSync(path.join(APP, rel)); const dest = path.join(REPO, rel);
  if (fs.existsSync(dest)) { if (norm(fs.readFileSync(dest)) === norm(src)) continue; conflicts.push(rel); }
  else toCopy.push({ path: rel, norm: norm(src) });
}
if (conflicts.length) die(`Des fichiers existent déjà avec un contenu DIFFÉRENT :\n${conflicts.map((c) => "      " + c).join("\n")}`, "Ne rien écraser : comparez-les (c'est peut-être une version précédente de l'enregistreur) et décidez avec l'équipe.");
ok(`${toCopy.length} fichier(s) à ajouter, aucun conflit`);

// ── 4. patchs applicables ? ─────────────────────────────────────────────────
const patches = ["01-instrumentation-cron-guard.patch"];
if (WITH_PROXY) {
  if (!APPROVER) die("--with-proxy exige --approved-by=\"<nom>\".", "src/proxy.ts est protégé (verrou pré-lancement) : seule la personne qui l'approuve peut demander ce patch.");
  patches.push("02-proxy-PROTEGE-approbation-requise.patch");
}
for (const p of patches) {
  const r = git(["apply", "--ignore-whitespace", "--check", path.join(PKG, "patches", p)]);
  if (r.status !== 0) die(`Le patch ${p} ne s'applique pas à ce dépôt.`, `Détail git : ${(r.stderr || "").trim().split("\n")[0]}\n    Le dépôt a probablement changé depuis la préparation du paquet : demandez un paquet régénéré (les patchs sont courts, ils peuvent aussi être appliqués à la main — voir DEPLOY-GUIDE.md §4).`);
  ok(`patch applicable : ${p}`);
}
if (!WITH_PROXY) say("  · patch du verrou protégé (proxy.ts) : NON appliqué (il faut --with-proxy --approved-by=\"<nom>\"). Voir DEPLOY-GUIDE.md §5.");

if (DRY) {
  say("\n  Fichiers qui seraient ajoutés :");
  for (const f of toCopy) say(`    + ${f.path}`);
  say("\n  Essai à blanc terminé : RIEN n'a été modifié.\n");
  process.exit(0);
}

// ── 5. écriture ─────────────────────────────────────────────────────────────
const written = [];
const rollback = () => { for (const f of written) { try { fs.rmSync(path.join(REPO, f.path)); } catch { /* déjà parti */ } } };
try {
  for (const f of toCopy) {
    const dest = path.join(REPO, f.path);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, fs.readFileSync(path.join(APP, f.path)));
    written.push(f);
  }
} catch (e) { rollback(); die(`Écriture interrompue (${e.message}) : tout a été remis comme avant.`); }
const applied = [];
for (const p of patches) {
  const r = git(["apply", "--ignore-whitespace", path.join(PKG, "patches", p)]);
  if (r.status !== 0) { for (const q of [...applied].reverse()) git(["apply", "-R", "--ignore-whitespace", path.join(PKG, "patches", q)]); rollback(); die(`Le patch ${p} a échoué à l'application : tout a été remis comme avant.`, (r.stderr || "").trim()); }
  applied.push(p);
}
fs.writeFileSync(RECORD, JSON.stringify({ at: new Date().toISOString(), approvedBy: WITH_PROXY ? APPROVER : null, files: written, patches: applied }, null, 2));
ok(`${written.length} fichier(s) ajouté(s), ${applied.length} patch(s) appliqué(s)`);

// ── 6. vérification facultative ─────────────────────────────────────────────
if (VERIFY) {
  say("\n  Vérification (tsc + tests de l'enregistreur) — quelques minutes…");
  const npx = process.platform === "win32" ? "npx.cmd" : "npx";
  const t = spawnSync(npx, ["tsc", "--noEmit"], { cwd: REPO, encoding: "utf8", shell: process.platform === "win32" });
  if (t.status !== 0) say(`  ✗ tsc a signalé des erreurs :\n${(t.stdout || "").split("\n").slice(0, 15).join("\n")}\n    → ne déployez pas ; envoyez cette sortie à la personne qui a préparé le paquet.`);
  else ok("tsc : aucune erreur");
  const v = spawnSync(npx, ["vitest", "run", "src/app/lib/trace/prod/prod.test.ts"], { cwd: REPO, encoding: "utf8", shell: process.platform === "win32" });
  const m = (v.stdout + v.stderr).match(/Tests\s+(.*)/);
  say(v.status === 0 ? `  ✓ tests de l'enregistreur : ${m ? m[1].trim() : "réussis"}` : `  ✗ tests de l'enregistreur en échec :\n${(v.stdout + v.stderr).split("\n").slice(-20).join("\n")}`);
}

say(`
  Terminé. RIEN n'est encore actif : l'enregistreur est éteint tant que les variables TRACE_* ne sont pas posées sur Vercel.

  Étapes suivantes (détail dans DEPLOY-GUIDE.md) :
    1. git diff            → relire ce qui a changé (fichiers ajoutés : git status)
    2. git commit (sur la branche), puis npm run verify → les garde-fous du projet (test-aucun-residu-de-banc exige un arbre enregistré)
    3. Créer le projet Supabase de télémétrie et y exécuter sql/telemetry.sql
    4. Déployer avec TRACE_PROD_ENABLED=0 (dormant), puis suivre le plan de mise en service
${WITH_PROXY ? "" : "\n  ⚠ Le patch du verrou (proxy.ts) n'a pas été appliqué : sans lui, /api/telemetry peut être bloqué par le verrou pré-lancement / la facturation.\n    Voir DEPLOY-GUIDE.md §5 (il demande l'approbation de la personne responsable du verrou).\n"}`);
