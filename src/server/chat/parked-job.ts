import "server-only";

import { prisma } from "@/lib/prisma";
import { BACKGROUND_SHARE_PCT } from "@/lib/billing/plans";
import { getEntitlements } from "@/server/billing/entitlements";
import { HELD_BACK_CODE } from "@/server/billing/quota-errors";

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
  // "held-back": the allowance is not used up, the system's own work reached its
  // share of it (a job nobody asked for in person).
  reason: "allowance-used" | "no-plan" | "held-back";
  unit?: "IMAGE" | "AI_MICROS";
  // When the allowance renews (ISO), the moment the job is woken again.
  resetsAt?: string;
  // held-back only: the share of the plan automatic work may use, in percent.
  sharePct?: number;
};

// Why a parked job waits and which allowance it waits for, for the chat to say so
// honestly. Lazy import: sizing a job pulls in the providers.
//
// Never throws: saying why a job waits is a courtesy, and a failure to look it up
// must not turn a job that is correctly parked into an error the client is told to
// retry (which would make the same work twice).
export async function describePause(jobId: string): Promise<PauseNotice> {
  try {
    const job = await prisma.executionJob.findUnique({
      where: { id: jobId },
      select: {
        workspaceId: true,
        errorCode: true,
        capability: true,
        requestPayload: true,
      },
    });
    const reason: PauseNotice["reason"] =
      job?.errorCode === "NO_PLAN"
        ? "no-plan"
        : job?.errorCode === HELD_BACK_CODE
          ? "held-back"
          : "allowance-used";
    if (!job) return { reason };
    const share =
      reason === "held-back"
        ? {
            sharePct:
              BACKGROUND_SHARE_PCT[
                (await getEntitlements(job.workspaceId)).autonomy
              ],
          }
        : {};
    const { usageNeedOf } = await import("@/server/execution/usage-need");
    const need = usageNeedOf(job.capability, job.requestPayload);
    if (!need) return { reason, ...share };
    if (reason === "no-plan") return { reason, unit: need.unit };
    // The window the allowance renews with: the same moment the resume sweep wakes
    // the job. A window that has already ended renews on the next sweep: no date.
    const balance = await prisma.usageBalance.findUnique({
      where: {
        workspaceId_unit: { workspaceId: job.workspaceId, unit: need.unit },
      },
      select: { periodEnd: true },
    });
    const endsAt = balance?.periodEnd ?? null;
    return endsAt && endsAt.getTime() > Date.now()
      ? { reason, unit: need.unit, resetsAt: endsAt.toISOString(), ...share }
      : { reason, unit: need.unit, ...share };
  } catch (error) {
    console.error(
      "[parked-job] could not describe a pause:",
      error instanceof Error ? error.name : error,
    );
    return { reason: "allowance-used" };
  }
}

// What the model is told when its tool paused instead of producing anything.
export const PAUSED_NOTE =
  "NOT made yet: the client's plan allowance for this period is used up, so this piece is paused. It goes on by itself when the allowance renews or more is added. Say that in one short sentence; never say it is ready, made or still rendering.";
