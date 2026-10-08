/**
 * Enregistreur de traces — noyau partagé navigateur / serveur.
 *
 * Alimente la console locale `qa/console` (format : qa/console/SCHEMA.md).
 *
 * INERTE PAR DÉFAUT et JAMAIS en production : rien ne s'installe sans
 *   - serveur    : TRACE_CONSOLE=1
 *   - navigateur : NEXT_PUBLIC_TRACE_CONSOLE=1
 * ET NODE_ENV !== "production". Aucune dépendance (ni node:*, ni DOM) dans ce fichier.
 */

export type SpanKind =
  | "ui.click" | "ui.input" | "ui.nav" | "render" | "longtask"
  | "net.client" | "net.server" | "db" | "external" | "calc" | "fn" | "invariant" | "log" | "error" | "crash" | "health";

export type SpanStatus = "ok" | "error" | "slow" | "dead";

export interface TraceError {
  name: string;
  message: string;
  stack?: string;
  code?: string;
  /** Chaîne de causes, de la plus externe à la plus interne. */
  cause?: Array<{ name: string; message: string; stack?: string }>;
}

export interface TraceSpan {
  id: string;
  trace_id: string;
  parent_id?: string | null;
  /** Début, en millisecondes epoch (fractions permises). */
  ts: number;
  dur?: number;
  kind: SpanKind;
  name: string;
  status?: SpanStatus;
  source: "browser" | "server";
  user_id?: string;
  session_id?: string;
  role?: "owner" | "tenant" | "delegate" | "admin" | "anonymous";
  route?: string;
  attrs?: Record<string, unknown>;
  error?: TraceError;
  app_version?: string;
  env?: string;
}

/** Côté serveur : activé seulement hors production ET avec TRACE_CONSOLE=1. */
export function traceEnabledServer(): boolean {
  return process.env.NODE_ENV !== "production" && process.env.TRACE_CONSOLE === "1";
}

/** Identifiant de build : permet à la console de situer un problème dans une version. */
export function appVersion(): string | undefined {
  return process.env.NEXT_PUBLIC_BUILD_ID || process.env.VERCEL_GIT_COMMIT_SHA?.slice(0, 7) || undefined;
}

export function newId(prefix: string): string {
  const b = new Uint8Array(6);
  globalThis.crypto.getRandomValues(b);
  return prefix + Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
}

function safeString(v: unknown): string {
  try {
    if (typeof v === "string") return v.slice(0, 500);
    return (JSON.stringify(v) ?? String(v)).slice(0, 500);
  } catch {
    return String(v).slice(0, 500);
  }
}

/** Convertit n'importe quelle valeur levée (Error, objet PostgREST, string…) en TraceError. */
export function errorToObject(e: unknown): TraceError {
  if (e instanceof Error) {
    const cause: NonNullable<TraceError["cause"]> = [];
    let c: unknown = (e as { cause?: unknown }).cause;
    for (let i = 0; c && i < 6; i++) {
      if (c instanceof Error) {
        cause.push({ name: c.name, message: c.message, stack: c.stack });
        c = (c as { cause?: unknown }).cause;
      } else {
        cause.push({ name: "Cause", message: safeString(c) });
        break;
      }
    }
    const code = (e as { code?: unknown }).code;
    return {
      name: e.name,
      message: e.message,
      stack: e.stack,
      ...(code != null ? { code: String(code) } : {}),
      ...(cause.length ? { cause } : {}),
    };
  }
  if (e && typeof e === "object") {
    const o = e as Record<string, unknown>;
    return {
      name: String(o.name ?? "NonErrorThrown"),
      message: String(o.message ?? safeString(e)),
      ...(o.code != null ? { code: String(o.code) } : {}),
    };
  }
  return { name: "NonErrorThrown", message: safeString(e) };
}

/**
 * File d'envoi par lots. `post` est fourni par l'appelant (beacon côté navigateur,
 * fetch brut côté serveur). Un échec d'envoi jette le lot : l'enregistreur ne doit
 * JAMAIS gêner l'application, ni retenir de la mémoire sans borne.
 */
export function createSender(
  post: (spans: TraceSpan[]) => void | Promise<void>,
  opts: { intervalMs?: number; maxQueue?: number; batchSize?: number } = {},
) {
  const intervalMs = opts.intervalMs ?? 1000;
  const maxQueue = opts.maxQueue ?? 2000;
  const batchSize = opts.batchSize ?? 400;
  let queue: TraceSpan[] = [];
  let timer: ReturnType<typeof setTimeout> | null = null;
  let dropped = 0;
  let sent = 0;

  async function flush(): Promise<void> {
    if (timer) { clearTimeout(timer); timer = null; }
    while (queue.length) {
      const batch = queue.splice(0, batchSize);
      try { await post(batch); sent += batch.length; } catch { dropped += batch.length; }
    }
  }
  function push(span: TraceSpan): void {
    queue.push(span);
    if (queue.length > maxQueue) { dropped += queue.length - maxQueue; queue = queue.slice(-maxQueue); }
    if (!timer) {
      timer = setTimeout(() => { void flush(); }, intervalMs);
      // Node : ne pas retenir le processus ouvert pour un envoi de traces.
      (timer as unknown as { unref?: () => void }).unref?.();
    }
  }
  return { push, flush, get dropped() { return dropped; }, get sent() { return sent; }, get queued() { return queue.length; } };
}
