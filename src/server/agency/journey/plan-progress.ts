import type { CreativeStatus, TaskStatus } from "@prisma/client";

import {
  isChannelKey,
  resolveFormat,
  type PublishMode,
} from "@/lib/content-channels";
import type { JourneyItem, PlanItemStage } from "@/lib/journey";
import { dayKeyInTimezone } from "@/lib/timezone";

// Where a planned calendar slot stands, read off the rows that already exist.
// Saving a plan writes DRAFT Creatives (planId set); production fills them
// (plan-run.ts, execution-service.ts), approval and publishing move them on.
// One definition, shared by the chat bar, the plan card and the calendar, so
// they can never disagree about what "needs content" means.

export type PlanCreativeRow = {
  id: string;
  planId: string;
  status: CreativeStatus;
  currentVersionId: string | null;
  scheduledFor: Date | null;
  channel: string | null;
  formatKey: string | null;
  title: string | null;
  platform: string | null;
  // The latest version's image, when it has one.
  assetId?: string | null;
};

// A job that belongs to a plan slot (Task.payload.planCreativeId).
export type PlanTaskRow = {
  creativeId: string;
  status: TaskStatus;
  updatedAt: Date;
};

const TERMINAL_TASK: ReadonlySet<TaskStatus> = new Set([
  "COMPLETED",
  "FAILED",
  "CANCELLED",
]);

// The stage of one slot, or null when it is out of the journey (archived).
export function deriveItemStage(
  row: Pick<PlanCreativeRow, "status" | "currentVersionId">,
  tasks: readonly Pick<PlanTaskRow, "status" | "updatedAt">[],
): PlanItemStage | null {
  switch (row.status) {
    case "ARCHIVED":
      return null;
    case "PUBLISHED":
      return "PUBLISHED";
    case "APPROVED":
      return "APPROVED";
    case "REJECTED":
      return "REJECTED";
    case "IN_REVIEW":
      return "IN_REVIEW";
    case "DRAFT":
      break;
  }
  // DRAFT with content: something to look at.
  if (row.currentVersionId) return "IN_REVIEW";
  if (tasks.some((task) => !TERMINAL_TASK.has(task.status))) return "PRODUCING";
  const latest = [...tasks].sort(
    (a, b) => b.updatedAt.getTime() - a.updatedAt.getTime(),
  )[0];
  return latest?.status === "FAILED" ? "FAILED" : "PLANNED";
}

export function toJourneyItem(
  row: PlanCreativeRow,
  tasks: readonly PlanTaskRow[],
  timezone: string,
): JourneyItem | null {
  const stage = deriveItemStage(
    row,
    tasks.filter((task) => task.creativeId === row.id),
  );
  if (!stage) return null;
  const channel = isChannelKey(row.channel) ? row.channel : undefined;
  const format =
    channel && row.formatKey
      ? resolveFormat(channel, row.formatKey)
      : undefined;
  const publish: PublishMode = format?.publish ?? "manual";
  return {
    id: row.id,
    planId: row.planId,
    stage,
    channel,
    publish,
    date: row.scheduledFor ? dayKeyInTimezone(row.scheduledFor, timezone) : "",
    title: row.title?.trim() || "Untitled",
    assetId: row.assetId ?? undefined,
    platform: row.platform ?? undefined,
  };
}

export { selectProductionBatch } from "@/lib/journey";
