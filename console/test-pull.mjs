#!/usr/bin/env node
/** Adaptateur « pull » : lignes de production → console locale. Unitaire + bout en bout (vraie console, faux serveur d'export). */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { rowToSpan, pullOnce } from "./sources/pull.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
let pass = 0, fail = 0;
const check = (name, ok, extra = "") => { ok ? pass++ : fail++; console.log(`${ok ? "  ✓" : "  ✗ FAIL"} ${name}${ok ? "" : "  " + extra}`); };

const row = (i, o = {}) => ({ id: i, ts: new Date(1_800_000_000_000 + i * 1000).toISOString(), kind: "net.client", name: "POST /api/x", status: "ok", trace_id: `t${i}`, span_id: `s${i}`, parent_id: null, user_ref: "u_abc", session_id: "ss1", role: "tenant", route: "/locataire/:id", release: "r1", tier: "A", dur: 12, attrs: { a: 1 }, error: null, ...o });

console.log("\nrowToSpan");
const s = rowToSpan(row(1, { status: "error", error: { name: "E", message: "m" }, release: null }));
check("ts ISO → epoch ms", s.ts === 1_800_000_001_000);
check("id/trace/user mapped", s.id === "s1" && s.trace_id === "t1" && s.user_id === "u_abc");
check("source/env marked as production", s.source === "prod" && s.env === "production");
check("error object kept", s.error?.message === "m" && s.status === "error");
check("tier travels in attrs", s.attrs.tier === "A" && s.attrs.a === 1);
check("bad ts does not crash", Number.isFinite(rowToSpan(row(2, { ts: "nope" })).ts));

console.log("\npullOnce (faux fetch)");
const mk = (pages, { post = 200, status = 200 } = {}) => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    if (String(url).includes("/ingest")) return { ok: post === 200, status: post, json: async () => ({}) };
    if (status !== 200) return { ok: false, status, json: async () => ({}) };
    const after = Number(new URL(url).searchParams.get("after"));
    const p = pages.find((x) => x.after === after) ?? { rows: [], next: after, more: false };
    return { ok: true, status: 200, json: async () => p };
  };
  return { fetchImpl, calls };
};
{
  const saved = [];
  const { fetchImpl, calls } = mk([{ after: 0, rows: [row(1), row(2)], next: 2, more: true }, { after: 2, rows: [row(3)], next: 3, more: false }]);
  const r = await pullOnce({ source: "https://x/api/telemetry/export", token: "t".repeat(30), consoleUrl: "http://c", after: 0, fetchImpl, save: (a) => saved.push(a) });
  check("pages through all rows", r.pulled === 3 && r.posted === 3 && r.after === 3);
  check("cursor saved after each page", JSON.stringify(saved) === "[2,3]");
  check("bearer token sent, never in the URL", calls[0].init.headers.authorization.startsWith("Bearer ") && !calls[0].url.includes("ttt"));
  check("posts carry the x-console header", calls.filter((c) => c.url.includes("/ingest")).every((c) => c.init.headers["x-console"] === "1"));
}
{
  const saved = [];
  const { fetchImpl } = mk([{ after: 0, rows: [row(1)], next: 1, more: false }], { post: 500 });
  let msg = ""; try { await pullOnce({ source: "https://x", token: "t".repeat(30), consoleUrl: "http://c", after: 0, fetchImpl, save: (a) => saved.push(a) }); } catch (e) { msg = e.message; }
  check("console refuses → error AND cursor NOT advanced (no data loss)", /refusé/.test(msg) && saved.length === 0);
}
for (const [code, re] of [[404, /désactivé/], [401, /Jeton refusé/], [503, /HTTP 503/]]) {
  const { fetchImpl } = mk([], { status: code });
  let msg = ""; try { await pullOnce({ source: "https://x", token: "t".repeat(30), consoleUrl: "http://c", after: 0, fetchImpl, save: () => {} }); } catch (e) { msg = e.message; }
  check(`HTTP ${code} → clear message`, re.test(msg), msg);
}
{
  const { fetchImpl, calls } = mk([{ after: 0, rows: [row(1)], next: 1, more: false }]);
  const r = await pullOnce({ source: "https://x", token: "t".repeat(30), consoleUrl: "http://c", after: 0, dryRun: true, fetchImpl, save: () => { throw new Error("must not save"); } });
  check("dry-run posts nothing and saves nothing", r.pulled === 1 && r.posted === 0 && !calls.some((c) => String(c.url).includes("/ingest")));
}

