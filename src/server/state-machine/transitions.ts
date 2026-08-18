import type {
  AgencyTriggerStatus,
  ApprovalStatus,
  BrowserProfileStatus,
  CreativeStatus,
  ExecutionJobStatus,
  HumanInterventionStatus,
  IdeaStatus,
  InsightStatus,
  MeasurementCheckStatus,
  OpportunityStatus,
  ProjectGoalStatus,
  ProjectStatus,
  SetupStageStatus,
  SignalStatus,
  TaskStatus,
  WorkHandoffStatus,
  WorkPlanStatus,
} from "@prisma/client";

import { AgentelseError } from "@/server/security/errors";

// Centralized transition tables. Every status mutation in the codebase must
// go through assertTransition() below instead of writing `status: X`
// directly — this is what makes `COMPLETED -> RUNNING` impossible regardless
// of which call site attempts it.

const TASK_TRANSITIONS: Record<TaskStatus, TaskStatus[]> = {
  DRAFT: ["READY", "CANCELLED"],
  READY: ["QUEUED", "WAITING_APPROVAL", "BLOCKED", "CANCELLED"],
  QUEUED: ["RUNNING", "BLOCKED", "CANCELLED"],
  RUNNING: [
    "WAITING_INPUT",
    "WAITING_HUMAN",
    "WAITING_APPROVAL",
    "WAITING_PROVIDER",
    "VERIFYING",
    "COMPLETED",
    "FAILED",
    "BLOCKED",
    "CANCELLED",
  ],
  WAITING_INPUT: ["QUEUED", "RUNNING", "CANCELLED"],
  WAITING_HUMAN: ["QUEUED", "RUNNING", "FAILED", "CANCELLED"],
  WAITING_APPROVAL: ["QUEUED", "RUNNING", "FAILED", "CANCELLED"],
  WAITING_PROVIDER: ["RUNNING", "FAILED", "CANCELLED"],
  VERIFYING: ["COMPLETED", "FAILED"],
  COMPLETED: [],
  FAILED: ["QUEUED"],
  BLOCKED: ["READY", "CANCELLED"],
  CANCELLED: [],
};

const EXECUTION_JOB_TRANSITIONS: Record<
  ExecutionJobStatus,
  ExecutionJobStatus[]
> = {
  QUEUED: ["RUNNING", "CANCELLED"],
  RUNNING: [
    "WAITING_HUMAN",
    "WAITING_PROVIDER",
    "VERIFYING",
    "COMPLETED",
    "FAILED",
    "CANCELLED",
  ],
  WAITING_HUMAN: ["RUNNING", "FAILED", "CANCELLED"],
  WAITING_PROVIDER: ["RUNNING", "FAILED", "CANCELLED"],
  VERIFYING: ["COMPLETED", "FAILED"],
  COMPLETED: [],
  FAILED: ["QUEUED"],
  CANCELLED: [],
};

const APPROVAL_TRANSITIONS: Record<ApprovalStatus, ApprovalStatus[]> = {
  PENDING: [
    "APPROVED",
    "REJECTED",
    "REVISION_REQUESTED",
    "EXPIRED",
    "CANCELLED",
  ],
  APPROVED: [],
  REJECTED: [],
  REVISION_REQUESTED: ["CANCELLED"],
  EXPIRED: [],
  CANCELLED: [],
};

const HUMAN_INTERVENTION_TRANSITIONS: Record<
  HumanInterventionStatus,
  HumanInterventionStatus[]
> = {
  PENDING: ["RESOLVED", "EXPIRED", "CANCELLED"],
  RESOLVED: [],
  EXPIRED: [],
  CANCELLED: [],
};

// Exported so UI code (Entegrasyonlar sayfası) can derive its action
// buttons from the exact same table the server enforces, instead of a
// hand-maintained duplicate that can silently drift out of sync.
export const BROWSER_PROFILE_TRANSITIONS: Record<
  BrowserProfileStatus,
  BrowserProfileStatus[]
