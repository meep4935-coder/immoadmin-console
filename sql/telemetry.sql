-- ════════════════════════════════════════════════════════════════════════════
-- TÉLÉMÉTRIE ImmoAdmin — table de stockage
--
-- À EXÉCUTER DANS UN PROJET SUPABASE **SÉPARÉ** (dédié à la télémétrie, région Canada recommandée),
-- PAS dans la base principale d'ImmoAdmin. Ce n'est PAS une migration du dossier supabase/migrations :
-- ne pas la copier là.
--
-- Contenu : événements techniques pseudonymisés (jamais de nom, courriel, montant, adresse, ni contenu de document).
-- Accès : uniquement la clé service-role, depuis le serveur (route /api/telemetry). RLS activé SANS aucune politique =
-- refus total pour anon et authenticated. Idempotent : peut être rejoué sans danger.
-- ════════════════════════════════════════════════════════════════════════════

create table if not exists public.telemetry_events (
  id         bigint generated always as identity primary key,
  ts         timestamptz not null,
  kind       text        not null,
  name       text        not null,
  status     text        not null,
  trace_id   text        not null,
  span_id    text        not null,
  parent_id  text,
  user_ref   text,                       -- HMAC(secret, user_id) tronqué : jamais l'identifiant réel
  session_id text        not null,
  role       text,                       -- tenant | owner | admin | delegate | anonymous
  route      text,                       -- chemin normalisé (/locataire/:id), sans paramètres
  release    text,
  tier       text        not null default 'A',  -- A = erreurs/temps ; B = clics/navigation (après consentement)
  dur        double precision,
  attrs      jsonb       not null default '{}'::jsonb,
  error      jsonb,
  created_at timestamptz not null default now()
);

-- La console lit par id croissant ; la purge et la lecture récente passent par ts ; l'effacement d'un compte par user_ref.
create index if not exists telemetry_events_ts_idx       on public.telemetry_events (ts);
create index if not exists telemetry_events_user_ref_idx on public.telemetry_events (user_ref) where user_ref is not null;

alter table public.telemetry_events enable row level security;
-- Volontairement AUCUNE politique : seul le service-role (qui contourne RLS) peut lire/écrire.
revoke all on public.telemetry_events from anon, authenticated;

comment on table public.telemetry_events is
  'Télémétrie pseudonymisée. Rétention 14 jours par défaut (cron /api/cron/telemetry-purge). Effacement par compte : deleteTelemetryForUser().';

-- ── Vérification (doit renvoyer relrowsecurity = true et 0 politique) ────────
-- select relrowsecurity from pg_class where oid = 'public.telemetry_events'::regclass;
-- select count(*) from pg_policies where tablename = 'telemetry_events';
