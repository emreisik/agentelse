import type {
  ApprovalStatus,
  CreativeStatus,
  ExecutionJobStatus,
  IdeaStatus,
  TaskStatus,
  WorkPlanStatus,
} from "@prisma/client";

export type PipelineStageKey =
  "fikir" | "uretim" | "onay" | "yayinda" | "tamamlandi" | "durdu";

export const PIPELINE_STAGE_ORDER: PipelineStageKey[] = [
  "fikir",
  "uretim",
  "onay",
  "yayinda",
  "tamamlandi",
  "durdu",
];

export type PipelineStageInput = {
  ideaStatus: IdeaStatus | null;
  workPlanStatus: WorkPlanStatus | null;
  taskStatuses: TaskStatus[];
  executionJobStatuses: ExecutionJobStatus[];
  creativeStatuses: CreativeStatus[];
  approvalStatuses: ApprovalStatus[];
};

const STUCK_TASK_STATUSES: TaskStatus[] = ["FAILED", "CANCELLED", "BLOCKED"];
const ACTIVE_JOB_STATUSES: ExecutionJobStatus[] = [
  "RUNNING",
  "WAITING_PROVIDER",
  "VERIFYING",
];
const LIVE_CREATIVE_STATUSES: CreativeStatus[] = ["APPROVED", "PUBLISHED"];
const OPEN_APPROVAL_STATUSES: ApprovalStatus[] = [
  "PENDING",
  "REVISION_REQUESTED",
];
const WAITING_TASK_STATUSES: TaskStatus[] = [
  "WAITING_APPROVAL",
  "WAITING_HUMAN",
];
const IN_PROGRESS_PLAN_STATUSES: WorkPlanStatus[] = [
  "DRAFT",
  "APPROVED",
  "IN_PROGRESS",
];
const IN_PROGRESS_TASK_STATUSES: TaskStatus[] = [
  "DRAFT",
  "READY",
  "QUEUED",
  "RUNNING",
  "WAITING_INPUT",
];
const RESOLVED_IDEA_STATUSES: IdeaStatus[] = [
  "ACTIVE",
  "MEASURING",
  "LEARNED",
  "ARCHIVED",
];

// Single source of truth for "where is this initiative right now" across
// four otherwise-unlinked entities (Idea, WorkPlan, Task, ExecutionJob,
// Creative, Approval). Checked most-terminal-first so a card never gets
// stuck showing an optimistic mid-flow stage once a downstream record has
// already resolved it.
export function derivePipelineStage(
  input: PipelineStageInput,
): PipelineStageKey {
  const {
    ideaStatus,
    workPlanStatus,
    taskStatuses,
    executionJobStatuses,
    creativeStatuses,
    approvalStatuses,
  } = input;

  const hasTasks = taskStatuses.length > 0;

  // Idea rejection only stops the card while no WorkPlan is attached yet —
  // once a WorkPlan exists, ITS status is authoritative (mirrors the
  // !workPlanStatus guard on the "tamamlandi" idea check below). This also
  // protects against the idea<->workPlan match in pipeline.repository.ts
  // being a plain (non-FK) field match: a mismatched REJECTED idea can
  // never silently mask a WorkPlan that's genuinely still in progress.
  if (!workPlanStatus && ideaStatus === "REJECTED") return "durdu";
  if (workPlanStatus === "CANCELLED" || workPlanStatus === "FAILED") {
    return "durdu";
  }
  if (
    !workPlanStatus &&
    hasTasks &&
    taskStatuses.every((status) => STUCK_TASK_STATUSES.includes(status))
  ) {
    return "durdu";
  }

  if (workPlanStatus === "COMPLETED") return "tamamlandi";
  if (
    !workPlanStatus &&
    ideaStatus &&
    RESOLVED_IDEA_STATUSES.includes(ideaStatus)
  ) {
    return "tamamlandi";
  }
  if (
    !workPlanStatus &&
    !ideaStatus &&
    hasTasks &&
    taskStatuses.every((status) => status === "COMPLETED")
  ) {
    return "tamamlandi";
  }

  if (
    executionJobStatuses.some((status) =>
      ACTIVE_JOB_STATUSES.includes(status),
    ) ||
    creativeStatuses.some((status) => LIVE_CREATIVE_STATUSES.includes(status))
  ) {
    return "yayinda";
  }

  if (
    workPlanStatus === "AWAITING_APPROVAL" ||
    approvalStatuses.some((status) =>
      OPEN_APPROVAL_STATUSES.includes(status),
    ) ||
    taskStatuses.some((status) => WAITING_TASK_STATUSES.includes(status)) ||
    creativeStatuses.some((status) => status === "IN_REVIEW")
  ) {
    return "onay";
  }

  if (
    (workPlanStatus && IN_PROGRESS_PLAN_STATUSES.includes(workPlanStatus)) ||
    taskStatuses.some((status) => IN_PROGRESS_TASK_STATUSES.includes(status)) ||
    creativeStatuses.some((status) => status === "DRAFT")
  ) {
    return "uretim";
  }

  return "fikir";
}
