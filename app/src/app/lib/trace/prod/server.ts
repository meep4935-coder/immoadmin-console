/**
 * Enregistreur de PRODUCTION — logique serveur.
 *
 * Toute la logique est dans des fonctions qui reçoivent leurs dépendances (`Deps`) : la base, la lecture de session, le limiteur,
 * l'interrupteur à distance. Les fichiers `route.ts` ne font que les brancher. Résultat : chaque comportement (coupure à distance,
 * limite de débit, panne du stockage…) se teste sans Next ni Supabase.
 *
 * Règles qui ne souffrent AUCUNE exception :
 *  • un échec ici ne doit JAMAIS affecter la requête d'un utilisateur : on répond 200/204 et on jette ;
 *  • rien n'est stocké sans être passé par `sanitizeEvent` (liste blanche) ;
 *  • aucune lecture de la base principale ; le stockage est un projet séparé.
 */
import { createHash, timingSafeEqual } from "node:crypto";
import { errorToObject, newId } from "../core";
import { readProdConfig, remoteKilled, type ProdConfig } from "./config";
import { sanitizeEvent } from "./events";
import { userRef } from "./pseudonym";
import { getSink, toRow, type TelemetryRow, type TraceSink } from "./sink";
import { normalizeRoute } from "../supabase";

export interface Identity { userId: string | null; email: string | null }
export interface Deps {
  env: Record<string, string | undefined>;
  now: () => number;
  sink: TraceSink;
  readFlag?: () => Promise<string | null>;
  getIdentity: (req: Request) => Promise<Identity>;
  /** true = autorisé. */
  limiter: (key: string, limit: number) => Promise<boolean>;
}

export const MAX_BODY_BYTES = 64 * 1024;
export const MAX_EVENTS = 50;
const SESSION_LIMIT_PER_MIN = 60;
const IP_LIMIT_PER_MIN = 240;

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", "cache-control": "no-store", ...headers } });

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  let t: ReturnType<typeof setTimeout>;
  return Promise.race([p, new Promise<never>((_, rej) => { t = setTimeout(() => rej(new Error("timeout")), ms); })]).finally(() => clearTimeout(t));
}
const ipKey = (req: Request) => {
  const ip = (req.headers.get("x-forwarded-for") ?? req.headers.get("x-real-ip") ?? "unknown").split(",")[0].trim();
  return createHash("sha256").update(ip).digest("hex").slice(0, 12); // jamais l'adresse brute
};
function safeEqual(a: string, b: string): boolean {
  const ha = createHash("sha256").update(a).digest(), hb = createHash("sha256").update(b).digest();
  return timingSafeEqual(ha, hb);
}
const roleOf = (route: string | null) =>
  !route ? "anonymous" : route.startsWith("/locataire") ? "tenant" : route.startsWith("/portail") || route.startsWith("/baux") ? "owner"
    : route.startsWith("/admin") ? "admin" : route.startsWith("/delegue") ? "delegate" : "anonymous";

type Decision = { on: false; reason: "off" | "killed" | "not_allowed"; cfg: ProdConfig } | { on: true; cfg: ProdConfig; identity: Identity };

/** Est-ce qu'on enregistre pour CETTE requête ? (interrupteur maître, coupure à distance, liste d'autorisation) */
async function decide(req: Request, deps: Deps): Promise<Decision> {
  const cfg = readProdConfig(deps.env);
  if (!cfg.enabled) return { on: false, reason: "off", cfg };
  if (await remoteKilled(deps.readFlag, deps.now())) return { on: false, reason: "killed", cfg };
  let identity: Identity = { userId: null, email: null };
  try { identity = await withTimeout(deps.getIdentity(req), 800); } catch { /* anonyme */ }
  if (cfg.allowlist.length && !(identity.email && cfg.allowlist.includes(identity.email.toLowerCase()))) return { on: false, reason: "not_allowed", cfg };
  return { on: true, cfg, identity };
}

