import "server-only";

import { prisma } from "@/lib/prisma";
import {
  chainOf,
  type AdsChain,
  type ChainTaskFacts,
} from "@/lib/module-flows/ads/chain";
import { ADS_FLOW_COPY } from "@/lib/module-flows/ads/copy";
import type { AdsLaunch } from "@/lib/module-flows/ads/state";
import { taskFingerprint } from "@/server/agency/fingerprint";

// Reads the launch chain of one Ads Manager card from its lineage: the
// campaign Task carries the card's Command, and each next Task is found by the
// fingerprint its relay gave it (meta-campaign-chain-relay.ts: the ad set's
// subject is the campaign Task; meta-adset-chain-relay.ts: the ad's subject is
// the ad set Task). Read-only, tenant-scoped.

const DEPARTMENT = "PERFORMANCE_MARKETING";
// The card's launch clock and the database clock may disagree a little.
const CLOCK_SLACK_MS = 60_000;
// A launch claimed this long ago without a campaign Task never started (the
// request died between the claim and the plan): it can be launched again.
const START_TIMEOUT_MS = 5 * 60_000;

const TASK_SELECT = { id: true, status: true } as const;
type TaskRow = { id: string; status: string };

function startedBound(launch: AdsLaunch): Date | undefined {
  const at = Date.parse(launch.startedAt);
  return Number.isFinite(at) ? new Date(at - CLOCK_SLACK_MS) : undefined;
}

async function campaignTaskOf(
  projectId: string,
  commandId: string,
  launch: AdsLaunch,
): Promise<TaskRow | null> {
  if (launch.campaignTaskId) {
    return prisma.task.findFirst({
      where: { id: launch.campaignTaskId, projectId },
      select: TASK_SELECT,
    });
  }
  // Planned but its id not written back yet: the newest campaign Task of this
  // card since this launch began.
  const since = startedBound(launch);
  return prisma.task.findFirst({
    where: {
      projectId,
      commandId,
      capability: "META_CAMPAIGN_CREATE",
      ...(since ? { createdAt: { gte: since } } : {}),
    },
    orderBy: { createdAt: "desc" },
    select: TASK_SELECT,
  });
}

function nextTaskOf(
  projectId: string,
  capability: "META_ADSET_CREATE" | "META_AD_CREATE",
  subjectTaskId: string,
): Promise<TaskRow | null> {
  return prisma.task.findFirst({
    where: {
      projectId,
      fingerprint: taskFingerprint({
        capability,
        department: DEPARTMENT,
        subject: subjectTaskId,
      }),
    },
    orderBy: { createdAt: "desc" },
    select: TASK_SELECT,
  });
}

const META_ID_KEY = ["campaignId", "adSetId", "adId"] as const;

export async function loadAdsChain(
  projectId: string,
  input: { commandId: string; launch: AdsLaunch },
): Promise<AdsChain> {
  const campaign = await campaignTaskOf(
    projectId,
    input.commandId,
    input.launch,
  );
  if (!campaign) {
    const at = Date.parse(input.launch.startedAt);
    const stale = Number.isFinite(at) && Date.now() - at > START_TIMEOUT_MS;
    return chainOf([
      stale ? { status: "FAILED", error: ADS_FLOW_COPY.notStarted } : null,
      null,
      null,
    ]);
  }
  const adSet = await nextTaskOf(projectId, "META_ADSET_CREATE", campaign.id);
  const ad = adSet
    ? await nextTaskOf(projectId, "META_AD_CREATE", adSet.id)
    : null;
  const tasks = [campaign, adSet, ad] as const;
  const ids = tasks.filter((task): task is TaskRow => !!task).map((t) => t.id);

  const [approvals, jobs] = await Promise.all([
    prisma.approval.findMany({
      where: { projectId, taskId: { in: ids } },
      orderBy: { createdAt: "desc" },
      select: { id: true, taskId: true, status: true },
    }),
    prisma.executionJob.findMany({
      where: { projectId, taskId: { in: ids } },
      orderBy: { createdAt: "desc" },
      select: { taskId: true, errorMessage: true, rawResult: true },
    }),
  ]);

  const factsOf = (
    task: TaskRow | null,
    index: number,
  ): ChainTaskFacts | null => {
    if (!task) return null;
    const own = approvals.filter((approval) => approval.taskId === task.id);
    const pending = own.find((approval) => approval.status === "PENDING");
    // Newest first: the first job of a task is its latest run.
    const job = jobs.find((row) => row.taskId === task.id);
    const raw = (job?.rawResult ?? null) as Record<string, unknown> | null;
    const metaId = raw?.[META_ID_KEY[index]!];
    return {
      status: task.status,
      ...(pending ? { pendingApprovalId: pending.id } : {}),
      ...(own.some((approval) => approval.status === "REJECTED")
        ? { rejected: true }
        : {}),
      ...(job?.errorMessage ? { error: job.errorMessage } : {}),
      ...(typeof metaId === "string" && metaId ? { metaId } : {}),
    };
  };

  return chainOf([
    factsOf(tasks[0], 0),
    factsOf(tasks[1], 1),
    factsOf(tasks[2], 2),
  ]);
}
