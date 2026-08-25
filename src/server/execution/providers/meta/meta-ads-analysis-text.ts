import "server-only";

import type { WithInsights } from "@/server/integrations/meta-ads-query";
import type {
  MetaAdSetSummary,
  MetaCampaignSummary,
} from "@/server/integrations/meta-client";

// Deterministic, template-based narrative — not a second LLM call. This
// text lands in Task.rawResult.text, which src/lib/execution-result-text.ts
// already prioritizes when rendering a task result (Tasks panel, chat
// task-result card), so no other file needs to change for it to show up.
// A template was chosen over an LLM round-trip because META_ADS_ANALYSIS is
// LOW risk and dispatched synchronously (chat waits on it) — an extra
// reasoning call would add latency for no real gain here.
export function buildAdsAnalysisText(
  campaigns: WithInsights<MetaCampaignSummary>[],
  currency: string,
  datePresetLabel: string,
  // Only set when the caller asked about one specific campaign (see
  // analyzeAds()'s payload.campaignId) — appended as its own paragraph so
  // the adset drill-down actually reaches the user instead of being fetched
  // and then discarded.
  adSetDrilldown?: {
    campaignName: string;
    adSets: WithInsights<MetaAdSetSummary>[];
  },
): string {
  // Filtered by DELIVERY in the requested window, not by current
  // effective_status — a campaign paused right after the window (a normal
  // workflow, e.g. after a performance-driven pause proposal was approved)
  // still spent real money and produced real results inside that window,
  // and a report asking "how did last_30d go" must not silently drop it.
  const withDelivery = campaigns.filter((c) => (c.insights?.spend ?? 0) > 0);

  if (withDelivery.length === 0) {
    return campaigns.length === 0
      ? "No campaigns found."
      : `${campaigns.length} campaign(s), but none had any spend in the ${datePresetLabel} window.`;
  }

  const totalSpend = withDelivery.reduce(
    (sum, c) => sum + (c.insights?.spend ?? 0),
    0,
  );

  const ranked = [...withDelivery].sort((a, b) => {
    const aCpr = a.insights?.costPerResult;
    const bCpr = b.insights?.costPerResult;
    if (aCpr === undefined && bCpr === undefined) return 0;
    if (aCpr === undefined) return 1;
    if (bCpr === undefined) return -1;
    return aCpr - bCpr;
  });
  const best = ranked.find((c) => c.insights?.costPerResult !== undefined);

  const zeroResult = withDelivery.filter(
    (c) => !c.insights?.resultCount || c.insights.resultCount <= 0,
  );

  const lines: string[] = [
    `${datePresetLabel}: ${withDelivery.length} campaign(s) with spend, total ${totalSpend.toFixed(2)} ${currency}.`,
  ];
  if (best?.insights) {
    lines.push(
      `Best performer: "${best.name}" at ${best.insights.costPerResult!.toFixed(2)} ${currency} per ${best.insights.resultLabel ?? "result"}.`,
    );
  }
  if (zeroResult.length > 0) {
    const zeroSpend = zeroResult.reduce(
      (sum, c) => sum + (c.insights?.spend ?? 0),
      0,
    );
    const names = zeroResult
      .slice(0, 3)
      .map((c) => `"${c.name}"`)
      .join(", ");
    lines.push(
      `${zeroResult.length} campaign(s) spent ${zeroSpend.toFixed(2)} ${currency} with no tracked results: ${names}${zeroResult.length > 3 ? ", …" : ""}.`,
    );
  }

  if (adSetDrilldown) {
    const adSetsWithSpend = adSetDrilldown.adSets.filter(
      (a) => (a.insights?.spend ?? 0) > 0,
    );
    if (adSetsWithSpend.length === 0) {
      lines.push(
        `"${adSetDrilldown.campaignName}" has no ad sets with spend in the ${datePresetLabel} window.`,
      );
    } else {
      const breakdown = adSetsWithSpend
        .map((a) => {
          const cpr = a.insights?.costPerResult;
          return `"${a.name}": ${a.insights!.spend.toFixed(2)} ${currency}${cpr !== undefined ? `, ${cpr.toFixed(2)} ${currency}/${a.insights?.resultLabel ?? "result"}` : ", no results"}`;
        })
        .join("; ");
      lines.push(`Ad sets for "${adSetDrilldown.campaignName}": ${breakdown}.`);
    }
  }

  return lines.join(" ");
}