/** GET /api/telemetry — dit au navigateur s'il doit enregistrer, et comment. Aucune donnée n'est stockée. */
export async function handleConfig(req: Request, deps: Deps): Promise<Response> {
  const d = await decide(req, deps);
  if (!d.on) return json({ enabled: false, killed: d.reason === "killed" });
  return json({ enabled: true, tierB: d.cfg.tierB, samplePct: d.cfg.samplePct, clickText: d.cfg.clickText, messageText: d.cfg.messageText });
}

/** POST /api/telemetry — reçoit un lot d'événements. */
export async function handleIngest(req: Request, deps: Deps): Promise<Response> {
  try {
    const d = await decide(req, deps);
    if (!d.on) return json({ enabled: false, killed: d.reason === "killed" });

    if (!(await deps.limiter(`ip:${ipKey(req)}`, IP_LIMIT_PER_MIN))) return json({ error: "rate_limited" }, 429, { "retry-after": "30" });

    const text = await req.text();
    if (text.length > MAX_BODY_BYTES) return json({ error: "too_large" }, 413);
    let body: unknown;
    try { body = JSON.parse(text); } catch { return json({ error: "invalid_json" }, 400); }
    const b = body as { events?: unknown; consent?: unknown } | null;
    if (!b || !Array.isArray(b.events)) return json({ error: "events_required" }, 400);

    const now = deps.now();
    const tierB = d.cfg.tierB && b.consent === true; // le consentement est affirmé par le navigateur ; l'interrupteur serveur, lui, est autoritaire
    const ref = d.identity.userId ? userRef(deps.env.TRACE_PSEUDONYM_SECRET as string, d.identity.userId) : null;

    const rows: TelemetryRow[] = [];
    for (const raw of b.events.slice(0, MAX_EVENTS)) {
      const e = sanitizeEvent(raw, { tierB, clickText: d.cfg.clickText, messageText: d.cfg.messageText, errorMessage: d.cfg.errorMessage, now });
      if (e) rows.push(toRow(e, { user_ref: ref, role: roleOf(e.route) }));
    }
    if (!rows.length) return json({ ok: true, enabled: true, accepted: 0 });

    if (!(await deps.limiter(`s:${rows[0].session_id}`, SESSION_LIMIT_PER_MIN))) return json({ error: "rate_limited" }, 429, { "retry-after": "30" });

    let dropped = 0;
    try { await withTimeout(deps.sink.write(rows), 2500); } catch { dropped = rows.length; } // stockage en panne : on jette, l'utilisateur n'en saura rien
    return json({ ok: true, enabled: true, accepted: rows.length - dropped, dropped });
  } catch {
    return json({ ok: false }, 200); // quoi qu'il arrive, jamais une erreur serveur visible
  }
}

/** GET /api/telemetry/export — lecture seule pour la console locale. Jeton porteur (TRACE_EXPORT_TOKEN) ; absent = fonction inexistante (404). */
export async function handleExport(req: Request, deps: Deps): Promise<Response> {
  const token = deps.env.TRACE_EXPORT_TOKEN;
  if (!token || token.length < 24) return new Response(null, { status: 404 });
  const given = (req.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "");
  if (!safeEqual(given, token)) return json({ error: "unauthorized" }, 401);
  if (!(await deps.limiter(`export:${ipKey(req)}`, 60))) return json({ error: "rate_limited" }, 429, { "retry-after": "30" });
  const u = new URL(req.url);
  const after = Math.max(0, Math.floor(Number(u.searchParams.get("after")) || 0));
  const limit = Math.min(1000, Math.max(1, Math.floor(Number(u.searchParams.get("limit")) || 500)));
  try {
    const r = await deps.sink.read(after, limit);
    return json({ rows: r.rows, next: r.next, more: r.rows.length === limit });
  } catch {
    return json({ error: "read_failed" }, 502);
  }
}

/** Purge de rétention — appelée par la route cron APRÈS assertCronAuth. */
export async function handlePurge(deps: Pick<Deps, "env" | "now" | "sink">): Promise<Response> {
  const cfg = readProdConfig(deps.env);
  const cutoff = new Date(deps.now() - cfg.retentionDays * 86_400_000).toISOString();
  try { return json({ purged: await deps.sink.purge(cutoff), cutoff, retentionDays: cfg.retentionDays }); }
  catch { return json({ error: "purge_failed" }, 502); }
}

