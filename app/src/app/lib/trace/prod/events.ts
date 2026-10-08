/**
 * Filtre de confidentialité — AUTORITAIRE, côté serveur.
 *
 * Le navigateur n'est pas digne de confiance : tout événement reçu est reconstruit champ par champ à partir d'une LISTE BLANCHE.
 * Ce qui n'est pas explicitement permis est jeté (pas masqué : jeté). Les chaînes qui restent sont purgées des motifs
 * personnels (courriels, téléphones, UUID, jetons, longs nombres) et tronquées.
 *
 * Ce fichier est PUR (aucun effet, aucune dépendance) : il se teste en isolation.
 */
import { normalizeRoute } from "../supabase";

export type Tier = "A" | "B";
export type Status = "ok" | "error" | "slow" | "dead";

export interface CleanError {
  name: string; message: string; code?: string; stack?: string; cause?: Array<{ name: string; message: string }>;
}
export interface CleanEvent {
  id: string; trace_id: string; parent_id: string | null; ts: number; dur: number | null;
  kind: string; name: string; status: Status; route: string | null; session_id: string; release: string | null;
  tier: Tier; attrs: Record<string, unknown>; error: CleanError | null;
}
export interface SanitizeOptions { tierB: boolean; clickText: boolean; messageText: boolean; errorMessage: boolean; now: number }

