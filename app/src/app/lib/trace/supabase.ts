/**
 * Lecture des appels Supabase à partir de la requête HTTP — pur, sans dépendance.
 *
 * supabase-js ne fait que des fetch() vers PostgREST (`/rest/v1/<table>`,
 * `/rest/v1/rpc/<fn>`), Auth (`/auth/v1`) et Storage (`/storage/v1`). En lisant
 * l'URL et la méthode, on retrouve la table, l'opération et les filtres de CHAQUE
 * appel `.from(...)` du code, sans modifier aucun des ~3 000 sites d'appel.
 */
import type { TraceError } from "./core";

export interface DbCall {
  op: "select" | "head" | "insert" | "upsert" | "update" | "delete" | "rpc" | "auth" | "storage";
  table?: string;
  rpc?: string;
  filters?: Record<string, string>;
  select?: string;
  /** Libellé lisible : « upsert tenant_units », « rpc kv_cas_save »… */
  name: string;
}

const NON_FILTER = new Set(["select", "order", "limit", "offset", "columns", "on_conflict"]);

/** @returns null si l'URL n'est pas un appel Supabase connu. */
export function describeSupabaseRequest(method: string, url: URL, prefer?: string | null): DbCall | null {
  const m = method.toUpperCase();
  const p = url.pathname;

  if (p.startsWith("/auth/v1/")) {
    const rest = p.slice("/auth/v1/".length);
    return { op: "auth", name: `auth ${m} ${rest}` };
  }
  if (p.startsWith("/storage/v1/")) {
    const rest = p.slice("/storage/v1/".length);
    return { op: "storage", name: `storage ${m} ${rest}` };
  }
  if (!p.startsWith("/rest/v1/")) return null;

  const target = decodeURIComponent(p.slice("/rest/v1/".length));
  if (target.startsWith("rpc/")) {
    const fn = target.slice(4);
    return { op: "rpc", rpc: fn, name: `rpc ${fn}` };
  }

  const filters: Record<string, string> = {};
  for (const [k, v] of url.searchParams) if (!NON_FILTER.has(k)) filters[k] = v;
  const select = url.searchParams.get("select") ?? undefined;

  let op: DbCall["op"];
  if (m === "GET") op = "select";
  else if (m === "HEAD") op = "head";
  else if (m === "PATCH") op = "update";
  else if (m === "DELETE") op = "delete";
  else if (m === "POST" || m === "PUT") {
    op = /resolution=(merge|ignore)-duplicates/.test(prefer ?? "") || url.searchParams.has("on_conflict") ? "upsert" : "insert";
  } else op = "select";

  return {
    op, table: target, name: `${op} ${target}`,
    ...(Object.keys(filters).length ? { filters } : {}),
    ...(select ? { select } : {}),
  };
}

/** Corps d'erreur PostgREST `{code,message,details,hint}` → TraceError. */
export function describePostgrestError(bodyText: string, status: number): TraceError {
  try {
    const j = JSON.parse(bodyText) as { code?: unknown; message?: unknown; details?: unknown; hint?: unknown };
    if (j && typeof j === "object" && (j.message || j.code)) {
      const cause: NonNullable<TraceError["cause"]> = [];
      if (j.details) cause.push({ name: "Details", message: String(j.details) });
      if (j.hint) cause.push({ name: "Hint", message: String(j.hint) });
      return {
        name: "PostgrestError",
        message: String(j.message ?? `HTTP ${status}`),
        ...(j.code != null ? { code: String(j.code) } : {}),
        ...(cause.length ? { cause } : {}),
      };
    }
  } catch { /* corps non JSON */ }
  return { name: "HttpError", message: `HTTP ${status} ${bodyText.slice(0, 200)}`.trim() };
}

/** `/api/portal-kv/mutate`, `/signer/abc…` → regroupe les routes dynamiques (`:id`, `:token`). */
export function normalizeRoute(pathname: string): string {
  return pathname
    .split("/")
    .map((seg) => {
      if (!seg) return seg;
      if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(seg)) return ":id";
      if (/^\d{3,}$/.test(seg)) return ":id";
      if (/^[0-9a-f]{16,}$/i.test(seg)) return ":token";
      // Jeton long : un vrai jeton (base64, nanoid…) contient presque toujours un chiffre ; un mot long (« __nextjs_original-stack-frames ») non.
      if (/^[A-Za-z0-9_-]{24,}$/.test(seg) && /\d/.test(seg) && /[A-Za-z]/.test(seg)) return ":token";
      return seg;
    })
    .join("/") || "/";
}
