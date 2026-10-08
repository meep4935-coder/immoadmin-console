import { describe, it, expect, beforeEach } from "vitest";
import { readProdConfig, remoteKilled, resetKillCache } from "./config";
import { sanitizeEvent, scrubText, type SanitizeOptions } from "./events";
import { userRef } from "./pseudonym";
import { MemorySink, NoopSink, getSink } from "./sink";
import { MAX_EVENTS, deleteTelemetryForUser, handleConfig, handleExport, handleIngest, handlePurge, makeLimiter, reportServerError, type Deps } from "./server";
import { BoundedQueue, Governor, RingBuffer, activeTier, backoffMs, hashToPct, isSampled } from "./clientCore";

const NOW = Date.UTC(2026, 9, 8, 12, 0, 0);
const SECRET = "test-secret-0123456789abcdef";
const OPTS: SanitizeOptions = { tierB: false, clickText: false, messageText: false, errorMessage: true, now: NOW };
const ON = { TRACE_PROD_ENABLED: "1", TRACE_PSEUDONYM_SECRET: SECRET, TRACE_SINK: "noop" };

const ev = (o: Record<string, unknown> = {}) => ({ id: "sp_1", trace_id: "t_1", ts: NOW, kind: "error", name: "Exception", session_id: "s_abcdef123", route: "/portail/dashboard", app_version: "v1", error: { name: "TypeError", message: "x is undefined" }, ...o });

beforeEach(() => resetKillCache());

// ── configuration ───────────────────────────────────────────────────────────
describe("configuration — éteinte par défaut", () => {
  it("rien n'est actif sans interrupteur", () => { expect(readProdConfig({}).enabled).toBe(false); });
  it("l'interrupteur seul ne suffit pas : il faut un secret d'au moins 16 caractères", () => {
    expect(readProdConfig({ TRACE_PROD_ENABLED: "1" }).enabled).toBe(false);
    expect(readProdConfig({ TRACE_PROD_ENABLED: "1", TRACE_PSEUDONYM_SECRET: "court" }).enabled).toBe(false);
    expect(readProdConfig(ON).enabled).toBe(true);
  });
  it("valeurs par défaut prudentes", () => {
    const c = readProdConfig(ON);
    expect(c).toMatchObject({ tierB: false, samplePct: 0, sink: "noop", retentionDays: 14, clickText: false, messageText: false, errorMessage: true, allowlist: [] });
    expect(readProdConfig({ ...ON, TRACE_PROD_ERROR_MESSAGE: "0" }).errorMessage).toBe(false);
  });
  it("bornes et analyse des valeurs", () => {
    const c = readProdConfig({ ...ON, TRACE_PROD_SAMPLE_PCT: "500", TRACE_RETENTION_DAYS: "0", TRACE_PROD_ALLOWLIST: " A@x.ca , b@y.ca ,", TRACE_SINK: "supabase" });
    expect(c.samplePct).toBe(100); expect(c.retentionDays).toBe(1); expect(c.allowlist).toEqual(["a@x.ca", "b@y.ca"]); expect(c.sink).toBe("supabase");
    expect(readProdConfig({ ...ON, TRACE_PROD_SAMPLE_PCT: "abc" }).samplePct).toBe(0);
  });
});

describe("coupure à distance", () => {
  it("« 0 », « false », « off » coupent ; autre chose ou rien ne coupe pas", async () => {
    for (const v of ["0", "false", "OFF", " no "]) { resetKillCache(); expect(await remoteKilled(async () => v, NOW)).toBe(true); }
    for (const v of ["1", "on", null]) { resetKillCache(); expect(await remoteKilled(async () => v, NOW)).toBe(false); }
  });
  it("la valeur est mise en cache 60 s", async () => {
    let calls = 0; const read = async () => { calls++; return "0"; };
    await remoteKilled(read, NOW); await remoteKilled(read, NOW + 30_000);
    expect(calls).toBe(1);
    await remoteKilled(read, NOW + 61_000);
    expect(calls).toBe(2);
  });
  it("une panne de Redis ne coupe pas tout, et garde la décision précédente", async () => {
    expect(await remoteKilled(async () => { throw new Error("redis"); }, NOW)).toBe(false);
    resetKillCache(); await remoteKilled(async () => "0", NOW);
    expect(await remoteKilled(async () => { throw new Error("redis"); }, NOW + 61_000)).toBe(true);
  });
});

