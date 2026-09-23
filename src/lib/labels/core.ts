import type {
  ApprovalLevel,
  ApprovalStatus,
  ApprovalType,
  BrowserProfileStatus,
  CapabilityKey,
  CreativeStatus,
  ExecutionJobStatus,
  HumanInterventionStatus,
  HumanInterventionType,
  ProjectStatus,
  RiskLevel,
  SocialPlatform,
  TaskPriority,
  TaskStatus,
} from "@prisma/client";

import type { EnumMap } from "./types";

export const TASK_STATUS: EnumMap<TaskStatus> = {
  DRAFT: { label: "Draft", tone: "neutral" },
  READY: { label: "Ready", tone: "neutral" },
  QUEUED: { label: "Queued", tone: "waiting" },
  RUNNING: { label: "Running", tone: "active" },
  WAITING_INPUT: { label: "Waiting for Input", tone: "waiting" },
  WAITING_HUMAN: { label: "Waiting for Human", tone: "waiting" },
  WAITING_APPROVAL: { label: "Waiting for Approval", tone: "waiting" },
  WAITING_PROVIDER: { label: "Waiting for Provider", tone: "waiting" },
  VERIFYING: { label: "Verifying", tone: "active" },
  COMPLETED: { label: "Completed", tone: "positive" },
  FAILED: { label: "Failed", tone: "danger" },
  BLOCKED: { label: "Blocked", tone: "danger" },
  CANCELLED: { label: "Cancelled", tone: "neutral" },
};

// Kanban column grouping for the Tasks board — the task-lifecycle
// counterpart of IDEA_BOARD_COLUMNS (ideas.ts). TaskStatus's 13 values are
// grouped into 5 columns to keep the same visual density as the Ideas
// board.
export const TASK_BOARD_COLUMNS: Array<{
  key: string;
  label: string;
  statuses: TaskStatus[];
}> = [
  {
    key: "preparing",
    label: "Preparing",
    statuses: ["DRAFT", "READY", "QUEUED"],
  },
  { key: "running", label: "Running", statuses: ["RUNNING", "VERIFYING"] },
  {
    key: "waiting",
    label: "Waiting",
    statuses: [
      "WAITING_INPUT",
      "WAITING_HUMAN",
      "WAITING_APPROVAL",
      "WAITING_PROVIDER",
    ],
  },
  { key: "completed", label: "Completed", statuses: ["COMPLETED"] },
  {
    key: "issues",
    label: "Issues",
    statuses: ["FAILED", "BLOCKED", "CANCELLED"],
  },
];

export const TASK_PRIORITY: EnumMap<TaskPriority> = {
  LOW: { label: "Low", tone: "neutral" },
  MEDIUM: { label: "Medium", tone: "neutral" },
  HIGH: { label: "High", tone: "waiting" },
  URGENT: { label: "Urgent", tone: "danger" },
};

export const RISK_LEVEL: EnumMap<RiskLevel> = {
  LOW: { label: "Low Risk", tone: "positive" },
  MEDIUM: { label: "Medium Risk", tone: "neutral" },
  HIGH: { label: "High Risk", tone: "waiting" },
  CRITICAL: { label: "Critical Risk", tone: "danger" },
};

export const PROJECT_STATUS: EnumMap<ProjectStatus> = {
  CREATED: { label: "Created", tone: "neutral" },
  DISCOVERY: { label: "Discovery", tone: "active" },
  NEEDS_INFORMATION: { label: "Needs Information", tone: "waiting" },
  PROFILE_REVIEW: { label: "Profile Review", tone: "waiting" },
  NEEDS_ASSESSMENT: { label: "Needs Assessment", tone: "waiting" },
  STRATEGY: { label: "Strategy", tone: "active" },
  ACTIVE: { label: "Active", tone: "positive" },
  PAUSED: { label: "Paused", tone: "neutral" },
  CLOSED: { label: "Closed", tone: "neutral" },
};

export const APPROVAL_STATUS: EnumMap<ApprovalStatus> = {
  PENDING: { label: "Pending", tone: "waiting" },
  APPROVED: { label: "Approved", tone: "positive" },
  REJECTED: { label: "Rejected", tone: "danger" },
  REVISION_REQUESTED: { label: "Revision Requested", tone: "waiting" },
  EXPIRED: { label: "Expired", tone: "neutral" },
  CANCELLED: { label: "Cancelled", tone: "neutral" },
};

export const APPROVAL_TYPE: EnumMap<ApprovalType> = {
  CREATIVE_APPROVAL: { label: "Creative Approval", tone: "active" },
  PUBLISH_APPROVAL: { label: "Publish Approval", tone: "waiting" },
  CAMPAIGN_APPROVAL: { label: "Campaign Approval", tone: "waiting" },
  ACCOUNT_ACTION_APPROVAL: {
    label: "Account Action Approval",
    tone: "waiting",
  },
  CRITICAL_CHANGE_APPROVAL: {
    label: "Critical Change Approval",
    tone: "danger",
  },
  GENERIC: { label: "General Approval", tone: "neutral" },
};

