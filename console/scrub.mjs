// Redaction applied at ingest, whatever the sender did. Defense in depth:
// secrets are removed in every mode; prod mode additionally masks personal data.

const SECRET_KEY = /(authorization|cookie|passw|secret|token|api[-_]?key|service[-_]?role|private[-_]?key|otp|cvc|cvv|card[-_]?number)/i;
// Keys that carry business payloads. In prod mode only their shape is kept.
const PAYLOAD_KEY = /^(input|inputs|output|outputs|args|arguments|result|results|body|payload|response|request|data|rows|row|value|values|params|filters|steps)$/i;

const VALUE_PATTERNS = [
  [/eyJ[\w-]{10,}\.[\w-]{10,}\.[\w-]{10,}/g, "[jwt]"],
  [/\b(sk_live|sk_test|rk_live|whsec|sk-ant)[_-][\w-]{12,}/g, "[secret]"],
  [/\bima_live_[0-9a-f]{20,}/g, "[secret]"],
  [/\bBearer\s+[\w.~+/=-]{8,}/gi, "Bearer [redacted]"],
];
const PROD_PATTERNS = [
  [/[\w.+-]+@[\w-]+(\.[\w-]+)+/g, "[email]"],
  [/(?<!\d)(\+?1[\s.-]?)?\(?\d{3}\)?[\s.-]\d{3}[\s.-]\d{4}(?!\d)/g, "[phone]"],
];

function scrubString(s, prod, maxLen) {
  let out = s;
  for (const [re, rep] of VALUE_PATTERNS) out = out.replace(re, rep);
  if (prod) for (const [re, rep] of PROD_PATTERNS) out = out.replace(re, rep);
  return out.length > maxLen ? out.slice(0, maxLen) + `…[+${out.length - maxLen}]` : out;
}

/** Type/size summary used instead of a value in prod mode. */
export function shape(v, depth = 0) {
  if (v === null || v === undefined) return v;
  if (Array.isArray(v)) return { _array: v.length, ...(depth < 2 && v.length ? { of: shape(v[0], depth + 1) } : {}) };
  if (typeof v === "object") {
    const keys = Object.keys(v);
    return depth < 2
      ? Object.fromEntries(keys.slice(0, 30).map((k) => [k, shape(v[k], depth + 1)]))
      : { _object: keys.length };
  }
  if (typeof v === "string") return { _string: v.length };
  return typeof v; // number | boolean — type only
}

export function scrub(value, { mode = "dev", key = "", depth = 0 } = {}) {
  const prod = mode === "prod";
  const maxStr = prod ? 200 : 4000;
  if (key && SECRET_KEY.test(key)) return "[redacted]";
  if (prod && key && PAYLOAD_KEY.test(key)) return shape(value);
  if (value === null || value === undefined) return value;
  if (typeof value === "string") return scrubString(value, prod, maxStr);
  if (typeof value === "number") return Number.isFinite(value) ? value : String(value);
  if (typeof value === "boolean") return value;
  if (typeof value === "bigint") return String(value);
  if (depth >= 8) return "[max depth]";
  if (Array.isArray(value)) {
    const cap = prod ? 20 : 200;
    const out = value.slice(0, cap).map((v) => scrub(v, { mode, key: "", depth: depth + 1 }));
    if (value.length > cap) out.push(`[+${value.length - cap} more]`);
    return out;
  }
  if (typeof value === "object") {
    const out = {};
    let n = 0;
    for (const k of Object.keys(value)) {
      if (n++ >= 60) { out._truncated = true; break; }
      out[k] = scrub(value[k], { mode, key: k, depth: depth + 1 });
    }
    return out;
  }
  return String(value);
}
