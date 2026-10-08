/**
 * /api/cron/telemetry-purge — rétention : supprime la télémétrie plus vieille que TRACE_RETENTION_DAYS (14 par défaut).
 * Planifié dans vercel.json. Auth : assertCronAuth (comme tous les crons).
 */
import { NextRequest } from "next/server";
import { assertCronAuth } from "@/app/api/_lib/cron-auth";
import { defaultDeps, handlePurge } from "@/app/lib/trace/prod/server";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function GET(req: NextRequest) {
  const denied = assertCronAuth(req);
  if (denied) return denied;
  const deps = defaultDeps(async () => ({ userId: null, email: null }));
  return handlePurge(deps);
}