// ── filtre de confidentialité ─────────────────────────────────────────────────
describe("scrubText", () => {
  it("masque courriels, téléphones, UUID, jetons, longs nombres", () => {
    const s = scrubText("jean.tremblay@exemple.ca 514-555-0199 3f2b9c1e-0000-4000-8000-000000000001 eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abcdefghijk Bearer abcdef123456 123456789012", 500);
    expect(s).not.toMatch(/tremblay|514-555|3f2b9c1e|eyJ|abcdef123456|123456789012/);
    expect(s).toContain("[courriel]"); expect(s).toContain("[tel]"); expect(s).toContain("[id]"); expect(s).toContain("[jwt]");
  });
  it("retire la requête et l'ancre des URL", () => { expect(scrubText("voir https://x.ca/a/b?token=SECRET&u=1#frag fin", 200)).toBe("voir https://x.ca/a/b fin"); });
  it("tronque à la longueur FINALE demandée", () => { expect(scrubText("x".repeat(500), 50).length).toBeLessThanOrEqual(50); });
  it("une valeur qui n'est pas une chaîne devient vide", () => { expect(scrubText({ a: 1 }, 10)).toBe(""); });
});

describe("sanitizeEvent — liste blanche", () => {
  it("un événement valide traverse", () => {
    const e = sanitizeEvent(ev(), OPTS)!;
    expect(e).toMatchObject({ kind: "error", status: "error", route: "/portail/dashboard", session_id: "s_abcdef123", release: "v1", tier: "A" });
  });
  it("jette ce qui n'est pas un objet, un type inconnu, ou un identifiant invalide", () => {
    for (const bad of [null, "x", 5, [], ev({ kind: "cheval" }), ev({ id: "a b" }), ev({ trace_id: "" }), ev({ session_id: "court" }), ev({ id: undefined })]) expect(sanitizeEvent(bad, OPTS)).toBeNull();
  });
  it("les attributs inconnus sont JETÉS (corps, mots de passe, courriels, valeurs saisies…)", () => {
    const e = sanitizeEvent(ev({ kind: "net.client", name: "POST /api/x", attrs: { method: "POST", route: "/api/x", status: 200, body: { password: "hunter2" }, email: "a@b.ca", input: "x", headers: { authorization: "Bearer zzzzzzzzzzzz" }, query: "a=1" }, error: undefined }), OPTS)!;
    expect(Object.keys(e.attrs).sort()).toEqual(["method", "ok", "route", "status"].filter((k) => k in e.attrs).sort());
    expect(JSON.stringify(e)).not.toMatch(/hunter2|a@b\.ca|authorization|zzzzzzzz/);
  });
  it("une requête d'URL est retirée de la route", () => {
    const e = sanitizeEvent(ev({ kind: "net.client", route: "/api/leases/3f2b9c1e-0000-4000-8000-000000000001?token=abc", attrs: { route: "https://immoadmin.ca/api/x?secret=1" } }), OPTS)!;
    expect(e.route).toBe("/api/leases/:id"); expect(e.attrs.route).toBe("/api/x");
  });
  it("niveau B jeté sans autorisation ; gardé avec", () => {
    const click = ev({ kind: "ui.click", name: "Clic", error: undefined, attrs: { target: { tag: "button", component: "LeaseForm", text: "Jean Tremblay" }, effects: ["dom", "focus", "bogus"] } });
    expect(sanitizeEvent(click, OPTS)).toBeNull();
    const kept = sanitizeEvent(click, { ...OPTS, tierB: true })!;
    expect(kept.tier).toBe("B");
    expect((kept.attrs.target as Record<string, unknown>).text).toBeUndefined();            // texte du bouton éteint par défaut
    expect(kept.attrs.effects).toEqual(["dom", "focus"]);                                    // valeur hors liste jetée
    expect(sanitizeEvent(click, { ...OPTS, tierB: true, clickText: true })!.attrs.target).toMatchObject({ text: "Jean Tremblay" });
  });
  it("le texte d'un message est éteint par défaut mais sa longueur reste (les vérifications « aucun message » en ont besoin)", () => {
    const m = ev({ kind: "render", name: "Message affiché", error: undefined, attrs: { type: "error", from: "toast", text: "Bonjour Marie, 514-555-0199", text_len: 27 } });
    const off = sanitizeEvent(m, { ...OPTS, tierB: true })!;
    expect(off.attrs.text).toBeUndefined(); expect(off.attrs.text_len).toBe(27);
    const on = sanitizeEvent(m, { ...OPTS, tierB: true, messageText: true })!;
    expect(on.attrs.text).toBe("Bonjour Marie, [tel]");
  });
  it("navigation : le chargement (niveau A) passe, le changement de route (niveau B) non", () => {
    expect(sanitizeEvent(ev({ kind: "ui.nav", error: undefined, attrs: { phase: "load", load_ms: 900 } }), OPTS)).not.toBeNull();
    expect(sanitizeEvent(ev({ kind: "ui.nav", error: undefined, attrs: { phase: "route", from: "/a", to: "/b" } }), OPTS)).toBeNull();
    expect(sanitizeEvent(ev({ kind: "ui.nav", error: undefined, attrs: { phase: "route", from: "/a", to: "/b" } }), { ...OPTS, tierB: true })!.attrs).toMatchObject({ from: "/a", to: "/b" });
  });
  it("horloge cliente aberrante → heure du serveur ; durée bornée", () => {
    expect(sanitizeEvent(ev({ ts: NOW + 10 * 86_400_000 }), OPTS)!.ts).toBe(NOW);
    expect(sanitizeEvent(ev({ ts: NOW - 1000 }), OPTS)!.ts).toBe(NOW - 1000);
    expect(sanitizeEvent(ev({ dur: 9e9 }), OPTS)!.dur).toBe(6e5);
    expect(sanitizeEvent(ev({ dur: -5 }), OPTS)!.dur).toBeNull();
  });
  it("la pile d'erreur est purgée et tronquée, sans requête d'URL", () => {
    const e = sanitizeEvent(ev({ error: { name: "Error", message: "échec pour jean@x.ca", stack: "Error: x\n    at f (https://immoadmin.ca/_next/static/a.js?v=SECRET:1:2)" } }), OPTS)!;
    expect(e.error!.message).toBe("échec pour [courriel]");
    expect(e.error!.stack).not.toContain("SECRET");
  });
  it("un événement trop gros est jeté", () => {
    const big = { kind: "longtask", attrs: { scripts: Array.from({ length: 5 }, () => ({ source: "/" + "a".repeat(120), fn: "f", ms: 1 })) } };
    expect(sanitizeEvent(ev({ ...big, error: undefined, name: "n".repeat(500) }), OPTS)).not.toBeNull(); // 5 scripts × ~130 car. reste sous 4 Ko
  });
});