export const APPROVAL_LEVEL: EnumMap<ApprovalLevel> = {
  LEVEL_0_AUTO_OBSERVE: {
    label: "L0 · Automatic Observation",
    tone: "neutral",
  },
  LEVEL_1_INTERNAL_AUTOMATIC: {
    label: "L1 · Internal Automatic",
    tone: "neutral",
  },
  LEVEL_2_AGENCY_DIRECTOR: { label: "L2 · Agency Director", tone: "active" },
  LEVEL_3_CLIENT: { label: "L3 · Client Approval", tone: "waiting" },
  LEVEL_4_CRITICAL: { label: "L4 · Critical Approval", tone: "danger" },
};

export const HUMAN_INTERVENTION_TYPE: EnumMap<HumanInterventionType> = {
  OTP_REQUIRED: { label: "OTP Required", tone: "waiting" },
  MFA_REQUIRED: { label: "MFA Required", tone: "waiting" },
  LOGIN_REQUIRED: { label: "Login Required", tone: "waiting" },
  CAPTCHA_REQUIRED: { label: "CAPTCHA Required", tone: "waiting" },
  CONFIRMATION_REQUIRED: { label: "Confirmation Required", tone: "waiting" },
  MANUAL_BROWSER_REQUIRED: {
    label: "Manual Browser Required",
    tone: "waiting",
  },
  ACCOUNT_SELECTION_REQUIRED: {
    label: "Account Selection Required",
    tone: "waiting",
  },
  FILE_REQUIRED: { label: "File Required", tone: "waiting" },
  INFORMATION_REQUIRED: { label: "Information Required", tone: "waiting" },
  DECISION_REQUIRED: { label: "Decision Required", tone: "waiting" },
};

export const HUMAN_INTERVENTION_STATUS: EnumMap<HumanInterventionStatus> = {
  PENDING: { label: "Pending", tone: "waiting" },
  RESOLVED: { label: "Resolved", tone: "positive" },
  EXPIRED: { label: "Expired", tone: "neutral" },
  CANCELLED: { label: "Cancelled", tone: "neutral" },
};

// Connection health of a project's per-platform browser session — the
// layer CapabilityRouter actually dispatches publish/ads jobs through.
export const BROWSER_PROFILE_STATUS: EnumMap<BrowserProfileStatus> = {
  READY: { label: "Connected", tone: "positive" },
  RUNNING: { label: "Running", tone: "active" },
  WAITING: { label: "Waiting", tone: "waiting" },
  LOGIN_REQUIRED: { label: "Login Required", tone: "danger" },
  MFA_REQUIRED: { label: "MFA Required", tone: "danger" },
  OTP_REQUIRED: { label: "OTP Required", tone: "danger" },
  CAPTCHA_REQUIRED: { label: "CAPTCHA Required", tone: "danger" },
  SESSION_EXPIRED: { label: "Session Expired", tone: "danger" },
  USER_ACTION_REQUIRED: { label: "Action Required", tone: "danger" },
  PERMISSION_REQUIRED: { label: "Permission Required", tone: "danger" },
  UNHEALTHY: { label: "Unhealthy", tone: "danger" },
  DISABLED: { label: "Disabled", tone: "neutral" },
};

export const EXECUTION_JOB_STATUS: EnumMap<ExecutionJobStatus> = {
  QUEUED: { label: "Queued", tone: "waiting" },
  RUNNING: { label: "Running", tone: "active" },
  WAITING_HUMAN: { label: "Waiting for Human", tone: "waiting" },
  WAITING_PROVIDER: { label: "Waiting for Provider", tone: "waiting" },
  VERIFYING: { label: "Verifying", tone: "active" },
  COMPLETED: { label: "Completed", tone: "positive" },
  FAILED: { label: "Failed", tone: "danger" },
  CANCELLED: { label: "Cancelled", tone: "neutral" },
};

export const CREATIVE_STATUS: EnumMap<CreativeStatus> = {
  DRAFT: { label: "Draft", tone: "neutral" },
  IN_REVIEW: { label: "In Review", tone: "waiting" },
  APPROVED: { label: "Approved", tone: "positive" },
  REJECTED: { label: "Rejected", tone: "danger" },
  PUBLISHED: { label: "Published", tone: "positive" },
  ARCHIVED: { label: "Archived", tone: "neutral" },
};

// Identity badge, not a status — every platform gets the same neutral tone
// (see StatusBadge). No brand icons here on purpose: lucide-react ships no
// Instagram/LinkedIn/YouTube marks (removed for trademark reasons), and
// this codebase doesn't use brand logos anywhere else either.
export const SOCIAL_PLATFORM: EnumMap<SocialPlatform> = {
  INSTAGRAM: { label: "Instagram", tone: "neutral" },
  TIKTOK: { label: "TikTok", tone: "neutral" },
  LINKEDIN: { label: "LinkedIn", tone: "neutral" },
  X: { label: "X", tone: "neutral" },
  FACEBOOK: { label: "Facebook", tone: "neutral" },
  YOUTUBE: { label: "YouTube", tone: "neutral" },
  PINTEREST: { label: "Pinterest", tone: "neutral" },
};

