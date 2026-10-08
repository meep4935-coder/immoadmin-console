/**
 * /api/telemetry — enregistreur de PRODUCTION.
 *   GET  : dit au navigateur s'il doit enregistrer (interrupteur maître, coupure à distance, liste d'autorisation).
 *   POST : reçoit un lot d'événements ; tout passe par la liste blanche de confidentialité avant d'être stocké.
 *
 * Éteint par défaut (TRACE_PROD_ENABLED). Voir DEPLOY-GUIDE.md. La logique est dans lib/trace/prod/server.ts.
 */
import { cookies } from "next/headers";
import { createServerClient } from "@supabase/ssr";
import { defaultDeps, handleConfig, handleIngest, type Identity } from "@/app/lib/trace/prod/server";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * Qui est l'utilisateur ? Sert UNIQUEMENT à fabriquer la référence pseudonyme et à appliquer la liste d'autorisation.
 * `getSession` lit le cookie localement (sans appel réseau à Supabase Auth, qui serait trop coûteux à chaque lot) :
 * ce n'est PAS une vérification d'authentification, et ça n'en a pas besoin — au pire, un cookie falsifié mal-étiquette sa propre télémétrie.
 */
async function getIdentity(): Promise<Identity> {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL, anon = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !anon) return { userId: null, email: null };
  const store = await cookies();
  const sb = createServerClient(url, anon, { cookies: { getAll: () => store.getAll(), setAll: () => {} } });
  const { data } = await sb.auth.getSession();
  return { userId: data.session?.user?.id ?? null, email: data.session?.user?.email ?? null };
}

export async function GET(req: Request) { return handleConfig(req, defaultDeps(getIdentity)); }
export async function POST(req: Request) { return handleIngest(req, defaultDeps(getIdentity)); }
