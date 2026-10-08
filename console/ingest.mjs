// Validates and normalizes incoming spans (see SCHEMA.md). Pure functions.
import crypto from "node:crypto";
import { scrub } from "./scrub.mjs";
import { checkArithmetic, deriveSignals } from "./detectors.mjs";

const KINDS = new Set([
  "ui.click", "ui.input", "ui.nav", "render", "longtask",
  "net.client", "net.server", "db", "external", "calc", "fn", "invariant", "log", "error", "crash", "health",
]);
const STATUSES = new Set(["ok", "error", "slow", "dead"]);
const ROLES = new Set(["owner", "tenant", "delegate", "admin", "anonymous"]);

const str = (v, max) => (typeof v === "string" && v ? v.slice(0, max) : null);

function firstFrame(stack) {
  if (typeof stack !== "string") return "";
  for (const line of stack.split("\n").slice(1, 12)) {
    const l = line.trim();
    if (!l.startsWith("at ") && !l.includes("@")) continue;
    if (/node_modules|node:internal|webpack-internal|\(<anonymous>\)/.test(l)) continue;
    return l
      .replace(/^at\s+/, "")
      .replace(/\(?(?:file:\/\/)?[A-Za-z]:?[\\/][^)]*[\\/]/, "(") // strip absolute path prefix
      .replace(/:\d+:\d+\)?$/, "");
  }
  return "";
}

export function fingerprintOf(err, kind) {
  const msg = String(err.message || "")
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, "<id>")
    .replace(/\b\d+\b/g, "<n>")
    .slice(0, 160);
  return crypto
    .createHash("sha1")
    .update([err.name || "Error", msg, firstFrame(err.stack), kind].join("|"))
    .digest("hex")
    .slice(0, 12);
}

/** @returns {{row: object}|{reject: string}} */
export function normalizeSpan(raw, cfg) {
  if (!raw || typeof raw !== "object") return { reject: "not an object" };
  const id = str(raw.id, 64);
  const trace_id = str(raw.trace_id, 64);
  if (!id) return { reject: "missing id" };
  if (!trace_id) return { reject: "missing trace_id" };
  const ts = Number(raw.ts);
  if (!Number.isFinite(ts) || ts < 9.46e11 || ts > 3.2e13) return { reject: "bad ts (epoch ms expected)" };
  const kind = KINDS.has(raw.kind) ? raw.kind : "fn";
  const name = str(raw.name, 200) || "(unnamed)";
  let dur = raw.dur === undefined || raw.dur === null ? null : Number(raw.dur);
  if (dur !== null && (!Number.isFinite(dur) || dur < 0)) dur = null;

  let status = STATUSES.has(raw.status) ? raw.status : "ok";
  let error = null;
  let fingerprint = null;
  if (raw.error && typeof raw.error === "object") {
    const e = raw.error;
    error = scrub(
      {
        name: str(e.name, 100) || "Error",
        message: str(e.message, 2000) || "",
        stack: typeof e.stack === "string" ? e.stack.slice(0, 8000) : undefined,
        // Cause chain, outermost first: [{name,message,stack?}, …]
        cause: Array.isArray(e.cause) ? e.cause.slice(0, 8).map((c) => ({
          name: str(c?.name, 100) || "Error", message: str(c?.message, 1000) || "",
          stack: typeof c?.stack === "string" ? c.stack.slice(0, 4000) : undefined,
        })) : undefined,
        code: str(String(e.code ?? ""), 64) || undefined,
      },
      { mode: "dev" }, // stack/message text: secrets scrubbed; structure kept
    );
    if (cfg.mode === "prod") {
      // Messages can embed user data; mask emails/phones the same way as other strings.
      error = scrub(error, { mode: "prod" });
    }
    if (status !== "dead") status = "error";
    fingerprint = fingerprintOf(e, kind);
  }
  if (status === "ok" && dur !== null) {
    const limit = cfg.slowMs[kind] ?? cfg.slowMs.default;
    if (dur > limit) status = "slow";
  }

  // Checks that need the RAW values run BEFORE scrubbing (prod mode reduces them to their shape).
  const violations = checkArithmetic(raw.attrs);
  if (violations.length && !error) {
    const v = violations[0];
    const e = { name: "InvariantViolation", message: `${v.title} — ${v.detail}` };
    error = JSON.stringify(scrub(e, { mode: cfg.mode }));
    error = JSON.parse(error);
    if (status !== "dead") status = "error";
    fingerprint = fingerprintOf(e, kind);
  }
  const derived = deriveSignals(raw.attrs, name);
  let attrs = raw.attrs && typeof raw.attrs === "object" ? scrub(raw.attrs, { mode: cfg.mode }) : null;
  if (attrs && Object.keys(derived).length) attrs = { ...attrs, ...derived };
  let attrsJson = attrs ? JSON.stringify(attrs) : null;
  if (attrsJson && attrsJson.length > cfg.maxAttrBytes) {
    attrsJson = JSON.stringify({ _truncated: true, bytes: attrsJson.length, preview: attrsJson.slice(0, 2000) });
  }

  const role = ROLES.has(raw.role) ? raw.role : null;
  return {
    row: {
      id, trace_id, parent_id: str(raw.parent_id, 64), ts, dur, kind, name, status,
      source: str(raw.source, 16), user_id: str(raw.user_id, 64), session_id: str(raw.session_id, 64),
      role, route: str(raw.route, 200), attrs: attrsJson,
      error: error ? JSON.stringify(error) : null, fingerprint,
      app_version: str(raw.app_version, 40), env: str(raw.env, 16),
    },
    violations, // not stored: the server turns these into findings
  };
}