/** Effacement d'un compte (Loi 25). À appeler depuis le cron de suppression de comptes : la référence se recalcule, aucun index à tenir. */
export async function deleteTelemetryForUser(userId: string, deps?: Pick<Deps, "env" | "sink">): Promise<number> {
  const env = deps?.env ?? process.env;
  const secret = env.TRACE_PSEUDONYM_SECRET;
  if (!secret || secret.length < 16) return 0;
  const sink = deps?.sink ?? getSink(readProdConfig(env).sink, env);
  try { return await sink.deleteUser(userRef(secret, userId)); } catch { return 0; }
}

// ── erreurs serveur non gérées (hook onRequestError de Next) ─────────────────────
let errWindow = { start: 0, n: 0 };

export async function reportServerError(
  err: unknown,
  request: { path: string; method: string },
  context: { routePath?: string },
  deps: Pick<Deps, "env" | "now" | "sink"> = { env: process.env, now: Date.now, sink: getSink(readProdConfig(process.env).sink, process.env) },
): Promise<void> {
  try {
    const cfg = readProdConfig(deps.env);
    if (!cfg.enabled || (await remoteKilled(undefined, deps.now()))) return;
    const now = deps.now();
    if (now - errWindow.start > 60_000) errWindow = { start: now, n: 0 };
    if (++errWindow.n > 20) return; // une boucle d'erreurs ne doit pas inonder le stockage
    const route = normalizeRoute((context.routePath ?? request.path ?? "/").split("?")[0]);
    const e = sanitizeEvent({
      id: newId("sp_"), trace_id: newId("t_"), ts: now, dur: 0, kind: "error", name: `Erreur serveur : ${route}`, status: "error", route,
      session_id: "server_" + newId("").slice(0, 10), error: errorToObject(err), attrs: { source: "server", method: request.method },
    }, { tierB: false, clickText: false, messageText: false, errorMessage: cfg.errorMessage, now });
    if (e) await withTimeout(deps.sink.write([toRow(e, { user_ref: null, role: null })]), 1500);
  } catch { /* jamais d'effet sur la requête */ }
}

// ── limiteur de débit ──────────────────────────────────────────────────────────
const upstashLimiters = new Map<number, unknown>();

/** Upstash si configuré (comme le reste du projet), sinon compteur en mémoire par instance (meilleur effort). */
export function makeLimiter(env: Record<string, string | undefined> = process.env): Deps["limiter"] {
  const mem = new Map<string, { n: number; reset: number }>();
  return async (key, limit) => {
    if (env.UPSTASH_REDIS_REST_URL && env.UPSTASH_REDIS_REST_TOKEN) {
      try {
        const { Redis } = await import("@upstash/redis");
        const { Ratelimit } = await import("@upstash/ratelimit");
        let rl = upstashLimiters.get(limit) as InstanceType<typeof Ratelimit> | undefined;
        if (!rl) {
          rl = new Ratelimit({ redis: new Redis({ url: env.UPSTASH_REDIS_REST_URL, token: env.UPSTASH_REDIS_REST_TOKEN }), limiter: Ratelimit.slidingWindow(limit, "60 s"), prefix: "trace:rl" });
          upstashLimiters.set(limit, rl);
        }
        return (await rl.limit(key)).success;
      } catch { /* repli sur la mémoire */ }
    }
    const now = Date.now();
    const e = mem.get(key);
    if (!e || now > e.reset) {
      if (mem.size > 5000) mem.clear();
      mem.set(key, { n: 1, reset: now + 60_000 });
      return true;
    }
    return ++e.n <= limit;
  };
}

export function defaultDeps(getIdentity: Deps["getIdentity"]): Deps {
  const cfg = readProdConfig(process.env);
  return { env: process.env, now: Date.now, sink: getSink(cfg.sink, process.env), getIdentity, limiter: makeLimiter(process.env) };
}