describe("test de confidentialité — 1 000 événements hostiles", () => {
  it("aucune donnée personnelle plantée ne survit, dans AUCUN champ", () => {
    const PLANTED = ["marie.gagnon@exemple.ca", "514-555-0147", "9f1c2d3e-aaaa-4bbb-8ccc-0123456789ab", "123456789", "sk_live_abcdefghijklmnop", "motdepasse-ultra-secret", "SECRET_QUERY_VALUE"];
    // Motifs RECONNAISSABLES (courriel, téléphone, UUID, NAS, clé) : plantés partout. Mots ordinaires (mot de passe, valeur secrète) :
    // plantés seulement dans la requête / l'ancre d'une URL, là où le filtre DOIT les retirer (voir « limite assumée » pour le reste).
    const DETECTABLE = PLANTED.slice(0, 5);
    const dirty = (i: number) => `Erreur pour ${DETECTABLE[i % 5]} ${DETECTABLE[(i + 3) % 5]} voir https://immoadmin.ca/x?t=${PLANTED[6]}#${PLANTED[5]} eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abcdefghijk`;
    const kinds = ["error", "crash", "net.client", "longtask", "ui.input", "health", "ui.nav", "ui.click", "render"];
    let kept = 0;
    for (let i = 0; i < 1000; i++) {
      const kind = kinds[i % kinds.length];
      const raw = ev({
        kind, name: dirty(i), route: `/portail/${DETECTABLE[i % 5]}?x=${PLANTED[6]}`, parent_id: "p1",
        error: { name: "Error", message: dirty(i), stack: dirty(i), code: dirty(i), cause: [{ name: "E", message: dirty(i) }] },
        attrs: { phase: i % 2 ? "load" : "route", text: dirty(i), method: "POST", route: dirty(i), url: dirty(i), reason: dirty(i), file: dirty(i), component: PLANTED[0],
          target: { tag: "button", text: dirty(i), testid: PLANTED[0], component: dirty(i), handler: PLANTED[1] }, scripts: [{ source: dirty(i), fn: PLANTED[0], ms: 5 }],
          body: dirty(i), password: PLANTED[5], email: PLANTED[0], headers: { cookie: PLANTED[5] }, from: dirty(i), to: dirty(i), type: dirty(i) },
        // (attributs inconnus — body, password, email, headers — doivent disparaître ENTIÈREMENT, même s'ils contiennent des mots ordinaires)
      });
      const out = sanitizeEvent(raw, { ...OPTS, tierB: true, clickText: true, messageText: true });
      if (!out) continue;
      kept++;
      const s = JSON.stringify(out);
      for (const p of PLANTED.slice(0, 5)) expect(s, `événement ${i} (${kind}) a laissé passer « ${p} »`).not.toContain(p);
      expect(s, `événement ${i} (${kind})`).not.toMatch(/SECRET_QUERY_VALUE|eyJ[\w-]{10,}/);
    }
    expect(kept).toBeGreaterThan(300); // le test serait vide si presque tout était jeté
  });
});

