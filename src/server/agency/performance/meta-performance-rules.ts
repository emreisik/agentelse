import { toMajorUnits } from "@/lib/ads/money";
import type { MetaInsightsRow } from "@/server/integrations/meta-client";

// Pure, deterministic rule engine — no server-only import, no DB, no
// network. Every threshold is ratio-based against the campaign's own
// dailyBudgetCents (not an absolute $ amount) so it works the same way
// regardless of the ad account's currency. Easy to unit test: fixed
// input -> fixed output.

export type FindingSeverity = "LOW" | "MEDIUM" | "HIGH";

export type SuggestedAction =
  | { type: "PAUSE" }
  | { type: "REDUCE_BUDGET"; proposedDailyBudgetCents: number }
  | { type: "SCALE_BUDGET"; proposedDailyBudgetCents: number };

export type PerformanceFinding = {
  rule:
    | "ZERO_RESULTS_SPEND"
    | "HIGH_CPA"
    | "LOW_CTR"
    | "AD_FATIGUE"
    | "CHRONIC_BUDGET_BURN"
    | "CPA_REGRESSION"
    | "SCALE_BUDGET";
  severity: FindingSeverity;
  // Human-readable, already carrying the concrete numbers — this is what
  // gets embedded into the Signal's title/summary text (see
  // meta-performance-scanner.ts), since the Insight/Opportunity/Idea chain
  // only reads title/summary, never Signal.payload.
  title: string;
  summary: string;
  suggestedAction?: SuggestedAction;
  // For the Approval card's detail rows (see approval-details.ts) and for
  // debugging — not read by the LLM chain.
  metricsSnapshot: Record<string, number | undefined>;
};

const ZERO_RESULTS_SPEND_MULTIPLIER = 3;
const HIGH_CPA_BUDGET_FRACTION = 0.5;
const LOW_CTR_THRESHOLD = 0.5;
const AD_FATIGUE_FREQUENCY_THRESHOLD = 4;
const AD_FATIGUE_CTR_THRESHOLD = 1.0;
const CHRONIC_BURN_FRACTION = 0.9;
const REDUCE_BUDGET_FACTOR = 0.7; // propose cutting budget by 30%
const SCALE_BUDGET_CPA_FRACTION = 0.2; // cost per result under 20% of budget = headroom
const SCALE_BUDGET_CTR_THRESHOLD = 1.0; // same floor AD_FATIGUE treats as healthy
const SCALE_BUDGET_MIN_RESULTS = 5; // enough volume to trust the signal
const SCALE_UP_FACTOR = 1.3; // propose raising budget by 30%

