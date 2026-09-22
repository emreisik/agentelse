import {
  Sparkles,
  Globe2,
  HeartHandshake,
  Swords,
  Palette,
  Brush,
  PenTool,
  Share2,
  Search,
  Gauge,
  BarChart3,
  TrendingUp,
  Newspaper,
  Users,
  Handshake,
  Repeat,
  MonitorSmartphone,
  CalendarDays,
  Radio,
} from "lucide-react";
import type {
  AgencyLoopStatus,
  AgencyTriggerStatus,
  AgencyTriggerType,
  CapabilityKey,
  DepartmentKey,
  DepartmentMode,
  MeasurementCheckStatus,
  MeasurementPlanStatus,
  ProjectGoalStatus,
  WorkHandoffStatus,
  WorkPlanStatus,
  WorkPlanType,
} from "@prisma/client";

import type { EnumMap } from "./types";

export const DEPARTMENT_KEY: EnumMap<DepartmentKey> = {
  BRAND_STRATEGY: {
    label: "Brand Strategy Team",
    tone: "active",
    icon: Sparkles,
  },
  MARKET_INTELLIGENCE: {
    label: "Market Intelligence Team",
    tone: "active",
    icon: Globe2,
  },
  CUSTOMER_INTELLIGENCE: {
    label: "Customer Intelligence Team",
    tone: "active",
    icon: HeartHandshake,
  },
  COMPETITOR_INTELLIGENCE: {
    label: "Competitor Intelligence Team",
    tone: "active",
    icon: Swords,
  },
  CREATIVE: { label: "Creative Team", tone: "active", icon: Palette },
  ART_DIRECTION: { label: "Art Direction Team", tone: "active", icon: Brush },
  COPY_CONTENT: { label: "Copy & Content Team", tone: "active", icon: PenTool },
  SOCIAL_MEDIA: { label: "Social Media Team", tone: "active", icon: Share2 },
  SEO: { label: "SEO Team", tone: "active", icon: Search },
  PERFORMANCE_MARKETING: {
    label: "Performance Marketing Team",
    tone: "active",
    icon: Gauge,
  },
  DATA_ANALYTICS: {
    label: "Data & Analytics Team",
    tone: "active",
    icon: BarChart3,
  },
  GROWTH: { label: "Growth Team", tone: "active", icon: TrendingUp },
  PR_MEDIA: { label: "PR & Media Team", tone: "active", icon: Newspaper },
  INFLUENCER_CREATOR: {
    label: "Influencer & Creator Team",
    tone: "active",
    icon: Users,
  },
  PARTNERSHIPS: { label: "Partnerships Team", tone: "active", icon: Handshake },
  CRM_LIFECYCLE: {
    label: "CRM & Lifecycle Team",
    tone: "active",
    icon: Repeat,
  },
  WEB_PRODUCT: {
    label: "Web & Product Team",
    tone: "active",
    icon: MonitorSmartphone,
  },
  EVENTS: { label: "Events Team", tone: "neutral", icon: CalendarDays },
  OFFLINE_MEDIA: { label: "Offline Media Team", tone: "neutral", icon: Radio },
};

export const ALL_DEPARTMENT_KEYS_UI = Object.keys(
  DEPARTMENT_KEY,
) as DepartmentKey[];

// Department "team color" identity — a separate visual channel independent
// of StatusTone (see StatusBadge accentColor). The 19 departments are
// grouped into 4 colorblind-safe categorical families; the department's
// full identity is always carried by the icon + "X Team" label, color is
// only for quick visual scanning.
export const DEPARTMENT_COLOR: Record<DepartmentKey, string> = {
  BRAND_STRATEGY: "var(--dept-strategy)",
  PARTNERSHIPS: "var(--dept-strategy)",
  PR_MEDIA: "var(--dept-strategy)",
  EVENTS: "var(--dept-strategy)",
  OFFLINE_MEDIA: "var(--dept-strategy)",

  MARKET_INTELLIGENCE: "var(--dept-intel)",
  CUSTOMER_INTELLIGENCE: "var(--dept-intel)",
  COMPETITOR_INTELLIGENCE: "var(--dept-intel)",

  CREATIVE: "var(--dept-creative)",
  ART_DIRECTION: "var(--dept-creative)",
  COPY_CONTENT: "var(--dept-creative)",
  SOCIAL_MEDIA: "var(--dept-creative)",
  INFLUENCER_CREATOR: "var(--dept-creative)",

  SEO: "var(--dept-growth)",
  PERFORMANCE_MARKETING: "var(--dept-growth)",
  DATA_ANALYTICS: "var(--dept-growth)",
  GROWTH: "var(--dept-growth)",
  CRM_LIFECYCLE: "var(--dept-growth)",
  WEB_PRODUCT: "var(--dept-growth)",
};

