/**
 * Enregistreur de traces — CONFIGURATION DE PRODUCTION.
 *
 * TOUT EST ÉTEINT PAR DÉFAUT. Rien ne s'enregistre tant que :
 *   • TRACE_PROD_ENABLED=1, ET
 *   • TRACE_PSEUDONYM_SECRET est défini (sans lui, on refuse de démarrer : pas de pseudonymisation = pas d'enregistrement), ET
 *   • l'interrupteur à distance (clé Redis `trace:enabled`) n'est pas à « 0 ».
 *
 * Voir qa/console/PRODUCTION-ROLLOUT.md et DEPLOY-GUIDE.md.
 */

export const KILL_KEY = "trace:enabled";
export type SinkName = "noop" | "supabase";

export interface ProdConfig {
  /** Interrupteur maître ET secret de pseudonymisation présent. */
  enabled: boolean;
  /** Niveau B (clics, navigation, messages) permis — il reste conditionné au consentement cookies, vérifié côté navigateur. */
  tierB: boolean;
  /** Part (0–100) des sessions qui enregistrent le trafic NORMAL. Les erreurs sont toujours envoyées, même hors échantillon. */
  samplePct: number;
  sink: SinkName;
  retentionDays: number;
  /** Si non vide : seuls ces courriels (minuscules) reçoivent enabled=true. Sert à la mise en place progressive (étape « fondateurs »). */
  allowlist: string[];
  /** Texte des boutons cliqués / des messages affichés. ÉTEINT par défaut : un libellé peut contenir un nom de personne. */
  clickText: boolean;
  messageText: boolean;
  /** Texte des messages d'erreur. ALLUMÉ par défaut (indispensable pour diagnostiquer) ; TRACE_PROD_ERROR_MESSAGE=0 le retire entièrement. */
  errorMessage: boolean;
}

type Env = Record<string, string | undefined>;

const num = (v: string | undefined, d: number, min: number, max: number): number => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : d;
};

export function readProdConfig(env: Env = process.env): ProdConfig {
  const on = env.TRACE_PROD_ENABLED === "1";
  const secret = !!env.TRACE_PSEUDONYM_SECRET && env.TRACE_PSEUDONYM_SECRET.length >= 16;
  return {
    enabled: on && secret,
    tierB: env.TRACE_PROD_TIER_B === "1",
    samplePct: num(env.TRACE_PROD_SAMPLE_PCT, 0, 0, 100),
    sink: env.TRACE_SINK === "supabase" ? "supabase" : "noop",
    retentionDays: Math.round(num(env.TRACE_RETENTION_DAYS, 14, 1, 90)),
    allowlist: (env.TRACE_PROD_ALLOWLIST ?? "").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean),
    clickText: env.TRACE_PROD_CLICK_TEXT === "1",
    messageText: env.TRACE_PROD_MESSAGE_TEXT === "1",
    errorMessage: env.TRACE_PROD_ERROR_MESSAGE !== "0",
  };
}

// ── interrupteur à distance ─────────────────────────────────────────────────
// Vercel n'applique un changement de variable d'environnement qu'au PROCHAIN déploiement. Pour couper
// immédiatement : mettre la clé Redis `trace:enabled` à « 0 » (Upstash est déjà une dépendance). La valeur est lue au plus
// toutes les 60 s ; les enregistreurs s'arrêtent à leur prochaine réponse.
let cache: { at: number; killed: boolean } | null = null;
const CACHE_MS = 60_000;

/**
 * @param readFlag lit la valeur brute de la clé (injectable pour les tests ; par défaut Upstash si configuré)
 * @returns true si l'enregistrement est COUPÉ à distance
 */
export async function remoteKilled(
  readFlag: () => Promise<string | null> = defaultReadFlag,
  now: number = Date.now(),
): Promise<boolean> {
  if (cache && now - cache.at < CACHE_MS) return cache.killed;
  let killed = false;
  try {
    const v = await readFlag();
    killed = v !== null && ["0", "false", "off", "no"].includes(String(v).trim().toLowerCase());
  } catch {
    // Redis injoignable : on garde la décision précédente (ou « pas coupé »). Un incident Redis ne doit pas, à lui seul, tout éteindre.
    killed = cache?.killed ?? false;
  }
  cache = { at: now, killed };
  return killed;
}

/** Pour les tests. */
export function resetKillCache(): void { cache = null; }

async function defaultReadFlag(): Promise<string | null> {
  const url = process.env.UPSTASH_REDIS_REST_URL, token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) return null; // pas de Redis : seule la variable d'environnement décide
  const { Redis } = await import("@upstash/redis");
  const v = await new Redis({ url, token }).get<string | number | null>(KILL_KEY);
  return v === null || v === undefined ? null : String(v);
}
