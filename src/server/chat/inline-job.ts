import "server-only";

import type { RiskLevel } from "@prisma/client";

import { prisma } from "@/lib/prisma";
import { ExecutionService } from "@/server/execution/execution-service";
import { OutboxRepository } from "@/server/repositories/outbox.repository";

// Running an execution job "inline" — inside a chat request, right now,
// instead of waiting for the worker's next tick (generate_image, content
// package items).

// How long an inline run will wait for a job that ANOTHER process (the
// worker) grabbed before we could. Generation itself is bounded at ~120 s by
// the image client; this only covers the worker-race fallback.
const INLINE_JOB_WAIT_MS = 150_000;
const INLINE_JOB_POLL_MS = 2_000;

export type SettledJob = { status: string; errorMessage: string | null };

export async function waitForJobToSettle(jobId: string): Promise<SettledJob> {
  const deadline = Date.now() + INLINE_JOB_WAIT_MS;
  for (;;) {
    const job = await prisma.executionJob.findUniqueOrThrow({
      where: { id: jobId },
      select: { status: true, errorMessage: true },
    });
    if (job.status !== "QUEUED" && job.status !== "RUNNING") return job;
    if (Date.now() > deadline) return job;
    await new Promise((resolve) => setTimeout(resolve, INLINE_JOB_POLL_MS));
  }
}

// Runs the job here and now and resolves once it has settled (or the wait ran
// out). Exactly one side runs the provider:
//  - the job's dispatch event is claimed first (OutboxRepository.
//    claimDispatchForInline), so the worker never sees it — its stalled-
//    dispatch recovery would otherwise restart a job that is legitimately
//    mid-run and generate everything twice;
//  - startExecution then claims the QUEUED job with a compare-and-swap;
//  - if the worker already holds the event, the job is left to it and this
//    just waits for the outcome.
export async function driveJobInline(
  jobId: string,
  riskLevel: RiskLevel,
): Promise<SettledJob> {
  const ownership = await OutboxRepository.claimDispatchForInline(jobId);
  if (ownership === "worker") return waitForJobToSettle(jobId);

  let settled: SettledJob = await ExecutionService.startExecution(
    jobId,
    riskLevel,
  );
  if (settled.status === "QUEUED" || settled.status === "RUNNING") {
    settled = await waitForJobToSettle(jobId);
  }
  return settled;
}