> = {
  READY: ["RUNNING", "DISABLED", "UNHEALTHY"],
  RUNNING: [
    "READY",
    "WAITING",
    "LOGIN_REQUIRED",
    "MFA_REQUIRED",
    "OTP_REQUIRED",
    "CAPTCHA_REQUIRED",
    "SESSION_EXPIRED",
    "USER_ACTION_REQUIRED",
    "PERMISSION_REQUIRED",
    "UNHEALTHY",
  ],
  WAITING: ["RUNNING", "READY", "SESSION_EXPIRED", "UNHEALTHY"],
  LOGIN_REQUIRED: ["READY", "RUNNING", "DISABLED"],
  MFA_REQUIRED: ["READY", "RUNNING", "DISABLED"],
  OTP_REQUIRED: ["READY", "RUNNING", "DISABLED"],
  CAPTCHA_REQUIRED: ["READY", "RUNNING", "DISABLED"],
  SESSION_EXPIRED: ["LOGIN_REQUIRED", "READY", "DISABLED"],
  USER_ACTION_REQUIRED: ["READY", "RUNNING", "DISABLED"],
  PERMISSION_REQUIRED: ["READY", "DISABLED"],
  UNHEALTHY: ["READY", "DISABLED"],
  DISABLED: ["READY"],
};

const CREATIVE_TRANSITIONS: Record<CreativeStatus, CreativeStatus[]> = {
  DRAFT: ["IN_REVIEW", "ARCHIVED"],
  IN_REVIEW: ["APPROVED", "REJECTED", "DRAFT"],
  APPROVED: ["PUBLISHED", "DRAFT", "ARCHIVED"],
  REJECTED: ["DRAFT", "ARCHIVED"],
  PUBLISHED: ["ARCHIVED"],
  ARCHIVED: [],
};

// Projenin kaba yaşam döngüsü. Sahibi ProjectSetupOrchestrator: 12 aşamalı
// Ajans Kurulumu yalnızca CREATED -> DISCOVERY -> PROFILE_REVIEW -> ACTIVE
// yolunu kullanır (ince taneli ilerleme SetupStage/SetupStageStatus'ta
// tutulur).
//
// NEEDS_INFORMATION, NEEDS_ASSESSMENT ve STRATEGY'yi artık hiçbir kod
// yazmıyor: ilki kaldırılan 3 adımlı kurulum sihirbazının manuel giriş
// yoluydu, diğer ikisi hiç yazılmamış marka-strateji akışı için rezerveydi.
// Enum değerleri ve geçişleri, eski satırların okunabilirliği için duruyor —
// Postgres'te enum değeri düşürmek tabloyu yeniden kurmayı gerektirir ve
// kazancı yok.
const PROJECT_TRANSITIONS: Record<ProjectStatus, ProjectStatus[]> = {
  CREATED: ["DISCOVERY"],
  DISCOVERY: ["NEEDS_INFORMATION", "PROFILE_REVIEW"],
  NEEDS_INFORMATION: ["DISCOVERY", "PROFILE_REVIEW"],
  PROFILE_REVIEW: ["NEEDS_ASSESSMENT", "ACTIVE"],
  NEEDS_ASSESSMENT: ["STRATEGY", "PROFILE_REVIEW"],
  STRATEGY: ["ACTIVE", "NEEDS_ASSESSMENT"],
  ACTIVE: ["PAUSED", "CLOSED"],
  PAUSED: ["ACTIVE", "CLOSED"],
  CLOSED: [],
};

// =============================================================================
// AGENCY OS LIFECYCLES
// =============================================================================

// One record per (project, stage). PENDING is created upfront for all 12
// stages; the orchestrator RUNs them strictly in SETUP_STAGE_ORDER.
const SETUP_STAGE_TRANSITIONS: Record<SetupStageStatus, SetupStageStatus[]> = {
  PENDING: ["RUNNING", "SKIPPED"],
  RUNNING: ["WAITING_CLIENT", "COMPLETED", "FAILED"],
  WAITING_CLIENT: ["RUNNING", "COMPLETED", "SKIPPED"],
  FAILED: ["RUNNING"],
  COMPLETED: [],
  SKIPPED: [],
};

const SIGNAL_TRANSITIONS: Record<SignalStatus, SignalStatus[]> = {
  NEW: ["SCORED", "DUPLICATE", "DISCARDED"],
  SCORED: ["PROMOTED", "DISCARDED"],
  PROMOTED: [],
  DISCARDED: [],
  DUPLICATE: [],
};

