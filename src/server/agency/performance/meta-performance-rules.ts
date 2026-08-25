import type { MetaInsightsRow } from "@/server/integrations/meta-client";

// Pure, deterministic rule engine — no server-only import, no DB, no
// network. Every threshold is ratio-based against the campaign's own
// dailyBudgetCents (not an absolute $ amount) so it works the same way
// regardless of the ad account's currency. Easy to unit test: fixed
// input -> fixed output.

export type FindingSeverity = "LOW" | "MEDIUM" | "HIGH";

export type SuggestedAction =
  | { type: "PAUSE" }
  | { type: "REDUCE_BUDGET"; proposedDailyBudgetCents: number };

export type PerformanceFinding = {
  rule:
    | "ZERO_RESULTS_SPEND"
    | "HIGH_CPA"
    | "LOW_CTR"
    | "AD_FATIGUE"
    | "CHRONIC_BUDGET_BURN";
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
  const dailyBudgetMajor = dailyBudgetCents / 100;
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

// AdSet-level reflection of rules 1/2 — informational only (Track 1), no
// suggestedAction: there is no META_ADSET_UPDATE capability yet (see plan's
// "Açık Noktalar"), so an adset finding can never become a Track 2
// proposal. Severity is downgraded one notch versus the campaign-level
// version — a single underperforming adset inside an otherwise-healthy
// campaign is a narrower signal.
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
  if (!finding || finding.suggestedAction === undefined) return finding;
  return {
    ...finding,
    severity: finding.severity === "HIGH" ? "MEDIUM" : finding.severity,
    suggestedAction: undefined,
  };
}