export const DEPARTMENT_MODE: EnumMap<DepartmentMode> = {
  OFF: { label: "Off", tone: "neutral" },
  LISTEN: { label: "Listen", tone: "neutral" },
  SUGGEST: { label: "Suggest", tone: "active" },
  PREPARE: { label: "Prepare", tone: "waiting" },
  EXECUTE: { label: "Execute", tone: "positive" },
};

export const DEPARTMENT_MODE_HINT: Record<DepartmentMode, string> = {
  OFF: "Never runs",
  LISTEN: "Only collects signals",
  SUGGEST: "Collects signals, suggests opportunities and ideas",
  PREPARE: "Prepares the work, waits for approval",
  EXECUTE: "Completes the work to the extent policy allows",
};

export const WORK_PLAN_TYPE: EnumMap<WorkPlanType> = {
  SINGLE_TASK: { label: "Single Task", tone: "neutral" },
  EXPERIMENT: { label: "Experiment", tone: "active" },
  CAMPAIGN: { label: "Campaign", tone: "positive" },
  MULTI_DEPARTMENT: { label: "Multi-Department", tone: "positive" },
};

export const WORK_PLAN_STATUS: EnumMap<WorkPlanStatus> = {
  DRAFT: { label: "Draft", tone: "neutral" },
  AWAITING_APPROVAL: { label: "Awaiting Approval", tone: "waiting" },
  APPROVED: { label: "Approved", tone: "positive" },
  IN_PROGRESS: { label: "In Progress", tone: "active" },
  COMPLETED: { label: "Completed", tone: "positive" },
  CANCELLED: { label: "Cancelled", tone: "neutral" },
  FAILED: { label: "Failed", tone: "danger" },
};

// Tasks → Plans kanban columns — the plan-lifecycle counterpart of
// TASK_BOARD_COLUMNS (core.ts).
export const WORK_PLAN_BOARD_COLUMNS: Array<{
  key: string;
  label: string;
  statuses: WorkPlanStatus[];
}> = [
  {
    key: "preparing",
    label: "Preparing",
    statuses: ["DRAFT", "AWAITING_APPROVAL"],
  },
  { key: "approved", label: "Approved", statuses: ["APPROVED"] },
  { key: "in-progress", label: "In Progress", statuses: ["IN_PROGRESS"] },
  { key: "completed", label: "Completed", statuses: ["COMPLETED"] },
  { key: "issues", label: "Issues", statuses: ["CANCELLED", "FAILED"] },
];

export const WORK_HANDOFF_STATUS: EnumMap<WorkHandoffStatus> = {
  PROPOSED: { label: "Proposed", tone: "waiting" },
  ACCEPTED: { label: "Accepted", tone: "active" },
  TASK_CREATED: { label: "Task Created", tone: "active" },
  COMPLETED: { label: "Completed", tone: "positive" },
  REJECTED: { label: "Rejected", tone: "danger" },
  EXPIRED: { label: "Expired", tone: "neutral" },
};

// Tasks → Handoffs kanban columns.
export const WORK_HANDOFF_BOARD_COLUMNS: Array<{
  key: string;
  label: string;
  statuses: WorkHandoffStatus[];
}> = [
  { key: "proposed", label: "Proposed", statuses: ["PROPOSED"] },
  { key: "accepted", label: "Accepted", statuses: ["ACCEPTED"] },
  { key: "task-created", label: "Task Created", statuses: ["TASK_CREATED"] },
  { key: "completed", label: "Completed", statuses: ["COMPLETED"] },
  { key: "issues", label: "Issues", statuses: ["REJECTED", "EXPIRED"] },
];

export const PROJECT_GOAL_STATUS: EnumMap<ProjectGoalStatus> = {
  PROPOSED: { label: "Proposed", tone: "waiting" },
  APPROVED: { label: "Approved", tone: "positive" },
  ACTIVE: { label: "Active", tone: "positive" },
  PAUSED: { label: "Paused", tone: "neutral" },
  ACHIEVED: { label: "Achieved", tone: "special" },
  REJECTED: { label: "Rejected", tone: "danger" },
  ARCHIVED: { label: "Archived", tone: "neutral" },
};

export const MEASUREMENT_PLAN_STATUS: EnumMap<MeasurementPlanStatus> = {
  ACTIVE: { label: "Active", tone: "active" },
  COMPLETED: { label: "Completed", tone: "positive" },
  CANCELLED: { label: "Cancelled", tone: "neutral" },
};

