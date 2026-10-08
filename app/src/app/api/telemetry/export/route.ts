/**
 * /api/telemetry/export — lecture seule pour la console locale (qa/console/sources/pull.mjs).
 * Jeton porteur TRACE_EXPORT_TOKEN ; sans ce jeton configuré, la route répond 404 (comme si elle n'existait pas).
 */
import { defaultDeps, handleExport } from "@/app/lib/trace/prod/server";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(req: Request) {
  return handleExport(req, defaultDeps(async () => ({ userId: null, email: null })));
}