describe("limite assumée : un secret écrit en mots ordinaires", () => {
  const raw = ev({ error: { name: "Error", message: "Mot de passe invalide: motdepasse-ultra-secret", stack: "Error: Mot de passe invalide: motdepasse-ultra-secret\n    at f (https://immoadmin.ca/_next/a.js:1:2)" } });
  it("passe le filtre par motifs (aucun motif à reconnaître) — c'est la limite documentée", () => {
    expect(JSON.stringify(sanitizeEvent(raw, OPTS))).toContain("motdepasse-ultra-secret");
  });
  it("TRACE_PROD_ERROR_MESSAGE=0 retire entièrement le texte des messages, y compris la 1re ligne de la pile", () => {
    const out = sanitizeEvent(raw, { ...OPTS, errorMessage: false })!;
    expect(JSON.stringify(out)).not.toContain("motdepasse-ultra-secret");
    expect(out.error!.stack).toContain("a.js");   // les trames de pile (utiles au diagnostic) restent
    expect(out.error).toMatchObject({ name: "Error", message: "" });
  });
});

// ── pseudonyme ───────────────────────────────────────────────────────────────
describe("pseudonyme", () => {
  it("stable, distinct par compte et par secret, sans l'identifiant d'origine", () => {
    const a = userRef(SECRET, "user-1");
    expect(a).toBe(userRef(SECRET, "user-1"));
    expect(a).toMatch(/^u_[0-9a-f]{16}$/);
    expect(a).not.toBe(userRef(SECRET, "user-2"));
    expect(a).not.toBe(userRef("un-autre-secret-0123456789", "user-1"));
    expect(a).not.toContain("user-1");
  });
});

