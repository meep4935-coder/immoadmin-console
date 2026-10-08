/**
 * Enregistreur de PRODUCTION — navigateur.
 *
 * Chargé par `instrumentation-client.ts` APRÈS que la page est interactive, et seulement si NEXT_PUBLIC_TRACE_PROD=1 à la compilation
 * (sinon ce fichier n'est même pas dans le bundle). Au démarrage il demande au serveur (GET /api/telemetry) s'il doit enregistrer ;
 * le serveur peut dire non (interrupteur, coupure à distance, liste d'autorisation) et l'enregistreur ne fait alors RIEN.
 *
 * NIVEAU A (tous) : erreurs et plantages, durée et statut des appels API de même origine, temps de chargement, lenteurs.
 * NIVEAU B (seulement si le serveur l'autorise ET que l'utilisateur a accepté les cookies) : clics, clics morts, navigation, messages.
 * Jamais : corps de requête ou de réponse, valeurs saisies, requêtes d'URL, courriels, noms. Le serveur re-filtre de toute façon (liste blanche).
 *
 * Principe d'ingénierie : CHAQUE crochet est enveloppé. Une panne de l'enregistreur ne doit jamais casser la page ni un appel réseau.
 */
import { errorToObject, newId } from "../core";
import { normalizeRoute } from "../supabase";
import { BoundedQueue, Governor, RingBuffer, activeTier, backoffMs, isSampled } from "./clientCore";

const ENDPOINT = "/api/telemetry";
const DEAD_WINDOW_MS = 800;

interface ServerCfg { enabled: boolean; tierB?: boolean; samplePct?: number; clickText?: boolean; messageText?: boolean }
interface Ev {
  id: string; trace_id: string; parent_id: string | null; ts: number; dur?: number; kind: string; name: string;
  status?: string; route: string; session_id: string; app_version?: string; attrs?: Record<string, unknown>; error?: unknown;
}
interface Item { ev: Ev; b: boolean }
type W = Window & { __immoProdTrace?: boolean; __cookieConsent?: string };