// Hand-curated English labels for the most visible capabilities; anything
// unlisted falls back to a prettified form of the enum key.
const CAPABILITY_LABELS: Partial<Record<CapabilityKey, string>> = {
  BRAND_DISCOVERY: "Brand Discovery",
  WEB_RESEARCH: "Web Research",
  PRODUCT_RESEARCH: "Product Research",
  MARKET_RESEARCH: "Market Research",
  CUSTOMER_INTELLIGENCE: "Customer Intelligence",
  COMPETITOR_RESEARCH: "Competitor Research",
  COMPETITOR_MONITORING: "Competitor Monitoring",
  SEO_RESEARCH: "SEO Research",
  SEO_ANALYSIS: "SEO Analysis",
  SOCIAL_RESEARCH: "Social Media Research",
  MEDIA_RESEARCH: "Media Research",
  CULTURAL_RESEARCH: "Cultural Research",
  CREATOR_RESEARCH: "Creator Research",
  PARTNERSHIP_RESEARCH: "Partnership Research",
  ADVERTISING_RESEARCH: "Advertising Research",
  REVIEW_RESEARCH: "Review Research",
  TECHNOLOGY_RESEARCH: "Technology Research",
  SIGNAL_SCAN: "Signal Scan",
  MEASUREMENT_CHECK: "Measurement Check",
  CREATE_SOCIAL_CREATIVE: "Social Creative Production",
  CREATE_AD_CREATIVE: "Ad Creative Production",
  CREATE_COPY: "Copywriting",
  CREATE_CAPTION: "Caption Writing",
  CREATE_CAMPAIGN_BRIEF: "Campaign Brief",
  CREATE_CONTENT_PLAN: "Content Plan",
  INSTAGRAM_PUBLISH: "Instagram Publish",
  TIKTOK_PUBLISH: "TikTok Publish",
  LINKEDIN_PUBLISH: "LinkedIn Publish",
  X_PUBLISH: "X Publish",
  META_ADS_ANALYSIS: "Meta Ads Analysis",
  META_CAMPAIGN_CREATE: "Meta Campaign Creation",
  META_CAMPAIGN_UPDATE: "Meta Campaign Update",
  META_ADSET_CREATE: "Meta Ad Set Creation",
  META_AD_CREATE: "Meta Ad Creation",
  WEBSITE_UPDATE: "Website Update",
  PR_OUTREACH: "PR Outreach",
  ANALYTICS_ANALYSIS: "Analytics Analysis",
  REPORTING: "Reporting",
  VERIFY_EXTERNAL_ACTION: "External Action Verification",
  SOCIAL_ACCOUNT_SETUP: "Social Account Setup",
  ASO_ANALYSIS: "App Store (ASO) Analysis",
  BRAND_SAFETY: "Brand Safety Check",
  CLAIM_VALIDATION: "Claim Validation",
  COMPETITOR_CHANGE_DETECTION: "Competitor Change Detection",
  CRM_ANALYSIS: "CRM Analysis",
  DATA_EXTRACTION: "Data Extraction",
  EMAIL_DRAFT: "Email Draft",
  EMAIL_SEND: "Email Send",
  GOOGLE_ADS_ANALYSIS: "Google Ads Analysis",
  GOOGLE_ADS_CAMPAIGN_CREATE: "Google Ads Campaign Creation",
  SCREENSHOT_CAPTURE: "Screenshot Capture",
  SOCIAL_PROFILE_AUDIT: "Social Media Profile Audit",
  TREND_RESEARCH: "Trend Research",
  WEB_BROWSING: "Web Browsing",
};

export function capabilityLabel(key: CapabilityKey | string): string {
  const known = CAPABILITY_LABELS[key as CapabilityKey];
  if (known) return known;
  return key.replaceAll("_", " ").toLowerCase();
}

const CAPABILITY_PREFIX_RE = /^([A-Z][A-Z0-9]*(?:_[A-Z0-9]+)*):\s*/;

// Older task titles used to be generated with a raw capability-key prefix,
// e.g. "CREATE_CAMPAIGN_BRIEF: Trust's Cryptographic Seal..." (task-planner.ts
// no longer does this, but the prefix still lingers in historical records).
// Since the department badge already shows which team owns the work, this
// prefix is now redundant and hard to read — it's stripped by this function
// everywhere a task title is shown on cards/panels. Only prefixes that
// actually match a real CapabilityKey are stripped; arbitrary text like
// "TODO: ..." is left untouched.
export function stripCapabilityPrefix(title: string): string {
  const match = CAPABILITY_PREFIX_RE.exec(title);
  const prefix = match?.[1];
  if (!prefix || !(prefix in CAPABILITY_LABELS)) return title;
  return title.slice(match[0].length);
}
