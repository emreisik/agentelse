import { timingSafeEqual } from "node:crypto";

import { NextResponse } from "next/server";

import { getEnv } from "@/lib/env";
import { ExecutionWorker } from "@/server/workers/execution-worker";
import { DeadLetterRepository } from "@/server/repositories/dead-letter.repository";

function isValidCronSecret(authHeader: string | null, secret: string): boolean {
  if (!authHeader) return false;
  const actualBuf = Buffer.from(authHeader);
  const expectedBuf = Buffer.from(`Bearer ${secret}`);
  return (
    actualBuf.length === expectedBuf.length &&
    timingSafeEqual(actualBuf, expectedBuf)
  );
}

// Production entry point for the outbox worker tick — call this from an
// external scheduler (Railway cron, GitHub Actions, cron-job.org) since a
// serverless deployment cannot keep the instrumentation.ts setInterval loop
// alive between requests.
export async function POST(request: Request) {
  const env = getEnv();
  const authHeader = request.headers.get("authorization");

  if (!env.CRON_SECRET || !isValidCronSecret(authHeader, env.CRON_SECRET)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const startedAt = Date.now();
  try {
    await ExecutionWorker.tick();
  } catch (error) {
    // The external scheduler may not see the 500; leave a persistent trace
    // of the error so it shows up on the System Health screen.
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
