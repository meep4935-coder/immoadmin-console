/**
 * Où vont les événements : une INTERFACE, plusieurs adaptateurs. Le choix du stockage appartient aux propriétaires
 * (coût, fournisseur, hébergement des données) — le reste du code ne dépend d'aucun d'eux.
 *
 *   noop      (défaut) jette tout
 *   supabase  un projet Supabase DÉDIÉ à la télémétrie (recommandé : région Canada, séparé de la base principale)
 *   memory    pour les tests
 */
import type { CleanEvent } from "./events";
import type { SinkName } from "./config";

export interface TelemetryRow {
  id?: number;
  ts: string;                       // ISO
  kind: string; name: string; status: string;
  trace_id: string; span_id: string; parent_id: string | null;
  user_ref: string | null; session_id: string; role: string | null; route: string | null;
  release: string | null; tier: string; dur: number | null;
  attrs: Record<string, unknown>; error: Record<string, unknown> | null;
}

export interface TraceSink {
  write(rows: TelemetryRow[]): Promise<void>;
  /** Lecture paginée par identifiant croissant (pour la console locale). */
  read(afterId: number, limit: number): Promise<{ rows: TelemetryRow[]; next: number }>;
  /** Supprime tout ce qui est antérieur à `beforeIso`. @returns nombre de lignes supprimées (si connu) */
  purge(beforeIso: string): Promise<number>;
  /** Effacement d'un compte (Loi 25) : supprime tout ce qui porte cette référence. */
  deleteUser(ref: string): Promise<number>;
}

/** Convertit un événement nettoyé en ligne de stockage. */
export function toRow(e: CleanEvent, extra: { user_ref: string | null; role: string | null }): TelemetryRow {
  return {
    ts: new Date(e.ts).toISOString(), kind: e.kind, name: e.name, status: e.status,
    trace_id: e.trace_id, span_id: e.id, parent_id: e.parent_id,
    user_ref: extra.user_ref, session_id: e.session_id, role: extra.role, route: e.route,
    release: e.release, tier: e.tier, dur: e.dur, attrs: e.attrs, error: e.error as Record<string, unknown> | null,
  };
}

export class NoopSink implements TraceSink {
  async write(): Promise<void> { /* jette */ }
  async read(): Promise<{ rows: TelemetryRow[]; next: number }> { return { rows: [], next: 0 }; }
  async purge(): Promise<number> { return 0; }
  async deleteUser(): Promise<number> { return 0; }
}

export class MemorySink implements TraceSink {
  rows: Array<TelemetryRow & { id: number }> = [];
  failWrites = false;
  private seq = 0;
  async write(rows: TelemetryRow[]): Promise<void> {
    if (this.failWrites) throw new Error("sink indisponible");
    for (const r of rows) this.rows.push({ ...r, id: ++this.seq });
  }
  async read(afterId: number, limit: number) {
    const rows = this.rows.filter((r) => r.id > afterId).slice(0, limit);
    return { rows, next: rows.length ? rows[rows.length - 1].id : afterId };
  }
  async purge(beforeIso: string): Promise<number> {
    const n = this.rows.length; this.rows = this.rows.filter((r) => r.ts >= beforeIso); return n - this.rows.length;
  }
  async deleteUser(ref: string): Promise<number> {
    const n = this.rows.length; this.rows = this.rows.filter((r) => r.user_ref !== ref); return n - this.rows.length;
  }
}

/**
 * Projet Supabase DÉDIÉ (variables TRACE_SUPABASE_URL / TRACE_SUPABASE_SERVICE_KEY — PAS celles de la base principale).
 * Table : voir supabase/telemetry.sql. Le client service-role est créé DANS chaque appel (règle 7 du projet), jamais au niveau module.
 */
export class SupabaseSink implements TraceSink {
  constructor(private readonly url: string, private readonly key: string) {}
  private async db() {
    const { createClient } = await import("@supabase/supabase-js");
    return createClient(this.url, this.key, { auth: { persistSession: false, autoRefreshToken: false } });
  }
  async write(rows: TelemetryRow[]): Promise<void> {
    if (!rows.length) return;
    const { error } = await (await this.db()).from("telemetry_events").insert(rows);
    if (error) throw new Error(`telemetry insert: ${error.message}`);
  }
  async read(afterId: number, limit: number) {
    const { data, error } = await (await this.db()).from("telemetry_events").select("*").gt("id", afterId).order("id", { ascending: true }).limit(limit);
    if (error) throw new Error(`telemetry read: ${error.message}`);
    const rows = (data ?? []) as Array<TelemetryRow & { id: number }>;
    return { rows, next: rows.length ? rows[rows.length - 1].id : afterId };
  }
  async purge(beforeIso: string): Promise<number> {
    const { count, error } = await (await this.db()).from("telemetry_events").delete({ count: "exact" }).lt("ts", beforeIso);
    if (error) throw new Error(`telemetry purge: ${error.message}`);
    return count ?? 0;
  }
  async deleteUser(ref: string): Promise<number> {
    const { count, error } = await (await this.db()).from("telemetry_events").delete({ count: "exact" }).eq("user_ref", ref);
    if (error) throw new Error(`telemetry deleteUser: ${error.message}`);
    return count ?? 0;
  }
}

export function getSink(name: SinkName, env: Record<string, string | undefined> = process.env): TraceSink {
  if (name === "supabase" && env.TRACE_SUPABASE_URL && env.TRACE_SUPABASE_SERVICE_KEY) {
    return new SupabaseSink(env.TRACE_SUPABASE_URL, env.TRACE_SUPABASE_SERVICE_KEY);
  }
  return new NoopSink(); // choix absent ou incomplet : on jette, on ne plante jamais
}