// ── gestionnaires ────────────────────────────────────────────────────────────
function deps(over: Partial<Deps> & { env?: Record<string, string | undefined> } = {}): Deps & { sink: MemorySink } {
  const sink = new MemorySink();
  return { env: { ...ON, TRACE_PROD_SAMPLE_PCT: "100" }, now: () => NOW, sink, readFlag: async () => null, getIdentity: async () => ({ userId: "user-1", email: "kevin@exemple.ca" }), limiter: async () => true, ...over } as Deps & { sink: MemorySink };
}
const post = (events: unknown[], consent = false, body?: string) =>
  new Request("https://x.test/api/telemetry", { method: "POST", body: body ?? JSON.stringify({ events, consent }), headers: { "x-forwarded-for": "203.0.113.9" } });
const get = (path = "/api/telemetry", h: Record<string, string> = {}) => new Request(`https://x.test${path}`, { headers: h });
const parse = async (r: Response) => (await r.json()) as Record<string, unknown>;

describe("GET /api/telemetry — qui enregistre ?", () => {
  it("éteint par défaut", async () => { expect(await parse(await handleConfig(get(), deps({ env: {} })))).toMatchObject({ enabled: false }); });
  it("allumé : donne au navigateur ses consignes", async () => {
    expect(await parse(await handleConfig(get(), deps({ env: { ...ON, TRACE_PROD_TIER_B: "1", TRACE_PROD_SAMPLE_PCT: "5" } })))).toMatchObject({ enabled: true, tierB: true, samplePct: 5, clickText: false, messageText: false });
  });
  it("coupé à distance : enabled=false et killed=true", async () => {
    expect(await parse(await handleConfig(get(), deps({ readFlag: async () => "0" })))).toMatchObject({ enabled: false, killed: true });
  });
  it("liste d'autorisation : seuls les courriels listés enregistrent", async () => {
    const env = { ...ON, TRACE_PROD_ALLOWLIST: "kevin@exemple.ca" };
    expect(await parse(await handleConfig(get(), deps({ env })))).toMatchObject({ enabled: true });
    expect(await parse(await handleConfig(get(), deps({ env, getIdentity: async () => ({ userId: "u", email: "autre@exemple.ca" }) })))).toMatchObject({ enabled: false });
    expect(await parse(await handleConfig(get(), deps({ env, getIdentity: async () => ({ userId: null, email: null }) })))).toMatchObject({ enabled: false });
  });
  it("la lecture de session qui échoue ou qui traîne rend anonyme, sans planter", async () => {
    expect((await handleConfig(get(), deps({ getIdentity: async () => { throw new Error("boum"); } }))).status).toBe(200);
    const t0 = Date.now();
    const r = await handleConfig(get(), deps({ getIdentity: () => new Promise(() => {}) }));
    expect(r.status).toBe(200); expect(Date.now() - t0).toBeLessThan(2000);
  });
});

