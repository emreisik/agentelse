import {
  Swords,
  Rocket,
  Cpu,
  Search,
  TrendingUp,
  Megaphone,
  Newspaper,
  Users,
  Handshake,
  CalendarDays,
  Radio,
  HeartHandshake,
  Globe2,
  Palette,
  Gauge,
  CircleDot,
} from "lucide-react";
import type {
  BrandConstitutionStatus,
  FactClassification,
  FindingSourceType,
  InsightStatus,
  OpportunityStatus,
  SetupStage,
  SetupStageStatus,
  SignalCategory,
  SignalIntensity,
  SignalStatus,
} from "@prisma/client";

import type { EnumMap } from "./types";

// Mirrors SETUP_STAGE_ORDER in setup-state.repository.ts as a pure UI
// constant (labels layer must not import server-only modules).
export const SETUP_STAGE_ORDER_UI: SetupStage[] = [
  "INTAKE",
  "DEEP_DISCOVERY",
  "BRAND_CONSTITUTION",
  "SIGNAL_PROFILE",
  "BASELINE_AUDITS",
  "GOAL_GENERATION",
  "AGENCY_CONFIGURATION",
  "AUTONOMY_CONFIGURATION",
  "INITIAL_OPPORTUNITIES",
  "INITIAL_IDEA_PORTFOLIO",
  "INITIAL_WORK_PLAN",
  "PROJECT_ACTIVATION",
];

export const SETUP_STAGE: EnumMap<SetupStage> = {
  INTAKE: { label: "Intake", tone: "neutral" },
  DEEP_DISCOVERY: { label: "Deep Discovery", tone: "active" },
  BRAND_CONSTITUTION: { label: "Brand Constitution", tone: "active" },
  SIGNAL_PROFILE: { label: "Signal Profile", tone: "active" },
  BASELINE_AUDITS: { label: "Baseline Audits", tone: "active" },
  GOAL_GENERATION: { label: "Goal Generation", tone: "active" },
  AGENCY_CONFIGURATION: { label: "Agency Configuration", tone: "active" },
  AUTONOMY_CONFIGURATION: { label: "Autonomy Configuration", tone: "active" },
  INITIAL_OPPORTUNITIES: { label: "Initial Opportunities", tone: "active" },
  INITIAL_IDEA_PORTFOLIO: { label: "Initial Idea Portfolio", tone: "active" },
  INITIAL_WORK_PLAN: { label: "Initial Work Plan", tone: "active" },
  PROJECT_ACTIVATION: { label: "Project Activation", tone: "positive" },
};

// Short explainer per stage, shown under the stepper labels.
export const SETUP_STAGE_HINTS: Record<SetupStage, string> = {
  INTAKE: "Brand information is collected and the infrastructure is prepared",
  DEEP_DISCOVERY: "6 parallel research tasks examine the brand in depth",
  BRAND_CONSTITUTION:
    "A versioned brand constitution is synthesized from the findings",
  SIGNAL_PROFILE: "Monitoring intensity is set for 16 signal categories",
  BASELINE_AUDITS: "A current-state audit is run for every department",
  GOAL_GENERATION: "Project goals are proposed based on the research",
  AGENCY_CONFIGURATION: "The operating mode is configured for 19 departments",
  AUTONOMY_CONFIGURATION: "Daily limits and the autonomy policy are set",
  INITIAL_OPPORTUNITIES: "Initial insights are converted into opportunities",
  INITIAL_IDEA_PORTFOLIO: "Multi-lens ideas are generated from opportunities",
  INITIAL_WORK_PLAN: "Approved ideas are converted into work plans",
  PROJECT_ACTIVATION: "The project goes active and the continuous loop begins",
};

export const SETUP_STAGE_STATUS: EnumMap<SetupStageStatus> = {
  PENDING: { label: "Pending", tone: "neutral" },
  RUNNING: { label: "Running", tone: "active" },
  WAITING_CLIENT: { label: "Awaiting Your Decision", tone: "waiting" },
  COMPLETED: { label: "Completed", tone: "positive" },
  FAILED: { label: "Failed", tone: "danger" },
  SKIPPED: { label: "Skipped", tone: "neutral" },
};

export const SIGNAL_CATEGORY: EnumMap<SignalCategory> = {
  COMPETITOR: { label: "Competitor", tone: "active", icon: Swords },
  PRODUCT_LAUNCH: { label: "Product Launch", tone: "active", icon: Rocket },
  TECHNOLOGY: { label: "Technology", tone: "active", icon: Cpu },
  SEO: { label: "SEO", tone: "active", icon: Search },
  SOCIAL_TREND: { label: "Social Trend", tone: "active", icon: TrendingUp },
  PAID_ADVERTISING: {
    label: "Paid Advertising",
    tone: "active",
    icon: Megaphone,
  },
  MEDIA: { label: "Media", tone: "active", icon: Newspaper },
  CREATOR: { label: "Creator", tone: "active", icon: Users },
  PARTNERSHIP: { label: "Partnership", tone: "active", icon: Handshake },
  EVENT: { label: "Event", tone: "active", icon: CalendarDays },
  OFFLINE: { label: "Traditional", tone: "neutral", icon: Radio },
  CUSTOMER: { label: "Customer", tone: "active", icon: HeartHandshake },
  MARKET: { label: "Market", tone: "active", icon: Globe2 },
  CULTURE: { label: "Culture", tone: "active", icon: Palette },
  PERFORMANCE: { label: "Performance", tone: "active", icon: Gauge },
  OTHER: { label: "Other", tone: "neutral", icon: CircleDot },
};

