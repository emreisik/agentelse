import "server-only";

import { prisma } from "@/lib/prisma";

// A job the plan allowance could not pay for waits (WAITING_BUDGET) and goes on by
// itself when the allowance renews or more is added. It is neither "still
// rendering" nor "ready" nor "failed": every consumer that branches on a settled
// job's status must handle it explicitly, or the model tells the client something
// that is not true (docs/billing-tasks.md). Kept apart from inline-job.ts so the
// pure helpers stay available to callers that stub the inline driver.

export function isParked(job: { status: string }): boolean {
  return job.status === "WAITING_BUDGET";
}

export type PauseNotice = {
  reason: "allowance-used" | "no-plan";
  unit?: "IMAGE" | "AI_MICROS";
};

// Why a parked job waits and which allowance it waits for, for the chat to say so
// honestly. Lazy import: sizing a job pulls in the providers.
export async function describePause(jobId: string): Promise<PauseNotice> {
  const job = await prisma.executionJob.findUnique({
    where: { id: jobId },
    select: { errorCode: true, capability: true, requestPayload: true },
  });
  const reason = job?.errorCode === "NO_PLAN" ? "no-plan" : "allowance-used";
  if (!job) return { reason };
  const { usageNeedOf } = await import("@/server/execution/usage-need");
  const need = usageNeedOf(job.capability, job.requestPayload);
  return need ? { reason, unit: need.unit } : { reason };
}

// What the model is told when its tool paused instead of producing anything.
export const PAUSED_NOTE =
  "NOT made yet: the client's plan allowance for this period is used up, so this piece is paused. It goes on by itself when the allowance renews or more is added. Say that in one short sentence; never say it is ready, made or still rendering.";