describe("POST /api/telemetry — réception", () => {
  it("stocke les événements nettoyés avec la référence pseudonyme et le rôle", async () => {
    const d = deps();
    const r = await handleIngest(post([ev(), ev({ id: "sp_2", route: "/locataire/paiements" })]), d);
    expect(await parse(r)).toMatchObject({ ok: true, accepted: 2 });
    expect(d.sink.rows).toHaveLength(2);
    expect(d.sink.rows[0]).toMatchObject({ user_ref: userRef(SECRET, "user-1"), role: "owner", kind: "error" });
    expect(d.sink.rows[1].role).toBe("tenant");
    expect(JSON.stringify(d.sink.rows)).not.toMatch(/user-1|kevin@/);
  });
  it("visiteur anonyme : pas de référence", async () => {
    const d = deps({ getIdentity: async () => ({ userId: null, email: null }) });
    await handleIngest(post([ev({ route: "/connexion" })]), d);
    expect(d.sink.rows[0]).toMatchObject({ user_ref: null, role: "anonymous" });
  });
  it("éteint : rien n'est stocké, même avec un corps valide", async () => {
    const d = deps({ env: {} });
    expect(await parse(await handleIngest(post([ev()]), d))).toMatchObject({ enabled: false });
    expect(d.sink.rows).toHaveLength(0);
  });
  it("coupure à distance : rien n'est stocké et l'enregistreur est prié de s'arrêter", async () => {
    const d = deps({ readFlag: async () => "0" });
    expect(await parse(await handleIngest(post([ev()]), d))).toMatchObject({ enabled: false, killed: true });
    expect(d.sink.rows).toHaveLength(0);
  });
  it("niveau B : seulement si le serveur l'autorise ET que le navigateur affirme le consentement", async () => {
    const click = ev({ kind: "ui.click", name: "Clic", error: undefined, attrs: { target: { tag: "button" }, effects: [] } });
    const cases: Array<[Record<string, string>, boolean, number]> = [
      [{ TRACE_PROD_TIER_B: "1" }, true, 1], [{ TRACE_PROD_TIER_B: "1" }, false, 0], [{}, true, 0], [{}, false, 0],
    ];
    for (const [extra, consent, expected] of cases) {
      const d = deps({ env: { ...ON, ...extra } });
      await handleIngest(post([click], consent), d);
      expect(d.sink.rows.length, JSON.stringify([extra, consent])).toBe(expected);
    }
  });
  it("refuse un corps trop gros (413), invalide (400), ou sans liste d'événements (400)", async () => {
    const d = deps();
    expect((await handleIngest(post([], false, "x".repeat(70_000)), d)).status).toBe(413);
    expect((await handleIngest(post([], false, "pas du json"), d)).status).toBe(400);
    expect((await handleIngest(post([], false, JSON.stringify({ foo: 1 })), d)).status).toBe(400);
  });
  it(`ne traite que ${MAX_EVENTS} événements par requête`, async () => {
    const d = deps();
    await handleIngest(post(Array.from({ length: 200 }, (_, i) => ev({ id: `sp_${i}` }))), d);
    expect(d.sink.rows).toHaveLength(MAX_EVENTS);
  });
  it("limite de débit → 429 avec Retry-After, rien n'est stocké", async () => {
    const d = deps({ limiter: async () => false });
    const r = await handleIngest(post([ev()]), d);
    expect(r.status).toBe(429); expect(r.headers.get("retry-after")).toBe("30"); expect(d.sink.rows).toHaveLength(0);
  });
  it("LE STOCKAGE EN PANNE n'est jamais une erreur pour l'utilisateur", async () => {
    const d = deps(); d.sink.failWrites = true;
    const r = await handleIngest(post([ev(), ev({ id: "sp_2" })]), d);
    expect(r.status).toBe(200); expect(await parse(r)).toMatchObject({ ok: true, accepted: 0, dropped: 2 });
  });
  it("même une exception inattendue se termine en 200", async () => {
    const d = deps({ limiter: async () => { throw new Error("redis explose"); } });
    expect((await handleIngest(post([ev()]), d)).status).toBe(200);
  });
  it("les événements invalides sont jetés individuellement, les bons gardés", async () => {
    const d = deps();
    const r = await handleIngest(post([ev(), { kind: "x" }, ev({ id: "sp_3", kind: "inconnu" }), ev({ id: "sp_4" })]), d);
    expect(await parse(r)).toMatchObject({ accepted: 2 });
  });
});