// Tasks → Measurements kanban columns — only 3 statuses, the smallest
// instance of the same system as the other Tasks boards.
export const MEASUREMENT_PLAN_BOARD_COLUMNS: Array<{
  key: string;
  label: string;
  statuses: MeasurementPlanStatus[];
}> = [
  { key: "active", label: "Active", statuses: ["ACTIVE"] },
  { key: "completed", label: "Completed", statuses: ["COMPLETED"] },
  { key: "cancelled", label: "Cancelled", statuses: ["CANCELLED"] },
];

export const MEASUREMENT_CHECK_STATUS: EnumMap<MeasurementCheckStatus> = {
  PENDING: { label: "Pending", tone: "neutral" },
  SCHEDULED: { label: "Scheduled", tone: "waiting" },
  RUNNING: { label: "Running", tone: "active" },
  COMPLETED: { label: "Completed", tone: "positive" },
  FAILED: { label: "Failed", tone: "danger" },
  SKIPPED: { label: "Skipped", tone: "neutral" },
};

export const AGENCY_LOOP_STATUS: EnumMap<AgencyLoopStatus> = {
  RUNNING: { label: "Running", tone: "active" },
  WAITING: { label: "Waiting", tone: "waiting" },
  BLOCKED: { label: "Blocked", tone: "danger" },
  PAUSED: { label: "Paused", tone: "neutral" },
  ERROR: { label: "Error", tone: "danger" },
};

// Agency-internal housekeeping capabilities (SIGNAL_SCAN's own scans,
// MEASUREMENT_CHECK's result polling, VERIFY_EXTERNAL_ACTION's outcome
// checks — see department-registry.ts) — excluded by default from the Work
// panel's task board and from the Agency Status widget's tasksNow/
// tasksWaiting counts, so both read as "client-facing work in flight"
// instead of being dominated by the loop's own bookkeeping.
export const INTERNAL_CAPABILITIES: ReadonlySet<CapabilityKey> = new Set([
  "SIGNAL_SCAN",
  "MEASUREMENT_CHECK",
  "VERIFY_EXTERNAL_ACTION",
]);

export const AGENCY_TRIGGER_TYPE: EnumMap<AgencyTriggerType> = {
  SCHEDULE: { label: "Schedule", tone: "neutral" },
  USER_COMMAND: { label: "User Command", tone: "active" },
  NEW_SIGNAL: { label: "New Signal", tone: "active" },
  NEW_EVIDENCE: { label: "New Evidence", tone: "active" },
  COMPETITOR_CHANGE: { label: "Competitor Change", tone: "active" },
  SEO_CHANGE: { label: "SEO Change", tone: "active" },
  MARKET_CHANGE: { label: "Market Change", tone: "active" },
  MEDIA_CHANGE: { label: "Media Change", tone: "active" },
  TREND_CHANGE: { label: "Trend Change", tone: "active" },
  PERFORMANCE_CHANGE: { label: "Performance Change", tone: "active" },
  TASK_COMPLETED: { label: "Task Completed", tone: "positive" },
  TASK_FAILED: { label: "Task Failed", tone: "danger" },
  TASK_CANCELLED: { label: "Task Cancelled", tone: "neutral" },
  CAMPAIGN_COMPLETED: { label: "Campaign Completed", tone: "positive" },
  FOLLOW_UP_DUE: { label: "Follow-up Due", tone: "waiting" },
  PROJECT_GOAL_CHANGED: { label: "Goal Changed", tone: "active" },
};

export const AGENCY_TRIGGER_STATUS: EnumMap<AgencyTriggerStatus> = {
  PENDING: { label: "Pending", tone: "neutral" },
  PROCESSING: { label: "Processing", tone: "active" },
  PROCESSED: { label: "Processed", tone: "positive" },
  FAILED: { label: "Failed", tone: "danger" },
  SKIPPED: { label: "Skipped", tone: "neutral" },
};

// Shows a readable platform name (instead of "INSTAGRAM_PUBLISH") on the
// "publish-result" card — used by both execution-service.ts AND
// task.repository.ts (kept here, in a neutral file, so there's no circular
// import between them).
export const PLATFORM_LABEL: Partial<Record<CapabilityKey, string>> = {
  INSTAGRAM_PUBLISH: "Instagram",
  TIKTOK_PUBLISH: "TikTok",
  LINKEDIN_PUBLISH: "LinkedIn",
  X_PUBLISH: "X",
};