// Evaluates ONE campaign's last_7d insights against the rule table and
// returns its single most severe finding (a campaign rarely needs more
// than one action proposed at a time — HIGH beats MEDIUM beats LOW).
export function evaluateCampaignFinding(input: {
  campaignName: string;
  insights: MetaInsightsRow;
  dailyBudgetCents: number;
  currency: string;
}): PerformanceFinding | null {
  const { campaignName, insights, dailyBudgetCents, currency } = input;
  if (dailyBudgetCents <= 0) return null;
  // Minor unit -> ana birim, hesabın para birimi ofsetiyle (JPY/HUF'de
  // sabit /100 eşikleri 100 kat kaydırıyordu; docs/meta-ads-plan.md F0b).
  const dailyBudgetMajor = toMajorUnits(dailyBudgetCents, currency);
  const candidates: PerformanceFinding[] = [];

  const hasNoResults = !insights.resultCount || insights.resultCount <= 0;
  if (
    hasNoResults &&
    insights.spend >= dailyBudgetMajor * ZERO_RESULTS_SPEND_MULTIPLIER
  ) {
    candidates.push({
      rule: "ZERO_RESULTS_SPEND",
      severity: "HIGH",
      title: `${campaignName}: spend with no results`,
      summary: `"${campaignName}" spent ${insights.spend.toFixed(2)} ${currency} over the last 7 days with no tracked results (${ZERO_RESULTS_SPEND_MULTIPLIER}x its ${dailyBudgetMajor.toFixed(2)} ${currency} daily budget).`,
      suggestedAction: { type: "PAUSE" },
      metricsSnapshot: {
        spend: insights.spend,
        resultCount: insights.resultCount,
        dailyBudgetMajor,
      },
    });
  }

  if (
    insights.resultCount &&
    insights.resultCount > 0 &&
    insights.costPerResult !== undefined &&
    insights.costPerResult > dailyBudgetMajor * HIGH_CPA_BUDGET_FRACTION
  ) {
    const proposedDailyBudgetCents = Math.round(
      dailyBudgetCents * REDUCE_BUDGET_FACTOR,
    );
    candidates.push({
      rule: "HIGH_CPA",
      severity: "HIGH",
      title: `${campaignName}: high cost per result`,
      summary: `"${campaignName}"'s cost per ${insights.resultLabel ?? "result"} is ${insights.costPerResult.toFixed(2)} ${currency} — more than half its ${dailyBudgetMajor.toFixed(2)} ${currency} daily budget.`,
      suggestedAction: { type: "REDUCE_BUDGET", proposedDailyBudgetCents },
      metricsSnapshot: {
        costPerResult: insights.costPerResult,
        resultCount: insights.resultCount,
        dailyBudgetMajor,
      },
    });
  }

  // Mirror image of HIGH_CPA: strong, high-volume, non-fatigued performance
  // with plenty of budget headroom -> propose scaling instead of only ever
  // reacting to bad performance (PAUSE/REDUCE_BUDGET above). Thresholds are
  // deliberately disjoint from HIGH_CPA/LOW_CTR/AD_FATIGUE's ranges so a
  // campaign can never match both a "bad" and "good" rule in the same scan.
  if (
    insights.resultCount &&
    insights.resultCount >= SCALE_BUDGET_MIN_RESULTS &&
    insights.costPerResult !== undefined &&
    insights.costPerResult > 0 &&
    insights.costPerResult < dailyBudgetMajor * SCALE_BUDGET_CPA_FRACTION &&
    insights.ctr >= SCALE_BUDGET_CTR_THRESHOLD &&
    insights.frequency < AD_FATIGUE_FREQUENCY_THRESHOLD &&
    insights.spend >= dailyBudgetMajor * 5
  ) {
    const proposedDailyBudgetCents = Math.round(
      dailyBudgetCents * SCALE_UP_FACTOR,
    );
    candidates.push({
      rule: "SCALE_BUDGET",
      severity: "HIGH",
      title: `${campaignName}: strong performance, scale budget`,
      summary: `"${campaignName}"'s cost per ${insights.resultLabel ?? "result"} is ${insights.costPerResult.toFixed(2)} ${currency} — well under its ${dailyBudgetMajor.toFixed(2)} ${currency} daily budget, with healthy CTR (${insights.ctr.toFixed(2)}%) and no fatigue (${insights.frequency.toFixed(1)}x frequency). Proposing a budget increase to capture more volume.`,
      suggestedAction: { type: "SCALE_BUDGET", proposedDailyBudgetCents },
      metricsSnapshot: {
        costPerResult: insights.costPerResult,
        resultCount: insights.resultCount,
        ctr: insights.ctr,
        frequency: insights.frequency,
        dailyBudgetMajor,
      },
    });
  }

  if (insights.ctr < LOW_CTR_THRESHOLD && insights.spend >= dailyBudgetMajor) {
    candidates.push({
      rule: "LOW_CTR",
      severity: "MEDIUM",
      title: `${campaignName}: low click-through rate`,
      summary: `"${campaignName}"'s CTR is ${insights.ctr.toFixed(2)}% after spending ${insights.spend.toFixed(2)} ${currency} — creative or targeting may not be resonating.`,
      metricsSnapshot: { ctr: insights.ctr, spend: insights.spend },
    });
  }

  if (
    insights.frequency > AD_FATIGUE_FREQUENCY_THRESHOLD &&
    insights.ctr < AD_FATIGUE_CTR_THRESHOLD
  ) {
    candidates.push({
      rule: "AD_FATIGUE",
      severity: "MEDIUM",
      title: `${campaignName}: possible ad fatigue`,
      summary: `"${campaignName}" is showing the same audience an average of ${insights.frequency.toFixed(1)}x with CTR down to ${insights.ctr.toFixed(2)}% — a sign of creative fatigue.`,
      metricsSnapshot: { frequency: insights.frequency, ctr: insights.ctr },
    });
  }

  if (insights.spend >= dailyBudgetMajor * 7 * CHRONIC_BURN_FRACTION) {
    // Chronic version of "early budget burn": spend over the 7-day window
    // is consistently near (or over) 7x the daily budget — i.e. the
    // campaign is running at or above its intended pace day after day,
    // not a one-off. Computed from the same last_7d window as everything
    // else here, no extra "today" API call needed.
    candidates.push({
      rule: "CHRONIC_BUDGET_BURN",
      severity: "LOW",
      title: `${campaignName}: consistently spending at full pace`,
      summary: `"${campaignName}" has spent ${insights.spend.toFixed(2)} ${currency} over 7 days against a ${dailyBudgetMajor.toFixed(2)} ${currency}/day budget — running at or above full pace all week.`,
      metricsSnapshot: { spend: insights.spend, dailyBudgetMajor },
    });
  }

  if (candidates.length === 0) return null;

  const severityRank: Record<FindingSeverity, number> = {
    HIGH: 2,
    MEDIUM: 1,
    LOW: 0,
  };
  return candidates.reduce((best, c) =>
    severityRank[c.severity] > severityRank[best.severity] ? c : best,
  );
}