const INSIGHT_TRANSITIONS: Record<InsightStatus, InsightStatus[]> = {
  NEW: ["EVALUATED", "ARCHIVED"],
  EVALUATED: ["PROMOTED", "ARCHIVED"],
  PROMOTED: ["ARCHIVED"],
  ARCHIVED: [],
};

const OPPORTUNITY_TRANSITIONS: Record<OpportunityStatus, OpportunityStatus[]> =
  {
    NEW: ["REVIEWING", "EVALUATED", "DUPLICATE", "DISMISSED"],
    REVIEWING: ["ACCEPTED", "DISMISSED"],
    EVALUATED: ["ACCEPTED", "DISMISSED", "EXPIRED", "DUPLICATE"],
    ACCEPTED: [
      "CONVERTED_TO_IDEA",
      "CONVERTED_TO_TASK",
      "EXPIRED",
      "DISMISSED",
    ],
    DISMISSED: [],
    CONVERTED_TO_TASK: [],
    CONVERTED_TO_IDEA: [],
    EXPIRED: [],
    DUPLICATE: [],
  };

// Exported so UI code (which shows/hides decision buttons) can derive its
// guards from the exact same table the server enforces, instead of a
// hand-maintained duplicate that can silently drift out of sync.
export const IDEA_TRANSITIONS: Record<IdeaStatus, IdeaStatus[]> = {
  RAW: ["RESEARCHING", "VALIDATED", "REJECTED", "ARCHIVED"],
  RESEARCHING: ["VALIDATED", "REJECTED", "ARCHIVED"],
  VALIDATED: ["CONCEPT", "REJECTED", "ARCHIVED"],
  CONCEPT: ["SHORTLISTED", "REJECTED", "ARCHIVED"],
  SHORTLISTED: ["APPROVED", "REJECTED", "ARCHIVED"],
  APPROVED: ["PLANNING"],
  PLANNING: ["ACTIVE"],
  ACTIVE: ["MEASURING", "ARCHIVED"],
  MEASURING: ["LEARNED", "ARCHIVED"],
  LEARNED: ["ARCHIVED"],
  ARCHIVED: [],
  REJECTED: [],
};

const WORK_PLAN_TRANSITIONS: Record<WorkPlanStatus, WorkPlanStatus[]> = {
  DRAFT: ["AWAITING_APPROVAL", "APPROVED", "CANCELLED"],
  AWAITING_APPROVAL: ["APPROVED", "CANCELLED"],
  APPROVED: ["IN_PROGRESS", "CANCELLED"],
  IN_PROGRESS: ["COMPLETED", "FAILED", "CANCELLED"],
  COMPLETED: [],
  FAILED: [],
  CANCELLED: [],
};

const WORK_HANDOFF_TRANSITIONS: Record<WorkHandoffStatus, WorkHandoffStatus[]> =
  {
    PROPOSED: ["ACCEPTED", "REJECTED", "EXPIRED"],
    ACCEPTED: ["TASK_CREATED", "EXPIRED"],
    TASK_CREATED: ["COMPLETED"],
    COMPLETED: [],
    REJECTED: [],
    EXPIRED: [],
  };

const PROJECT_GOAL_TRANSITIONS: Record<ProjectGoalStatus, ProjectGoalStatus[]> =
  {
    PROPOSED: ["APPROVED", "REJECTED"],
    APPROVED: ["ACTIVE", "ARCHIVED"],
    ACTIVE: ["PAUSED", "ACHIEVED", "ARCHIVED"],
    PAUSED: ["ACTIVE", "ARCHIVED"],
    ACHIEVED: ["ARCHIVED"],
    REJECTED: [],
    ARCHIVED: [],
  };

const MEASUREMENT_CHECK_TRANSITIONS: Record<
  MeasurementCheckStatus,
  MeasurementCheckStatus[]
> = {
  PENDING: ["SCHEDULED", "SKIPPED"],
  SCHEDULED: ["RUNNING", "SKIPPED"],
  RUNNING: ["COMPLETED", "FAILED"],
  FAILED: ["SCHEDULED"],
  COMPLETED: [],
  SKIPPED: [],
};

const AGENCY_TRIGGER_TRANSITIONS: Record<
  AgencyTriggerStatus,
  AgencyTriggerStatus[]
