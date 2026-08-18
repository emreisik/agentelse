import { NextResponse } from "next/server";

import { getEnv } from "@/lib/env";
import { ExecutionWorker } from "@/server/workers/execution-worker";
import { DeadLetterRepository } from "@/server/repositories/dead-letter.repository";

// Production entry point for the outbox worker tick — call this from an
// external scheduler (Railway cron, GitHub Actions, cron-job.org) since a
// serverless deployment cannot keep the instrumentation.ts setInterval loop
// alive between requests.
export async function POST(request: Request) {
  const env = getEnv();
  const authHeader = request.headers.get("authorization");

  if (!env.CRON_SECRET || authHeader !== `Bearer ${env.CRON_SECRET}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const startedAt = Date.now();
  try {
    await ExecutionWorker.tick();
  } catch (error) {
    // Dış zamanlayıcı 500'ü görmeyebilir; hatanın kalıcı bir izi kalsın ki
    // Sistem Sağlığı ekranında görünsün.
    const message = error instanceof Error ? error.message : String(error);
    await DeadLetterRepository.create({
      reason: "cron.worker.tick_failed",
      payload: { durationMs: Date.now() - startedAt },
      attempts: 1,
      lastError: message,
    }).catch(() => undefined);
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }

  return NextResponse.json({ ok: true, durationMs: Date.now() - startedAt });
}
