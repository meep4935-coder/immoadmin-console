/**
 * Enregistreur de PRODUCTION (navigateur) — logique PURE, sans DOM : échantillonnage, niveau selon le consentement,
 * tampon circulaire, plafonds de débit, file bornée, recul exponentiel. Testée en isolation (aucun navigateur requis).
 */

/** Hachage FNV-1a 32 bits → entier 0–99. Déterministe : une session est TOUJOURS dans ou hors de l'échantillon. */
export function hashToPct(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
  return h % 100;
}
export const isSampled = (sessionId: string, pct: number): boolean => pct > 0 && hashToPct(sessionId) < pct;

/** B = clics, navigation, messages : seulement si le serveur l'autorise ET que l'utilisateur a accepté les cookies. */
export const activeTier = (serverAllowsB: boolean, consent: unknown): "A" | "B" =>
  serverAllowsB && consent === "accepted" ? "B" : "A";

/** Mémoire des derniers événements : sert de « contexte » quand un problème survient dans une session hors échantillon. */
export class RingBuffer<T> {
  private items: T[] = [];
  constructor(private readonly cap: number) {}
  push(x: T): void { this.items.push(x); if (this.items.length > this.cap) this.items.shift(); }
  snapshot(): T[] { return [...this.items]; }
  clear(): void { this.items = []; }
  removeWhere(pred: (x: T) => boolean): void { this.items = this.items.filter((x) => !pred(x)); }
  get length(): number { return this.items.length; }
}

/** File bornée : au-delà de la capacité, on jette les PLUS ANCIENS (jamais de croissance sans borne). */
export class BoundedQueue<T> {
  private items: T[] = [];
  dropped = 0;
  constructor(private readonly cap: number) {}
  push(x: T): void { this.items.push(x); while (this.items.length > this.cap) { this.items.shift(); this.dropped++; } }
  take(n: number): T[] { return this.items.splice(0, n); }
  removeWhere(pred: (x: T) => boolean): void { this.items = this.items.filter((x) => !pred(x)); }
  get length(): number { return this.items.length; }
}

/** Plafonds par minute : le trafic normal est limité plus strictement que les problèmes (qu'on veut garder). */
export class Governor {
  private windowStart = 0;
  private normal = 0;
  private problem = 0;
  constructor(private readonly normalCap = 30, private readonly problemCap = 10) {}
  allow(isProblem: boolean, now: number): boolean {
    if (now - this.windowStart >= 60_000) { this.windowStart = now; this.normal = 0; this.problem = 0; }
    if (isProblem) return ++this.problem <= this.problemCap;
    return ++this.normal <= this.normalCap;
  }
}

/** Délai avant le prochain envoi : 10 s, doublé à chaque échec consécutif, plafonné à 5 min. */
export const backoffMs = (failures: number, base = 10_000, max = 300_000): number => Math.min(max, base * 2 ** Math.min(Math.max(0, failures), 10));