console.log("\nbout en bout (vraie console + faux serveur d'export)");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pull-e2e-"));
const CPORT = 4590 + Math.floor(Math.random() * 100);
const TOKEN = "e2e-export-token-0123456789abcdef";
const exportRows = [row(1), row(2, { kind: "error", status: "error", name: "Erreur serveur : /api/x", error: { name: "TypeError", message: "boom" } }), row(3, { user_ref: "u_def" })];
const fake = http.createServer((req, res) => {
  const u = new URL(req.url, "http://x");
  if (req.headers.authorization !== `Bearer ${TOKEN}`) { res.writeHead(401); return res.end("{}"); }
  const after = Number(u.searchParams.get("after")) || 0;
  const rows = exportRows.filter((r) => r.id > after);
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify({ rows, next: rows.length ? rows[rows.length - 1].id : after, more: false }));
});
await new Promise((r) => fake.listen(0, "127.0.0.1", r));
const FPORT = fake.address().port;
const consoleProc = spawn(process.execPath, [path.join(HERE, "server.mjs"), `--port=${CPORT}`, `--db=${path.join(tmp, "c.db")}`, "--mode=prod"], { stdio: "ignore" });
const up = async () => { for (let i = 0; i < 50; i++) { try { const r = await fetch(`http://127.0.0.1:${CPORT}/api/overview`, { headers: { "x-console": "1" } }); if (r.ok) return true; } catch { /* pas encore */ } await new Promise((r) => setTimeout(r, 200)); } return false; };
try {
  check("console started", await up());
  const run = (extra = []) => new Promise((resolve) => {
    const p = spawn(process.execPath, [path.join(HERE, "sources", "pull.mjs"), `--source=http://127.0.0.1:${FPORT}/api/telemetry/export`, `--console=http://127.0.0.1:${CPORT}`, "--once", ...extra], { env: { ...process.env, TRACE_EXPORT_TOKEN: TOKEN }, stdio: ["ignore", "pipe", "pipe"] });
    let out = ""; p.stdout.on("data", (d) => (out += d)); p.stderr.on("data", (d) => (out += d)); p.on("close", (code) => resolve({ code, out }));
  });
  const first = await run(["--from-start"]);
  check("pull exits 0 and reports 3 events", first.code === 0 && /3 événements lus, 3 envoyés/.test(first.out), first.out);
  const got = await Promise.all(["t1", "t2", "t3"].map((t) => fetch(`http://127.0.0.1:${CPORT}/api/trace/${t}`, { headers: { "x-console": "1" } }).then((r) => (r.ok ? r.json() : null))));
  check("console now holds the 3 production spans", got.every((g) => g?.spans?.length === 1), JSON.stringify(got).slice(0, 200));
  const e = got[1]?.spans?.[0];
  check("the production error arrived as an error with its message and a fingerprint", e?.status === "error" && /boom/.test(JSON.stringify(e.error)) && !!e.fingerprint, JSON.stringify(e)?.slice(0, 200));
  check("tagged as production", e?.source === "prod" && e?.user_id === "u_abc");
  const again = await run();
  check("second pull is incremental (cursor kept, no duplicates)", again.code === 0 && !/événements lus/.test(again.out), again.out);
  const badTok = await new Promise((resolve) => { const p = spawn(process.execPath, [path.join(HERE, "sources", "pull.mjs"), `--source=http://127.0.0.1:${FPORT}/x`, "--once"], { env: { ...process.env, TRACE_EXPORT_TOKEN: "short" }, stdio: ["ignore", "pipe", "pipe"] }); let o = ""; p.stderr.on("data", (d) => (o += d)); p.on("close", (c) => resolve({ c, o })); });
  check("short token refused before any request", badTok.c === 2 && /TRACE_EXPORT_TOKEN/.test(badTok.o));
  const plain = await new Promise((resolve) => { const p = spawn(process.execPath, [path.join(HERE, "sources", "pull.mjs"), "--source=http://example.com/api/telemetry/export", "--once"], { env: { ...process.env, TRACE_EXPORT_TOKEN: TOKEN }, stdio: ["ignore", "pipe", "pipe"] }); let o = ""; p.stderr.on("data", (d) => (o += d)); p.on("close", (c) => resolve({ c, o })); });
  check("plain http to a remote host refused", plain.c === 2 && /https/.test(plain.o));
} finally {
  consoleProc.kill(); fake.close();
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* fichier encore verrouillé sous Windows */ }
  try { fs.rmSync(path.join(HERE, "data", "pull-cursor.json"), { force: true }); } catch { /* absent */ }
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
