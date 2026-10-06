import type { GaInsightsMode } from "./flags";
import type {
  GaFindingConfidence,
  GaFindingEvidence,
  GaFindingKind,
  GaFindingMode,
  GaFindingOutcome,
  GaFindingSeverity,
  GaFindingStatus,
  GaImpact,
  GaPeriod,
  GaReviewVerdict,
  GaRuleKey,
} from "./types";

// GA-F4 görünüm tipleri (docs/google-analytics-plan.md §3.9; ayrıntı
// docs/website-insights.md "Yüzeyler"): sunucu okuyucusunun (read.ts)
// Website sayfasına, /health kartına ve sohbet araçlarına verdiği düz
// nesneler. Tarihler ISO metnidir; yalnız tip.

export type GaFindingView = {
  id: string;
  ruleKey: GaRuleKey;
  kind: GaFindingKind;
  subject: string;
  subjectLabel: string;
  period: GaPeriod;
  severity: GaFindingSeverity;
  confidence: GaFindingConfidence;
  status: GaFindingStatus;
  mode: GaFindingMode;
  priority: number;
  evidence: GaFindingEvidence;
  impact: GaImpact | null;
  explanation: string | null;
  occurrences: number;
  evaluable: boolean;
  preliminary: boolean;
  createdAt: string;
  acceptedAt: string | null;
  doneAt: string | null;
  evaluateAfter: string | null;
  evaluatedAt: string | null;
  outcome: GaFindingOutcome | null;
  reviewVerdict: GaReviewVerdict | null;
};

export type WebsiteInsightsView = {
  review: boolean;
  timeZone: string;
  currency: string | null;
  // ≤6
  changed: GaFindingView[];
  // ≤6
  opportunities: GaFindingView[];
  // ≤5
  inProgress: GaFindingView[];
};

export type GaInsightsOperatorView = {
  mode: GaInsightsMode;
  counters: {
    openShadow: number;
    openLive: number;
    createdLast7d: number;
    // Bakanın üye olduğu projelerdeki açık bulgular.
    reviewable: number;
    reviewed: number;
    useful: number;
    notUseful: number;
    precision: number | null;
    linksAnalyzed: number;
    linksDue: number;
    lastRunMinutesAgo: number | null;
    byRule: { ruleKey: GaRuleKey; open: number }[];
  };
  // ≤30, yalnız bakanın WorkspaceMember olduğu projelerden.
  recent: {
    id: string;
    projectId: string;
    projectName: string;
    ruleKey: GaRuleKey;
    kind: GaFindingKind;
    confidence: GaFindingConfidence;
    mode: GaFindingMode;
    createdAt: string;
    verdict: GaReviewVerdict | null;
  }[];
};
