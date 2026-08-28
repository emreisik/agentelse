import type {
  ActorType,
  ApprovalLevel,
  CapabilityKey,
  RiskLevel,
} from "@prisma/client";

import { ExecutionPolicy } from "./execution-policy";

// Approval-level policy (spec section 28). Pure and unit-testable — no DB, no
// server-only import, mirroring execution-policy.ts.
//
// The legacy ExecutionPolicy.requiresApproval() capability set is the
// immutable LEVEL_3 floor: everything that blocked on a human before still
// blocks on a human, regardless of what this layer computes. New levels only
// ADD granularity below/above that floor, never weaken it.

// LEVEL_4: budget/financial/contract-adjacent writes. META_AD_CREATE and
// META_AD_UPDATE are deliberately absent — an Ad carries a creative + name,
// not a budget (that lives on the Campaign/AdSet); both land on
// LEVEL_3_CLIENT via the ExecutionPolicy.requiresApproval() floor below.
const LEVEL_4_CAPABILITIES: ReadonlySet<CapabilityKey> = new Set<CapabilityKey>(
  [
    "META_CAMPAIGN_CREATE",
    "META_CAMPAIGN_UPDATE",
    "META_ADSET_CREATE",
    "META_ADSET_UPDATE",
    "GOOGLE_ADS_CAMPAIGN_CREATE",
  ],
);

export type ApprovalLevelContext = {
  createdByType: ActorType;
  riskLevel?: RiskLevel;
  // Per-project overrides from AutonomyPolicy.approvalOverrides, shape:
  // { [capability]: ApprovalLevel } — may only RAISE a level, never lower it.
  approvalOverrides?: Partial<Record<string, ApprovalLevel>> | null;
};

const LEVEL_ORDER: ApprovalLevel[] = [
  "LEVEL_0_AUTO_OBSERVE",
  "LEVEL_1_INTERNAL_AUTOMATIC",
  "LEVEL_2_AGENCY_DIRECTOR",
  "LEVEL_3_CLIENT",
  "LEVEL_4_CRITICAL",
];

export function levelRank(level: ApprovalLevel): number {
  return LEVEL_ORDER.indexOf(level);
}

export function maxLevel(a: ApprovalLevel, b: ApprovalLevel): ApprovalLevel {
  return levelRank(a) >= levelRank(b) ? a : b;
}

// A level at or below this executes without blocking on a human:
// L0 = observe-only work, L1 = internal automatic work,
// L2 = AgencyDirector's own (recorded) decision authority.
export function isAutoExecutable(level: ApprovalLevel): boolean {
  return levelRank(level) <= levelRank("LEVEL_2_AGENCY_DIRECTOR");
}

export const ApprovalPolicy = {
  resolveLevel(
    capability: CapabilityKey,
    context: ApprovalLevelContext,
  ): ApprovalLevel {
    let level: ApprovalLevel;

    if (LEVEL_4_CAPABILITIES.has(capability)) {
      level = "LEVEL_4_CRITICAL";
    } else if (ExecutionPolicy.requiresApproval(capability)) {
      // The legacy approval set is the L3 floor (publishes, account setup,
      // email send, website deploy, PR outreach).
      level = "LEVEL_3_CLIENT";
    } else if (context.riskLevel === "CRITICAL") {
      level = "LEVEL_4_CRITICAL";
    } else if (context.riskLevel === "HIGH") {
      level = "LEVEL_2_AGENCY_DIRECTOR";
    } else if (
      context.createdByType === "SYSTEM" ||
      context.createdByType === "AI"
    ) {
      // Autonomous work defaults to internal-automatic (recorded, no human).
      level = "LEVEL_1_INTERNAL_AUTOMATIC";
    } else {
      level = "LEVEL_0_AUTO_OBSERVE";
    }

    // Project overrides may only raise, never lower.
    const override = context.approvalOverrides?.[capability];
    if (override) level = maxLevel(level, override);

    return level;
  },
};