// AdSet-level reflection of rules 1/2 — same PAUSE/REDUCE_BUDGET rules as
// evaluateCampaignFinding, scoped to one adset. HIGH-severity findings keep
// their suggestedAction (META_ADSET_UPDATE exists — see
// performance-optimizer.ts's proposeAdSetAction), so they can become a
// Track 2 proposal like a campaign-level HIGH finding does. MEDIUM/LOW
// findings (low CTR, ad fatigue, chronic burn — no capability-backed action
// either way) stay informational-only, and their severity is downgraded one
// notch versus the campaign-level version: a single underperforming adset
// inside an otherwise-healthy campaign is a narrower signal.
export function evaluateAdSetFinding(input: {
  campaignName: string;
  adSetName: string;
  insights: MetaInsightsRow;
  dailyBudgetCents: number;
  currency: string;
}): PerformanceFinding | null {
  const finding = evaluateCampaignFinding({
    campaignName: `${input.campaignName} / ${input.adSetName}`,
    insights: input.insights,
    dailyBudgetCents: input.dailyBudgetCents,
    currency: input.currency,
  });
  if (!finding) return finding;
  if (finding.severity === "HIGH" && finding.suggestedAction) return finding;
  // MEDIUM/LOW findings never carry a suggestedAction to begin with (see
  // evaluateCampaignFinding above) — this branch only downgrades a stray
  // HIGH-without-action case, which can't currently occur but is handled
  // defensively; MEDIUM/LOW severities pass through unchanged.
  return {
    ...finding,
    severity: finding.severity === "HIGH" ? "MEDIUM" : finding.severity,
    suggestedAction: undefined,
  };
}

const CPA_REGRESSION_MULTIPLIER = 1.5; // +50% or more since the last scan

export type ScanSnapshot = {
  spend: number;
  costPerResult?: number;
  ctr: number;
  // Works only: what costPerResult counts (e.g. "Leads"), so a scan never
  // compares a cost per Leads with a cost per Link Clicks.
  resultLabel?: string;
};

// Simplified trend rule — compares the current scan against the ONE
// previous snapshot stored in IntegrationCredential.metadata
// (previousScanSnapshot, see meta-client.ts), not a real time series. Only
// fires when both scans have a costPerResult to compare (an entity with no
// tracked results has nothing to regress) and the previous scan had
// meaningful spend (avoids a noisy 10x "regression" off a near-zero base).
// Informational only (Track 1) — no suggestedAction, since a single
// cost-per-result jump isn't enough signal on its own to justify an
// automatic budget action the way the absolute thresholds above are.
export function evaluateTrendFinding(input: {
  entityName: string;
  current: ScanSnapshot;
  previous: ScanSnapshot | undefined;
}): PerformanceFinding | null {
  const { entityName, current, previous } = input;
  if (
    !previous ||
    previous.costPerResult === undefined ||
    current.costPerResult === undefined ||
    previous.spend < 1 ||
    previous.costPerResult <= 0
  ) {
    return null;
  }
  if (
    current.costPerResult <
    previous.costPerResult * CPA_REGRESSION_MULTIPLIER
  ) {
    return null;
  }
  const pctChange = Math.round(
    (current.costPerResult / previous.costPerResult - 1) * 100,
  );
  return {
    rule: "CPA_REGRESSION",
    severity: "MEDIUM",
    title: `${entityName}: cost per result rising`,
    summary: `"${entityName}"'s cost per result went from ${previous.costPerResult.toFixed(2)} to ${current.costPerResult.toFixed(2)} since the last scan (+${pctChange}%).`,
    metricsSnapshot: {
      previousCostPerResult: previous.costPerResult,
      currentCostPerResult: current.costPerResult,
    },
  };
}
