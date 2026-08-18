import {
  Sparkles,
  Globe2,
  Newspaper,
  Share2,
  Package,
  TrendingUp,
  Handshake,
  Users,
  Megaphone,
  MessagesSquare,
  Cpu,
  Ticket,
  Radio,
  FileText,
  Wrench,
  BarChart3,
} from "lucide-react";
import type {
  AgencyDecisionSubject,
  AgencyDecisionType,
  CouncilRecommendation,
  CouncilType,
  CreativeLens,
  IdeaStatus,
} from "@prisma/client";

import type { EnumMap } from "./types";

export const IDEA_STATUS: EnumMap<IdeaStatus> = {
  RAW: { label: "Raw", tone: "neutral" },
  RESEARCHING: { label: "Researching", tone: "active" },
  VALIDATED: { label: "Validated", tone: "active" },
  CONCEPT: { label: "Concept", tone: "active" },
  SHORTLISTED: { label: "Shortlisted", tone: "waiting" },
  APPROVED: { label: "Approved", tone: "positive" },
  PLANNING: { label: "Planning", tone: "active" },
  ACTIVE: { label: "In Progress", tone: "active" },
  MEASURING: { label: "Measuring", tone: "active" },
  LEARNED: { label: "Learned", tone: "special" },
  ARCHIVED: { label: "Archived", tone: "neutral" },
  REJECTED: { label: "Rejected", tone: "danger" },
};

// Kanban column grouping for the idea lifecycle board.
export const IDEA_BOARD_COLUMNS: Array<{
  key: string;
  label: string;
  statuses: IdeaStatus[];
}> = [
  {
    key: "discovery",
    label: "Discovery",
    statuses: ["RAW", "RESEARCHING", "VALIDATED"],
  },
  { key: "concept", label: "Concept", statuses: ["CONCEPT", "SHORTLISTED"] },
  { key: "approved", label: "Approved", statuses: ["APPROVED", "PLANNING"] },
  {
    key: "in-progress",
    label: "In Progress",
    statuses: ["ACTIVE", "MEASURING"],
  },
  {
    key: "outcome",
    label: "Outcome",
    statuses: ["LEARNED", "ARCHIVED", "REJECTED"],
  },
];

export const CREATIVE_LENS: EnumMap<CreativeLens> = {
  BRAND: { label: "Brand", tone: "active", icon: Sparkles },
  CULTURE: { label: "Culture", tone: "active", icon: Globe2 },
  PR: { label: "PR", tone: "active", icon: Newspaper },
  SOCIAL: { label: "Social", tone: "active", icon: Share2 },
  PRODUCT: { label: "Product", tone: "active", icon: Package },
  GROWTH: { label: "Growth", tone: "active", icon: TrendingUp },
  PARTNERSHIP: { label: "Partnership", tone: "active", icon: Handshake },
  CREATOR: { label: "Creator", tone: "active", icon: Users },
  MEDIA: { label: "Media", tone: "active", icon: Megaphone },
  COMMUNITY: { label: "Community", tone: "active", icon: MessagesSquare },
  TECHNOLOGY: { label: "Technology", tone: "active", icon: Cpu },
  EXPERIENCE: { label: "Experience", tone: "active", icon: Ticket },
  OFFLINE: { label: "Traditional", tone: "neutral", icon: Radio },
  CONTENT: { label: "Content", tone: "active", icon: FileText },
  UTILITY: { label: "Utility", tone: "active", icon: Wrench },
  DATA: { label: "Data", tone: "active", icon: BarChart3 },
};

export const COUNCIL_TYPE: EnumMap<CouncilType> = {
  STRATEGY: { label: "Strategy Council", tone: "active" },
  CREATIVE: { label: "Creative Council", tone: "active" },
  GROWTH: { label: "Growth Council", tone: "active" },
  MEDIA: { label: "Media Council", tone: "active" },
  RISK: { label: "Risk Council", tone: "danger" },
};

export const COUNCIL_RECOMMENDATION: EnumMap<CouncilRecommendation> = {
  STRONG_APPROVE: { label: "Strong Approve", tone: "positive" },
  APPROVE: { label: "Approve", tone: "positive" },
  REVISE: { label: "Revise", tone: "waiting" },
  REJECT: { label: "Reject", tone: "danger" },
};

const COUNCIL_DIMENSION_LABELS: Record<string, string> = {
  originality: "Originality",
  brandFit: "Brand Fit",
  culturalFit: "Cultural Fit",
  potentialImpact: "Potential Impact",
  shareability: "Shareability",
  mediaPotential: "Media Potential",
  feasibility: "Feasibility",
  evidence: "Evidence",
  risk: "Risk",
  goalAlignment: "Goal Alignment",
  positioningFit: "Positioning Fit",
  differentiation: "Differentiation",
  expectedImpact: "Expected Impact",
  measurability: "Measurability",
  costEfficiency: "Cost Efficiency",
  speedToLearn: "Speed to Learn",
  newsworthiness: "Newsworthiness",
  channelFit: "Channel Fit",
  audienceReach: "Audience Reach",
  timing: "Timing",
  brandSafety: "Brand Safety",
  legalExposure: "Legal Exposure",
  reputationRisk: "Reputation Risk",
  operationalRisk: "Operational Risk",
  reversibility: "Reversibility",
};

export function councilDimensionLabel(key: string): string {
  return (
    COUNCIL_DIMENSION_LABELS[key] ??
    key.replace(/([A-Z])/g, " $1").toLowerCase()
  );
}

export const AGENCY_DECISION_TYPE: EnumMap<AgencyDecisionType> = {
  REJECT: { label: "Reject", tone: "danger" },
  BACKLOG: { label: "Backlog", tone: "neutral" },
  RESEARCH_MORE: { label: "Research More", tone: "active" },
  CREATE_EXPERIMENT: { label: "Create Experiment", tone: "active" },
  CREATE_CAMPAIGN: { label: "Create Campaign", tone: "positive" },
  CREATE_TASK: { label: "Create Task", tone: "positive" },
  CREATE_MULTI_DEPARTMENT_PLAN: {
    label: "Multi-Department Plan",
    tone: "positive",
  },
};

export const AGENCY_DECISION_SUBJECT: EnumMap<AgencyDecisionSubject> = {
  OPPORTUNITY: { label: "Opportunity", tone: "active" },
  IDEA: { label: "Idea", tone: "active" },
  HANDOFF: { label: "Handoff", tone: "active" },
  TRIGGER: { label: "Trigger", tone: "neutral" },
};