// ── purge des motifs personnels dans une chaîne ───────────────────────────────
const PATTERNS: Array<[RegExp, string]> = [
  [/eyJ[\w-]{10,}\.[\w-]{10,}\.[\w-]{10,}/g, "[jwt]"],
  [/\b(?:sk|rk|pk)_(?:live|test)_\w{8,}/g, "[secret]"],
  [/\b(?:whsec|ima_live)_\w{8,}/g, "[secret]"],
  [/\bBearer\s+[\w.~+/=-]{8,}/gi, "Bearer [x]"],
  [/[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g, "[courriel]"],
  [/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, "[id]"],
  [/(?<!\d)(?:\+?1[\s.-]?)?\(?\d{3}\)?[\s.-]\d{3}[\s.-]\d{4}(?!\d)/g, "[tel]"],
  [/\b\d{3}[\s-]\d{3}[\s-]\d{3}\b/g, "[nombre]"],      // NAS « 123 456 789 »
  [/\b\d{9,}\b/g, "[nombre]"],                          // cartes, comptes, NAS compact…
  [/(https?:\/\/[^\s?#"')<>]+)[?#][^\s"')<>]*/g, "$1"], // retire requête et ancre des URL
];

/** Chaîne purgée et tronquée. `max` est la longueur FINALE maximale. */
export function scrubText(s: unknown, max: number): string {
  if (typeof s !== "string") return "";
  let out = s;
  for (const [re, rep] of PATTERNS) out = out.replace(re, rep);
  out = out.replace(/\s+/g, " ").trim();
  return out.length > max ? `${out.slice(0, Math.max(0, max - 1))}…` : out;
}

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const int = (v: unknown, min: number, max: number): number | undefined =>
  typeof v === "number" && Number.isFinite(v) ? Math.min(max, Math.max(min, Math.round(v))) : undefined;
const bool = (v: unknown): boolean | undefined => (typeof v === "boolean" ? v : undefined);
// Un identifiant (composant, gestionnaire, balise…) n'a que des caractères « de code » — mais « 514-555-0147 » en est un : on le purge aussi.
const ident = (v: unknown, max: number): string | undefined =>
  typeof v === "string" && /^[\w$.:-]+$/.test(v) ? scrubText(v, max) || undefined : undefined;
const pick = <T extends string>(v: unknown, allowed: readonly T[]): T | undefined => (allowed.includes(v as T) ? (v as T) : undefined);
const strip = (o: Record<string, unknown>): Record<string, unknown> => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined));

/** Chemin seul (pas de domaine, pas de requête), normalisé : « /api/leases/:id ». */
function routeOf(v: unknown): string | null {
  if (typeof v !== "string") return null;
  let p = v;
  try { p = /^https?:/i.test(v) ? new URL(v).pathname : v; } catch { return null; }
  p = p.split(/[?#]/)[0];
  if (!p.startsWith("/") || p.length > 200) return null;
  // Un segment de chemin peut contenir une donnée personnelle (courriel, numéro…) : on purge APRÈS la normalisation.
  return scrubText(normalizeRoute(p), 120) || null;
}
/** Fichier d'une trace : chemin sans requête, sans domaine, purgé (le champ arrive du navigateur : il peut contenir n'importe quoi). */
function fileOf(v: unknown): string | undefined {
  if (typeof v !== "string") return undefined;
  try { const p = /^https?:/i.test(v) ? new URL(v).pathname : v.split(/[?#]/)[0]; return scrubText(p, 120) || undefined; } catch { return undefined; }
}

const A_KINDS = ["error", "crash", "net.client", "longtask", "ui.input", "health", "ui.nav"] as const;
const B_KINDS = ["ui.click", "render"] as const;
const EFFECTS = ["dom", "focus", "network", "navigation", "input", "change", "hashchange", "pagehide", "opens-elsewhere"] as const;
const METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD"] as const;

/**
 * Limite assumée : les motifs connus (courriels, téléphones, jetons…) sont purgés, mais un secret écrit en MOTS ORDINAIRES dans un
 * message ne peut pas être reconnu. Si ce risque n'est pas acceptable, `includeMessage=false` retire tout texte de message
 * (nom, code et trames de pile restent) — voir TRACE_PROD_ERROR_MESSAGE.
 */
function cleanError(e: unknown, includeMessage: boolean): CleanError | null {
  if (!isObj(e)) return null;
  const out: CleanError = { name: ident(e.name, 60) ?? "Error", message: includeMessage ? scrubText(e.message, 200) : "" };
  const code = scrubText(e.code, 24); if (code) out.code = code;
  // Sans message, on retire aussi la première ligne de la pile (« Error: <message> »).
  const rawStack = typeof e.stack === "string" && !includeMessage ? e.stack.split("\n").slice(1).join("\n") : e.stack;
  const stack = scrubText(rawStack, 1500); if (stack) out.stack = stack;
  if (Array.isArray(e.cause)) {
    out.cause = e.cause.slice(0, 3).filter(isObj).map((c) => ({ name: ident(c.name, 60) ?? "Error", message: includeMessage ? scrubText(c.message, 120) : "" }));
    if (!out.cause.length) delete out.cause;
  }
  return out;
}

/** Reconstruit les attributs permis pour ce type d'événement. @returns null si l'événement doit être jeté. */
function cleanAttrs(kind: string, a: Record<string, unknown>, o: SanitizeOptions): { attrs: Record<string, unknown>; tier: Tier } | null {
  switch (kind) {
    case "net.client":
      return { tier: "A", attrs: strip({ method: pick(String(a.method ?? "").toUpperCase(), METHODS), route: routeOf(a.route ?? a.url), status: int(a.status, 0, 599), ok: bool(a.ok), response_bytes: int(a.response_bytes, 0, 1e9), rsc: bool(a.rsc), unsampled: bool(a.unsampled) }) };
    case "error":
    case "crash":
      return { tier: "A", attrs: strip({ source: pick(a.source, ["react", "window", "promise", "resource", "server"] as const), component: ident(a.component, 60), file: fileOf(a.file), line: int(a.line, 0, 1e7), col: int(a.col, 0, 1e7), tag: ident(a.tag, 12), method: pick(String(a.method ?? "").toUpperCase(), METHODS), unsampled: bool(a.unsampled) }) };
    case "longtask": {
      const scripts = Array.isArray(a.scripts) ? a.scripts.slice(0, 5).filter(isObj).map((s) => strip({ source: fileOf(s.source), fn: ident(s.fn, 60), ms: int(s.ms, 0, 6e5) })) : undefined;
      return { tier: "A", attrs: strip({ blocking_ms: int(a.blocking_ms, 0, 6e5), scripts, unsampled: bool(a.unsampled) }) };
    }
    case "ui.input": {
      const t = isObj(a.target) && o.tierB ? strip({ tag: ident(a.target.tag, 12), role: ident(a.target.role, 24), component: ident(a.target.component, 60) }) : undefined;
      return { tier: t && Object.keys(t).length ? "B" : "A", attrs: strip({ input_delay_ms: int(a.input_delay_ms, 0, 6e5), handler_ms: int(a.handler_ms, 0, 6e5), presentation_ms: int(a.presentation_ms, 0, 6e5), target: t && Object.keys(t).length ? t : undefined }) };
    }
    case "health":
      return { tier: "A", attrs: strip({ dropped: int(a.dropped, 0, 1e9), sent: int(a.sent, 0, 1e9), queued: int(a.queued, 0, 1e9), client_now: int(a.client_now, 0, 9e15) }) };
    case "ui.nav":
      if (a.phase === "load") return { tier: "A", attrs: strip({ phase: "load", type: ident(a.type, 20), ttfb_ms: int(a.ttfb_ms, 0, 6e5), dom_content_loaded_ms: int(a.dom_content_loaded_ms, 0, 6e5), load_ms: int(a.load_ms, 0, 6e5), transfer_bytes: int(a.transfer_bytes, 0, 1e10) }) };
      if (!o.tierB) return null;
      return { tier: "B", attrs: strip({ phase: "route", from: routeOf(a.from), to: routeOf(a.to) }) };
    case "ui.click": {
      if (!o.tierB) return null;
      const t = isObj(a.target) ? a.target : {};
      const target = strip({
        tag: ident(t.tag, 12), role: ident(t.role, 24), component: ident(t.component, 60), handler: ident(t.handler, 60),
        has_onclick_prop: bool(t.has_onclick_prop), disabled: bool(t.disabled), testid: ident(t.testid, 40),
        text: o.clickText ? scrubText(t.text, 40) || undefined : undefined,
      });
      const effects = Array.isArray(a.effects) ? a.effects.slice(0, 8).filter((e): e is (typeof EFFECTS)[number] => EFFECTS.includes(e as never)) : [];
      return { tier: "B", attrs: strip({ target, effects, feedback_tracked: bool(a.feedback_tracked), heuristic: bool(a.heuristic) }) };
    }
    case "render": {
      if (!o.tierB) return null;
      const text = typeof a.text === "string" ? a.text : "";
      return { tier: "B", attrs: strip({ type: ident(a.type, 20), negative: bool(a.negative), from: pick(a.from, ["toast", "banner"] as const), text_len: int(a.text_len ?? text.length, 0, 1000), text: o.messageText ? scrubText(text, 120) || undefined : undefined }) };
    }
    default:
      return null;
  }
}

const MAX_EVENT_BYTES = 4096;
const DAY = 86_400_000;

/** @returns l'événement nettoyé, ou null s'il doit être jeté (type inconnu, niveau B non permis, forme invalide, trop gros). */
export function sanitizeEvent(raw: unknown, o: SanitizeOptions): CleanEvent | null {
  if (!isObj(raw)) return null;
  const kind = typeof raw.kind === "string" ? raw.kind : "";
  if (![...A_KINDS, ...B_KINDS].includes(kind as never)) return null;

  const id = ident(raw.id, 64), trace_id = ident(raw.trace_id, 64);
  const session_id = typeof raw.session_id === "string" && /^[\w.-]{6,64}$/.test(raw.session_id) ? raw.session_id : null;
  if (!id || !trace_id || !session_id) return null;

  const a = isObj(raw.attrs) ? raw.attrs : {};
  const cleaned = cleanAttrs(kind, a, o);
  if (!cleaned) return null;

  let ts = typeof raw.ts === "number" && Number.isFinite(raw.ts) ? raw.ts : o.now;
  if (Math.abs(ts - o.now) > DAY) ts = o.now; // horloge cliente aberrante
  const durRaw = typeof raw.dur === "number" && Number.isFinite(raw.dur) && raw.dur >= 0 ? raw.dur : null;

  const ev: CleanEvent = {
    id, trace_id, parent_id: ident(raw.parent_id, 64) ?? null, ts, dur: durRaw === null ? null : Math.min(durRaw, 6e5),
    kind, name: scrubText(raw.name, 120) || kind, status: pick(raw.status, ["ok", "error", "slow", "dead"] as const) ?? "ok",
    route: routeOf(raw.route), session_id,
    release: typeof raw.app_version === "string" && /^[\w.+-]{1,40}$/.test(raw.app_version) ? raw.app_version : null,
    tier: cleaned.tier, attrs: cleaned.attrs, error: cleanError(raw.error, o.errorMessage),
  };
  if (ev.error && ev.status !== "dead") ev.status = "error";
  return JSON.stringify(ev).length > MAX_EVENT_BYTES ? null : ev;
}
