import "server-only";

import type { ExecutionJobStatus, RiskLevel } from "@prisma/client";

import { prisma } from "@/lib/prisma";
import { ExecutionService } from "@/server/execution/execution-service";
import {
  OUTBOX_EVENT_TYPES,
  OutboxRepository,
} from "@/server/repositories/outbox.repository";
import { isAgentelseError } from "@/server/security/errors";

// Running an execution job "inline" — inside a chat request, right now,
// instead of waiting for the worker's next tick (generate_image, content
// package items).

// How long an inline run will wait for a job that ANOTHER process (the
// worker) grabbed before we could. Generation itself is bounded at ~120 s by
// the image client; this only covers the worker-race fallback.
const INLINE_JOB_WAIT_MS = 150_000;
const INLINE_JOB_POLL_MS = 2_000;

export type SettledJob = {
  status: ExecutionJobStatus;
  errorMessage: string | null;
};

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

  let settled: SettledJob;
  try {
    settled = await ExecutionService.startExecution(jobId, riskLevel);
  } catch (error) {
    // The usage ledger could not be read, which says nothing about this job. The
    // dispatch event was taken above, so give the job back to the worker (it
    // retries without spending an attempt) instead of leaving it queued with
    // nothing left to start it.
    if (isAgentelseError(error) && error.code === "BILLING_UNAVAILABLE") {
      await handBackToWorker(jobId, riskLevel);
      return { status: "QUEUED", errorMessage: null };
    }
    throw error;
  }
  if (settled.status === "QUEUED" || settled.status === "RUNNING") {
    settled = await waitForJobToSettle(jobId);
  }
  return settled;
}

async function handBackToWorker(
  jobId: string,
  riskLevel: RiskLevel,
): Promise<void> {
  const job = await prisma.executionJob.findUnique({
    where: { id: jobId },
    select: { workspaceId: true, projectId: true, status: true },
  });
  if (!job || job.status !== "QUEUED") return;
  await OutboxRepository.enqueue(prisma, {
    workspaceId: job.workspaceId,
    projectId: job.projectId,
    aggregateType: "ExecutionJob",
    aggregateId: jobId,
    eventType: OUTBOX_EVENT_TYPES.EXECUTION_DISPATCH,
    payload: { executionJobId: jobId, riskLevel },
    executionJobId: jobId,
  });
}