export async function startProdRecorder(): Promise<void> {
  const w = window as W;
  if (w.__immoProdTrace) return;
  w.__immoProdTrace = true;
  const rawFetch = window.fetch.bind(window);

  // ── 1. Le serveur décide ─────────────────────────────────────────────────
  let cfg: ServerCfg | null = null;
  try {
    const r = await rawFetch(ENDPOINT, { credentials: "same-origin", cache: "no-store" });
    if (r.ok) cfg = (await r.json()) as ServerCfg;
  } catch { /* hors-ligne ou route absente : on ne fait rien */ }
  if (!cfg || !cfg.enabled) return;
  const C: ServerCfg = cfg;

  // ── 2. État ──────────────────────────────────────────────────────────────
  let stopped = false;
  const sessionId = (() => {
    try { let v = sessionStorage.getItem("ia-tr-s"); if (!v) { v = newId("s_"); sessionStorage.setItem("ia-tr-s", v); } return v; }
    catch { return newId("s_"); }
  })();
  const sampled = isSampled(sessionId, C.samplePct ?? 0);
  const pageTrace = newId("t_");
  const ring = new RingBuffer<Item>(60);
  const queue = new BoundedQueue<Item>(200);
  const gov = new Governor(30, 10);
  const sentIds = new Set<string>();
  let failures = 0;
  let timer: ReturnType<typeof setTimeout> | null = null;

  const tierBActive = () => !stopped && sampled && !!C.tierB && activeTier(true, w.__cookieConsent) === "B";
  const guard = <A extends unknown[]>(fn: (...a: A) => void) => (...a: A): void => { try { fn(...a); } catch { /* jamais gêner la page */ } };

  function emit(e: Omit<Ev, "id" | "trace_id" | "parent_id" | "ts" | "route" | "session_id" | "app_version"> & Partial<Pick<Ev, "id" | "trace_id" | "parent_id" | "ts">>, o: { problem?: boolean; b?: boolean } = {}): void {
    if (stopped || (o.b && !tierBActive())) return;
    // Champs écrits un par un (pas de `...e`) : une valeur `undefined` passée par l'appelant ne doit JAMAIS écraser un défaut.
    const ev: Ev = {
      id: e.id ?? newId("sp_"), trace_id: e.trace_id ?? pageTrace, parent_id: e.parent_id ?? null, ts: e.ts ?? Date.now(),
      route: normalizeRoute(location.pathname), session_id: sessionId, app_version: process.env.NEXT_PUBLIC_BUILD_ID,
      kind: e.kind, name: e.name, dur: e.dur, status: e.status, attrs: e.attrs, error: e.error,
    };
    const item: Item = { ev, b: !!o.b };
    ring.push(item);
    const now = Date.now();
    if (sampled) {
      if (gov.allow(!!o.problem, now)) { queue.push(item); sentIds.add(ev.id); }
    } else if (o.problem && gov.allow(true, now)) {
      // Session hors échantillon : un PROBLÈME survient → on envoie ce qui l'a précédé (contexte) + le problème lui-même.
      for (const it of ring.snapshot()) if (!sentIds.has(it.ev.id)) { queue.push({ ev: { ...it.ev, attrs: { ...it.ev.attrs, unsampled: true } }, b: it.b }); sentIds.add(it.ev.id); }
      if (sentIds.size > 500) sentIds.clear();
    }
    schedule();
  }

  // ── 3. Envoi ─────────────────────────────────────────────────────────────
  function schedule(): void {
    if (timer || stopped) return;
    timer = setTimeout(() => { timer = null; void flush(); }, backoffMs(failures));
  }
  function stop(): void {
    stopped = true; ring.clear(); queue.removeWhere(() => true);
    if (timer) { clearTimeout(timer); timer = null; }
  }
  const body = (items: Item[]) => JSON.stringify({ events: items.map((i) => i.ev), consent: w.__cookieConsent === "accepted" });
  async function flush(): Promise<void> {
    if (stopped || !queue.length) return;
    const items = queue.take(50);
    try {
      const payload = body(items);
      const res = await rawFetch(ENDPOINT, { method: "POST", headers: { "content-type": "application/json" }, body: payload, keepalive: payload.length < 60_000, credentials: "same-origin" });
      if (res.status === 429 || res.status >= 500) failures++;
      else {
        failures = 0;
        const j = (await res.json().catch(() => null)) as { enabled?: boolean } | null;
        if (j && j.enabled === false) { stop(); return; } // coupure à distance : on s'arrête, immédiatement
      }
    } catch { failures++; }
    if (queue.length) schedule();
  }
  const flushNow = guard(() => {
    if (stopped || !queue.length) return;
    const payload = body(queue.take(50));
    if (!(navigator.sendBeacon && navigator.sendBeacon(ENDPOINT, new Blob([payload], { type: "application/json" })))) void rawFetch(ENDPOINT, { method: "POST", headers: { "content-type": "application/json" }, body: payload, keepalive: payload.length < 60_000, credentials: "same-origin" }).catch(() => {});
  });
  window.addEventListener("pagehide", flushNow);
  document.addEventListener("visibilitychange", () => { if (document.visibilityState === "hidden") flushNow(); });

  // Retrait du consentement : on supprime sur-le-champ tout ce qui relevait du niveau B.
  window.addEventListener("cookie-consent", guard(() => { if (w.__cookieConsent !== "accepted") { ring.removeWhere((i) => i.b); queue.removeWhere((i) => i.b); } }));

  // ── 4. NIVEAU A ─────────────────────────────────────────────────────────
  // Appels API de même origine : durée et statut seulement. Le résultat de `fetch` est rendu TEL QUEL à l'appelant.
  window.fetch = function tracedFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
    let meta: { t0: number; method: string; route: string } | null = null;
    try {
      const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url, location.href);
      if (!stopped && url.origin === location.origin && !url.pathname.startsWith(ENDPOINT) && !url.pathname.startsWith("/_next/") && !url.pathname.startsWith("/__nextjs")) {
        meta = { t0: performance.now(), method: (init?.method ?? (typeof input === "object" && "method" in input ? input.method : "GET")).toUpperCase(), route: normalizeRoute(url.pathname) };
      }
    } catch { meta = null; }
    const p = rawFetch(input, init);
    if (!meta) return p;
    const m = meta;
    return p.then(
      (res) => {
        guard(() => {
          const bad = res.status >= 500;
          emit({ kind: "net.client", name: `${m.method} ${m.route}`, dur: performance.now() - m.t0, status: bad ? "error" : "ok",
            attrs: { method: m.method, route: m.route, status: res.status, ok: res.ok, response_bytes: Number(res.headers.get("content-length") ?? NaN) || undefined },
            ...(bad ? { error: { name: "HttpError", message: `HTTP ${res.status}`, code: String(res.status) } } : {}) }, { problem: bad });
        })();
        return res;
      },
      (err: unknown) => {
        guard(() => { if (!(err instanceof Error && err.name === "AbortError")) emit({ kind: "net.client", name: `${m.method} ${m.route}`, dur: performance.now() - m.t0, status: "error", attrs: { method: m.method, route: m.route, status: 0, ok: false }, error: { name: "NetworkError", message: err instanceof Error ? err.message : "network" } }, { problem: true }); })();
        throw err;
      },
    );
  } as typeof fetch;

  // Erreurs non interceptées, promesses rejetées, ressources en échec.
  window.addEventListener("error", guard((e: ErrorEvent) => {
    const t = e.target;
    if (t && t !== window && t instanceof HTMLElement) { emit({ kind: "error", name: "Ressource introuvable", status: "error", error: { name: "ResourceError", message: `${t.tagName.toLowerCase()} n'a pas pu se charger` }, attrs: { source: "resource", tag: t.tagName.toLowerCase() } }, { problem: true }); return; }
    emit({ kind: "error", name: "Exception non interceptée", status: "error", error: e.error ? errorToObject(e.error) : { name: "Error", message: e.message }, attrs: { source: "window", file: e.filename, line: e.lineno, col: e.colno } }, { problem: true });
  }), true);
  window.addEventListener("unhandledrejection", guard((e: PromiseRejectionEvent) => emit({ kind: "error", name: "Promesse rejetée non gérée", status: "error", error: errorToObject(e.reason), attrs: { source: "promise" } }, { problem: true })));

  // Plantage de rendu React : détecté par le message de React ; on n'en garde que le NOM du composant.
  const origErr = console.error;
  let burst = { at: 0, n: 0 };
  console.error = function patched(...args: unknown[]) {
    origErr.apply(console, args);
    guard(() => {
      const text = args.map((a) => (typeof a === "string" ? a : "")).join(" ").slice(0, 400);
      const comp = text.match(/(?:error occurred in the|above error occurred in the) <(\w+)>/i)?.[1];
      if (!comp) return;
      const now = Date.now();
      if (now - burst.at > 1000) burst = { at: now, n: 0 };
      if (++burst.n > 3) return;
      emit({ kind: "crash", name: `Plantage de rendu <${comp}>`, status: "error", error: { name: "RenderError", message: "" }, attrs: { source: "react", component: comp } }, { problem: true });
    })();
  };

  // ── 5. Mesures (seulement dans les sessions de l'échantillon) ───────────────
  if (sampled) {
    const load = guard(() => {
      const nav = performance.getEntriesByType("navigation")[0] as PerformanceNavigationTiming | undefined;
      if (nav) emit({ kind: "ui.nav", name: "Chargement de la page", ts: performance.timeOrigin + nav.startTime, dur: nav.loadEventEnd || nav.duration, attrs: { phase: "load", type: nav.type, ttfb_ms: nav.responseStart, dom_content_loaded_ms: nav.domContentLoadedEventEnd, load_ms: nav.loadEventEnd, transfer_bytes: nav.transferSize } });
    });
    if (document.readyState === "complete") setTimeout(load, 0); else window.addEventListener("load", () => setTimeout(load, 0), { once: true });

    const observe = (type: string, cb: (l: PerformanceEntryList) => void, extra: Record<string, unknown> = {}): boolean => {
      try { if (!PerformanceObserver.supportedEntryTypes?.includes(type)) return false; new PerformanceObserver((l) => guard(cb)(l.getEntries())).observe({ type, buffered: true, ...extra } as PerformanceObserverInit); return true; } catch { return false; }
    };
    type LoAF = PerformanceEntry & { blockingDuration?: number; scripts?: Array<{ sourceURL?: string; sourceFunctionName?: string; duration: number }> };
    const haveLoaf = observe("long-animation-frame", (es) => { for (const e of es as LoAF[]) if (e.duration >= 200) emit({ kind: "longtask", name: "Page figée", ts: performance.timeOrigin + e.startTime, dur: e.duration, status: "slow", attrs: { blocking_ms: e.blockingDuration, scripts: (e.scripts ?? []).sort((a, b) => b.duration - a.duration).slice(0, 5).map((s) => ({ source: s.sourceURL, fn: s.sourceFunctionName, ms: s.duration })) } }); });
    if (!haveLoaf) observe("longtask", (es) => { for (const e of es) if (e.duration >= 200) emit({ kind: "longtask", name: "Page figée", ts: performance.timeOrigin + e.startTime, dur: e.duration, status: "slow", attrs: {} }); });
    observe("event", (es) => { for (const e of es as Array<PerformanceEntry & { interactionId?: number; processingStart: number; processingEnd: number }>) if (e.interactionId && e.duration >= 300) emit({ kind: "ui.input", name: "Interaction lente", ts: performance.timeOrigin + e.startTime, dur: e.duration, status: "slow", attrs: { input_delay_ms: e.processingStart - e.startTime, handler_ms: e.processingEnd - e.processingStart, presentation_ms: e.startTime + e.duration - e.processingEnd } }); }, { durationThreshold: 300 });

    // Battement de santé : permet à la console de voir si l'enregistreur perd des événements.
    setInterval(guard(() => emit({ kind: "health", name: "[recorder] health", dur: 0, attrs: { dropped: queue.dropped, sent: sentIds.size, queued: queue.length, client_now: Date.now() } })), 60_000);
  }

  // ── 6. NIVEAU B : seulement si le serveur l'autorise (échantillon) ET consentement accepté, vérifié À CHAQUE événement ─────────
  if (C.tierB && sampled) installTierB();

  function installTierB(): void {
    let mutations = 0;
    let lastMutationAt = 0;
    let observer: MutationObserver | null = null;
    const ensureObserver = () => {
      if (observer || !tierBActive()) return;
      observer = new MutationObserver((r) => { mutations += r.length; lastMutationAt = Date.now(); });
      observer.observe(document.documentElement, { childList: true, subtree: true, attributes: true, characterData: true });
    };
    window.addEventListener("cookie-consent", guard(() => { if (!tierBActive() && observer) { observer.disconnect(); observer = null; } else ensureObserver(); }));
    ensureObserver();

    // Clics et clics morts
    type Fiber = { return?: Fiber | null; type?: unknown; memoizedProps?: Record<string, unknown> };
    const STRICT = 'button, a[href], [role="button"], [role="link"], [role="tab"], [role="menuitem"], [role="switch"], summary, input[type="button"], input[type="submit"], input[type="reset"], input[type="checkbox"], input[type="radio"], [onclick]';
    let activeUntil = 0;
    let currentTrace: { trace: string; root: string } | null = null;
    document.addEventListener("click", guard((ev: MouseEvent) => {
      if (!tierBActive() || !ev.isTrusted || !(ev.target instanceof Element)) return;
      ensureObserver();
      const strict = ev.target.closest(STRICT);
      const el = strict ?? ev.target;
      const key = Object.keys(el).find((k) => k.startsWith("__reactFiber$"));
      let comp: string | undefined, handler: string | undefined;
      let f: Fiber | null = key ? ((el as unknown as Record<string, Fiber | undefined>)[key] ?? null) : null;
      for (let i = 0; f && i < 40 && !(comp && handler); i++, f = f.return ?? null) {
        const c = f.memoizedProps?.onClick; if (!handler && typeof c === "function") handler = c.name || "(anonymous)";
        const t = f.type as { displayName?: string; name?: string } | string | undefined;
        if (!comp && t && typeof t !== "string") { const n = t.displayName || t.name; if (n && !/^(Anonymous|Fragment|ForwardRef|Memo)$/.test(n)) comp = n; }
      }
      const a = el as HTMLElement & { disabled?: boolean };
      const link = strict instanceof HTMLAnchorElement ? strict : null;
      const elsewhere = !!link && (link.target === "_blank" || link.hasAttribute("download") || /^(mailto|tel):/.test(link.href));
      const eligible = !!strict && !elsewhere && !ev.ctrlKey && !ev.metaKey && !ev.shiftKey && !(el instanceof HTMLInputElement && /^(text|email|password|search|tel|url|number)$/.test(el.type));
      const t0 = Date.now(), m0 = mutations, focus0 = document.activeElement;
      const trace = newId("t_"), root = newId("sp_");
      currentTrace = { trace, root }; activeUntil = t0 + 4000;
      const target = { tag: el.tagName.toLowerCase(), role: el.getAttribute("role") || undefined, component: comp, handler, has_onclick_prop: handler !== undefined, disabled: a.disabled || undefined, testid: el.getAttribute("data-testid") || undefined,
        text: C.clickText ? (el.getAttribute("aria-label") || (el.tagName === "INPUT" ? "" : el.textContent) || "").replace(/\s+/g, " ").trim().slice(0, 40) : undefined };
      setTimeout(guard(() => {
        const effects: string[] = [];
        if (mutations > m0) effects.push("dom");
        if (document.activeElement !== focus0) effects.push("focus");
        if (elsewhere) effects.push("opens-elsewhere");
        const dead = eligible && !effects.length && !a.disabled;
        if (!eligible && !effects.length) return;
        emit({ id: root, trace_id: trace, kind: "ui.click", name: "Clic", ts: t0, dur: Math.max(1, Math.max(lastMutationAt, t0) - t0), status: dead ? "dead" : "ok", attrs: { target, effects, feedback_tracked: true, heuristic: dead || undefined } }, { b: true });
      }), DEAD_WINDOW_MS);
    }), { capture: true, passive: true });

    // Navigation (le routeur de Next utilise pushState/replaceState). Les appels d'origine sont rendus INCHANGÉS.
    for (const m of ["pushState", "replaceState"] as const) {
      const orig = history[m];
      history[m] = function patched(this: History, ...args: Parameters<History["pushState"]>) {
        const from = location.pathname;
        const r = orig.apply(this, args);
        guard(() => { if (tierBActive() && location.pathname !== from) emit({ kind: "ui.nav", name: "Navigation", dur: 0, attrs: { phase: "route", from: normalizeRoute(from), to: normalizeRoute(location.pathname) } }, { b: true }); })();
        return r;
      };
    }

    // Messages montrés à l'utilisateur : on garde le TYPE et la LONGUEUR ; le texte lui-même seulement si le serveur l'autorise.
    const MSG = '[data-sonner-toast], [role="alert"], [role="status"], [aria-live="assertive"], [aria-live="polite"]';
    const last = new WeakMap<Element, string>();
    const pending = new WeakSet<Element>();
    const report = (el: Element) => {
      pending.delete(el);
      if (!tierBActive() || !el.isConnected || el.tagName.toLowerCase() === "next-route-announcer" || el.closest("next-route-announcer")) return;
      const text = (el.textContent || "").replace(/\s+/g, " ").trim().slice(0, 200);
      if (text.length < 2 || last.get(el) === text) return;
      last.set(el, text);
      const live = Date.now() < activeUntil ? currentTrace : null;
      emit({ kind: "render", name: "Message affiché", dur: 0, trace_id: live?.trace, parent_id: live?.root ?? null,
        attrs: { type: el.getAttribute("data-type") || (el.getAttribute("role") === "alert" ? "alert" : "status"), negative: /erreur|échec|echec|impossible|invalide|refus|failed|error|unable|invalid/i.test(text), from: el.hasAttribute("data-sonner-toast") ? "toast" : "banner", text_len: text.length, text: C.messageText ? text : undefined } }, { b: true });
    };
    new MutationObserver((records) => {
      if (!tierBActive()) return;
      for (const r of records) {
        const base = r.target instanceof Element ? r.target : r.target.parentElement;
        const set = new Set<Element>(); const near = base?.closest(MSG); if (near) set.add(near);
        for (const n of r.addedNodes) if (n instanceof Element) { if (n.matches(MSG)) set.add(n); n.querySelectorAll(MSG).forEach((e) => set.add(e)); }
        for (const el of set) if (!pending.has(el)) { pending.add(el); setTimeout(guard(() => report(el)), 200); }
      }
    }).observe(document.documentElement, { childList: true, subtree: true, characterData: true });
  }
}