> = {
  PENDING: ["PROCESSING", "SKIPPED"],
  PROCESSING: ["PROCESSED", "FAILED"],
  FAILED: ["PENDING"],
  PROCESSED: [],
  SKIPPED: [],
};

function assertTransition<T extends string>(
  entity: string,
  table: Record<T, T[]>,
  from: T,
  to: T,
): void {
  if (from === to) return;
  const allowed = table[from] ?? [];
  if (!allowed.includes(to)) {
    throw new AgentelseError(
      "INVALID_STATE_TRANSITION",
      `${entity}: invalid transition ${from} -> ${to}`,
    );
  }
}

export const StateMachine = {
  assertTaskTransition: (from: TaskStatus, to: TaskStatus) =>
    assertTransition("Task", TASK_TRANSITIONS, from, to),
  assertExecutionJobTransition: (
    from: ExecutionJobStatus,
    to: ExecutionJobStatus,
  ) => assertTransition("ExecutionJob", EXECUTION_JOB_TRANSITIONS, from, to),
  assertApprovalTransition: (from: ApprovalStatus, to: ApprovalStatus) =>
    assertTransition("Approval", APPROVAL_TRANSITIONS, from, to),
  assertHumanInterventionTransition: (
    from: HumanInterventionStatus,
    to: HumanInterventionStatus,
  ) =>
    assertTransition(
      "HumanInterventionRequest",
      HUMAN_INTERVENTION_TRANSITIONS,
      from,
      to,
    ),
  assertBrowserProfileTransition: (
    from: BrowserProfileStatus,
    to: BrowserProfileStatus,
  ) =>
    assertTransition("BrowserProfile", BROWSER_PROFILE_TRANSITIONS, from, to),
  assertCreativeTransition: (from: CreativeStatus, to: CreativeStatus) =>
    assertTransition("Creative", CREATIVE_TRANSITIONS, from, to),
  assertProjectTransition: (from: ProjectStatus, to: ProjectStatus) =>
    assertTransition("Project", PROJECT_TRANSITIONS, from, to),

  // Agency OS lifecycles
  assertSetupStageTransition: (from: SetupStageStatus, to: SetupStageStatus) =>
    assertTransition(
      "ProjectSetupStageRecord",
      SETUP_STAGE_TRANSITIONS,
      from,
      to,
    ),
  assertSignalTransition: (from: SignalStatus, to: SignalStatus) =>
    assertTransition("Signal", SIGNAL_TRANSITIONS, from, to),
  assertInsightTransition: (from: InsightStatus, to: InsightStatus) =>
    assertTransition("Insight", INSIGHT_TRANSITIONS, from, to),
  assertOpportunityTransition: (
    from: OpportunityStatus,
    to: OpportunityStatus,
  ) => assertTransition("Opportunity", OPPORTUNITY_TRANSITIONS, from, to),
  assertIdeaTransition: (from: IdeaStatus, to: IdeaStatus) =>
    assertTransition("Idea", IDEA_TRANSITIONS, from, to),
  assertWorkPlanTransition: (from: WorkPlanStatus, to: WorkPlanStatus) =>
    assertTransition("WorkPlan", WORK_PLAN_TRANSITIONS, from, to),
  assertWorkHandoffTransition: (
    from: WorkHandoffStatus,
    to: WorkHandoffStatus,
  ) => assertTransition("WorkHandoff", WORK_HANDOFF_TRANSITIONS, from, to),
  assertProjectGoalTransition: (
    from: ProjectGoalStatus,
    to: ProjectGoalStatus,
  ) => assertTransition("ProjectGoal", PROJECT_GOAL_TRANSITIONS, from, to),
  assertMeasurementCheckTransition: (
    from: MeasurementCheckStatus,
    to: MeasurementCheckStatus,
  ) =>
    assertTransition(
      "MeasurementCheck",
      MEASUREMENT_CHECK_TRANSITIONS,
      from,
      to,
    ),
  assertAgencyTriggerTransition: (
    from: AgencyTriggerStatus,
    to: AgencyTriggerStatus,
  ) => assertTransition("AgencyTrigger", AGENCY_TRIGGER_TRANSITIONS, from, to),
};
