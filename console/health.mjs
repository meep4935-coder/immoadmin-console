// Single definition of "user health", shared by the API and the alert rules.
// Rate-based, so a heavy user with a handful of errors among hundreds of
// actions is not flagged, while a user whose last few actions all failed is.
//   bad  = errors + dead clicks      rate = bad / traces
//   failing  : bad >= 3 and rate >= 25%
//   degraded : bad >= 1 and rate >= 5%,  or  slow >= 3 and slow-rate >= 25%
export function healthOf({ errors = 0, dead = 0, slow = 0, traces = 0 }) {
  const t = Math.max(1, traces);
  const bad = errors + dead;
  if (bad >= 3 && bad / t >= 0.25) return "failing";
  if (bad >= 1 && bad / t >= 0.05) return "degraded";
  if (slow >= 3 && slow / t >= 0.25) return "degraded";
  return "healthy";
}