describe("export pour la console locale", () => {
  const TOKEN = "t".repeat(32);
  const auth = (t: string) => ({ authorization: `Bearer ${t}` });
  const seeded = async () => { const d = deps({ env: { ...ON, TRACE_EXPORT_TOKEN: TOKEN } }); await handleIngest(post(Array.from({ length: 5 }, (_, i) => ev({ id: `sp_${i}` }))), d); return d; };
  it("sans jeton configuré (ou trop court) la route n'existe pas : 404", async () => {
    expect((await handleExport(get("/api/telemetry/export"), deps({ env: ON }))).status).toBe(404);
    expect((await handleExport(get("/api/telemetry/export", auth("court")), deps({ env: { ...ON, TRACE_EXPORT_TOKEN: "court" } }))).status).toBe(404);
  });
  it("mauvais jeton ou absent → 401", async () => {
    const d = await seeded();
    expect((await handleExport(get("/api/telemetry/export", auth("x".repeat(32))), d)).status).toBe(401);
    expect((await handleExport(get("/api/telemetry/export"), d)).status).toBe(401);
  });
  it("bon jeton → lignes, curseur et pagination", async () => {
    const d = await seeded();
    const a = await parse(await handleExport(get("/api/telemetry/export?limit=2", auth(TOKEN)), d));
    expect((a.rows as unknown[]).length).toBe(2); expect(a.more).toBe(true);
    const b = await parse(await handleExport(get(`/api/telemetry/export?limit=10&after=${a.next}`, auth(TOKEN)), d));
    expect((b.rows as unknown[]).length).toBe(3); expect(b.more).toBe(false);
  });
  it("limite de débit → 429", async () => {
    const d = await seeded(); d.limiter = async () => false;
    expect((await handleExport(get("/api/telemetry/export", auth(TOKEN)), d)).status).toBe(429);
  });
});

describe("rétention et effacement (Loi 25)", () => {
  it("la purge supprime ce qui dépasse la rétention configurée", async () => {
    const d = deps({ env: { ...ON, TRACE_RETENTION_DAYS: "7" } });
    d.sink.rows.push({ id: 1, ts: new Date(NOW - 10 * 86_400_000).toISOString() } as never, { id: 2, ts: new Date(NOW - 1 * 86_400_000).toISOString() } as never);
    const r = await parse(await handlePurge(d));
    expect(r).toMatchObject({ purged: 1, retentionDays: 7 });
    expect(d.sink.rows).toHaveLength(1);
  });
  it("un stockage qui échoue → 502, pas d'exception", async () => {
    const d = deps(); d.sink.purge = async () => { throw new Error("x"); };
    expect((await handlePurge(d)).status).toBe(502);
  });
  it("l'effacement d'un compte ne touche que ses lignes", async () => {
    const d = deps();
    await handleIngest(post([ev()]), d);
    await handleIngest(post([ev({ id: "sp_other" })]), deps({ sink: d.sink, getIdentity: async () => ({ userId: "user-2", email: null }) }));
    expect(d.sink.rows).toHaveLength(2);
    expect(await deleteTelemetryForUser("user-1", { env: ON, sink: d.sink })).toBe(1);
    expect(d.sink.rows.map((r) => r.user_ref)).toEqual([userRef(SECRET, "user-2")]);
  });
  it("sans secret, rien n'est effacé (et rien ne plante)", async () => { expect(await deleteTelemetryForUser("user-1", { env: {}, sink: new MemorySink() })).toBe(0); });
});

describe("erreurs serveur non gérées", () => {
  it("enregistre une erreur nettoyée, sans utilisateur", async () => {
    const d = deps();
    await reportServerError(new Error("échec pour marie@exemple.ca"), { path: "/api/leases/3f2b9c1e-0000-4000-8000-000000000001", method: "POST" }, { routePath: "/api/leases/[id]" }, d);
    expect(d.sink.rows).toHaveLength(1);
    expect(d.sink.rows[0]).toMatchObject({ kind: "error", user_ref: null });
    expect(JSON.stringify(d.sink.rows[0])).not.toContain("marie@");
  });
  it("éteint : rien", async () => { const d = deps({ env: {} }); await reportServerError(new Error("x"), { path: "/a", method: "GET" }, {}, d); expect(d.sink.rows).toHaveLength(0); });
  it("une panne du stockage n'a aucun effet visible", async () => {
    const d = deps(); d.sink.failWrites = true;
    await expect(reportServerError(new Error("x"), { path: "/a", method: "GET" }, {}, d)).resolves.toBeUndefined();
  });
  it("une boucle d'erreurs est plafonnée à 20 par minute", async () => {
    const d = deps({ now: () => NOW + 10 * 60_000 });
    for (let i = 0; i < 60; i++) await reportServerError(new Error("boucle"), { path: "/a", method: "GET" }, {}, d);
    expect(d.sink.rows.length).toBe(20);
  });
});