export const SIGNAL_INTENSITY: EnumMap<SignalIntensity> = {
  VERY_HIGH: { label: "Very High", tone: "danger" },
  HIGH: { label: "High", tone: "waiting" },
  MEDIUM: { label: "Medium", tone: "active" },
  LOW: { label: "Low", tone: "neutral" },
  OFF: { label: "Off", tone: "neutral" },
};

export const SIGNAL_INTENSITY_HINT: Record<SignalIntensity, string> = {
  VERY_HIGH: "Scans every 4 hours",
  HIGH: "Scans every 12 hours",
  MEDIUM: "Scans every 24 hours",
  LOW: "Scans every 72 hours",
  OFF: "No scanning",
};

export const SIGNAL_STATUS: EnumMap<SignalStatus> = {
  NEW: { label: "New", tone: "neutral" },
  SCORED: { label: "Scored", tone: "active" },
  PROMOTED: { label: "Promoted", tone: "positive" },
  DISCARDED: { label: "Discarded", tone: "neutral" },
  DUPLICATE: { label: "Duplicate", tone: "special" },
};

export const FACT_CLASSIFICATION: EnumMap<FactClassification> = {
  VERIFIED_FACT: { label: "Verified Fact", tone: "positive" },
  LIKELY_FACT: { label: "Likely Fact", tone: "active" },
  ASSUMPTION: { label: "Assumption", tone: "waiting" },
  CONTRADICTION: { label: "Contradiction", tone: "danger" },
  UNKNOWN: { label: "Unknown", tone: "neutral" },
  RECOMMENDATION: { label: "Recommendation", tone: "special" },
};

export const FINDING_SOURCE_TYPE: EnumMap<FindingSourceType> = {
  RESEARCH_TASK: { label: "Research Task", tone: "active" },
  SIGNAL: { label: "Signal", tone: "active" },
  AUDIT: { label: "Audit", tone: "neutral" },
  CLIENT_INPUT: { label: "Client Input", tone: "special" },
  LEARNING: { label: "Learning", tone: "positive" },
};

export const INSIGHT_STATUS: EnumMap<InsightStatus> = {
  NEW: { label: "New", tone: "neutral" },
  EVALUATED: { label: "Evaluated", tone: "active" },
  PROMOTED: { label: "Promoted to Opportunity", tone: "positive" },
  ARCHIVED: { label: "Archived", tone: "neutral" },
};

export const OPPORTUNITY_STATUS: EnumMap<OpportunityStatus> = {
  NEW: { label: "New", tone: "neutral" },
  REVIEWING: { label: "Reviewing", tone: "active" },
  EVALUATED: { label: "Evaluated", tone: "active" },
  ACCEPTED: { label: "Accepted", tone: "positive" },
  DISMISSED: { label: "Dismissed", tone: "neutral" },
  CONVERTED_TO_TASK: { label: "Converted to Task", tone: "special" },
  CONVERTED_TO_IDEA: { label: "Converted to Idea", tone: "special" },
  EXPIRED: { label: "Expired", tone: "neutral" },
  DUPLICATE: { label: "Duplicate", tone: "special" },
};

export const CONSTITUTION_STATUS: EnumMap<BrandConstitutionStatus> = {
  DRAFT: { label: "Draft", tone: "neutral" },
  ACTIVE: { label: "Active", tone: "positive" },
  SUPERSEDED: { label: "Superseded", tone: "neutral" },
};

// The 22 BrandConstitution payload sections, in display order.
export const CONSTITUTION_SECTIONS: Array<{ key: string; label: string }> = [
  { key: "identity", label: "Identity" },
  { key: "businessModel", label: "Business Model" },
  { key: "products", label: "Products" },
  { key: "markets", label: "Markets" },
  { key: "audiences", label: "Target Audiences" },
  { key: "positioning", label: "Positioning" },
  { key: "valueProposition", label: "Value Proposition" },
  { key: "personality", label: "Brand Personality" },
  { key: "toneOfVoice", label: "Tone of Voice" },
  { key: "visualIdentity", label: "Visual Identity" },
  { key: "logoAssetIds", label: "Logo Assets" },
  { key: "approvedClaims", label: "Approved Claims" },
  { key: "forbiddenClaims", label: "Forbidden Claims" },
  { key: "negativeBrief", label: "Negative Brief" },
  { key: "customerProblems", label: "Customer Problems" },
  { key: "customerObjections", label: "Customer Objections" },
  { key: "competitors", label: "Competitors" },
  { key: "differentiators", label: "Differentiators" },
  { key: "legalRestrictions", label: "Legal Restrictions" },
  { key: "knownFacts", label: "Known Facts" },
  { key: "assumptions", label: "Assumptions" },
  { key: "openQuestions", label: "Open Questions" },
];