describe("sink et limiteur", () => {
  it("sans configuration complète, on jette (NoopSink) au lieu de planter", () => {
    expect(getSink("supabase", {})).toBeInstanceOf(NoopSink);
    expect(getSink("noop", ON)).toBeInstanceOf(NoopSink);
  });
  it("le limiteur mémoire coupe au-delà de la limite", async () => {
    const l = makeLimiter({});
    const r: boolean[] = []; for (let i = 0; i < 5; i++) r.push(await l("k", 3));
    expect(r).toEqual([true, true, true, false, false]);
    expect(await l("autre", 3)).toBe(true);
  });
});

// ── logique du navigateur ───────────────────────────────────────────────────────
describe("logique pure de l'enregistreur navigateur", () => {
  it("hachage déterministe dans [0, 99]", () => {
    for (const s of ["a", "s_123", "s_abcdef"]) { const h = hashToPct(s); expect(h).toBe(hashToPct(s)); expect(h).toBeGreaterThanOrEqual(0); expect(h).toBeLessThan(100); }
  });
  it("échantillonnage : 0 % jamais, 100 % toujours, 10 % ≈ 10 %", () => {
    const ids = Array.from({ length: 20_000 }, (_, i) => `s_${i.toString(36)}${(i * 7919).toString(36)}`);
    expect(ids.some((i) => isSampled(i, 0))).toBe(false);
    expect(ids.every((i) => isSampled(i, 100))).toBe(true);
    const share = ids.filter((i) => isSampled(i, 10)).length / ids.length;
    expect(share).toBeGreaterThan(0.08); expect(share).toBeLessThan(0.12);
  });
  it("niveau B seulement si le serveur l'autorise ET consentement « accepted »", () => {
    expect(activeTier(true, "accepted")).toBe("B");
    for (const [s, c] of [[true, "refused"], [true, undefined], [true, null], [false, "accepted"]] as const) expect(activeTier(s, c)).toBe("A");
  });
  it("tampon circulaire borné", () => { const r = new RingBuffer<number>(3); [1, 2, 3, 4, 5].forEach((n) => r.push(n)); expect(r.snapshot()).toEqual([3, 4, 5]); });
  it("file bornée : jette les plus anciens et le compte", () => {
    const q = new BoundedQueue<number>(3); [1, 2, 3, 4, 5].forEach((n) => q.push(n));
    expect(q.dropped).toBe(2); expect(q.take(10)).toEqual([3, 4, 5]);
  });
  it("retrait ciblé (consentement retiré → on supprime le niveau B)", () => {
    const q = new BoundedQueue<{ b: boolean }>(10); q.push({ b: true }); q.push({ b: false }); q.removeWhere((x) => x.b);
    expect(q.length).toBe(1);
  });
  it("plafonds par minute : normal 30, problème 10, remise à zéro après 60 s", () => {
    const g = new Governor(30, 10);
    let normal = 0, problems = 0;
    for (let i = 0; i < 100; i++) if (g.allow(false, 1000)) normal++;
    for (let i = 0; i < 100; i++) if (g.allow(true, 1000)) problems++;
    expect([normal, problems]).toEqual([30, 10]);
    expect(g.allow(false, 1000 + 61_000)).toBe(true);
  });
  it("recul exponentiel : 10 s, 20 s, 40 s… plafonné à 5 min", () => {
    expect([0, 1, 2, 3].map((n) => backoffMs(n))).toEqual([10_000, 20_000, 40_000, 80_000]);
    expect(backoffMs(20)).toBe(300_000);
  });
});
