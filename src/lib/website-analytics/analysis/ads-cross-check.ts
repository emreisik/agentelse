import {
  clickLoss,
  costPer,
  isWebsiteResultType,
  resultsGap,
} from "@/lib/website-analytics/attribution/ads-compare";
import {
  CROSS_CHECK,
  type AdsCrossCheckCampaign,
} from "@/lib/website-analytics/attribution/types";

import { daysIn } from "./baseline";
import { GaSubjects, periodOf } from "./keys";
import { capLabel } from "./landing-pages";
import { poissonRateTest, wilsonInterval } from "./stats";
import type {
  An13Evidence,
  GaFindingCandidate,
  GaFindingConfidence,
  GaFindingSeverity,
  GaWeeklyAnalysisInput,
} from "./types";

// GA-F6 AN13: Meta'nın AD düzeyi tıklama ve sonuç sayıları ile GA4'ün aynı
// (agx koduyla etiketli) reklamlar için gördüğü oturum ve key event sayıları
// birbirini tutuyor mu (docs/website-attribution.md "AN13"). Yalnız kodlu
// reklamlar karşılaştırılır; girdi (input.ads) C paketinin okuyucusundan gelir
// ve bayrak kapalıyken yoktur. Saf modül, hata atmaz.
// - Tıklama → oturum kaybı > %40 ve oturum/tıklama oranının Wilson üst sınırı
//   < 0,60 ise SIGNIFICANT; kayıp > %60 ise ayrıca WARN.
// - Sonuç farkı (> %30) yalnız web sitesi sonuçlarında ve en az 10 sonuç ya da
//   key event varken bakılır; Poisson p < 0,05 ise SIGNIFICANT.

const SIGNIFICANT_P = 0.05;
const WARN_LOSS = 0.6;
const AN13_MAX = 3;

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}

function candidateOf(
  input: GaWeeklyAnalysisInput,
  campaign: AdsCrossCheckCampaign,
): GaFindingCandidate | null {
  const ads = input.ads;
  if (!ads) return null;
  const { meta, ga } = campaign;
  if (
    meta.linkClicks < CROSS_CHECK.minClicks ||
    meta.activeDays < CROSS_CHECK.minActiveDays
  ) {
    return null;
  }

  // Tıklama kontrolü.
  const loss = clickLoss(meta.linkClicks, ga.sessions);
  const clickRateHigh =
    wilsonInterval(Math.min(ga.sessions, meta.linkClicks), meta.linkClicks)
      ?.high ?? null;
  const clicksApplies = loss !== null && loss > CROSS_CHECK.maxClickLoss;
  const clicksSignificant =
    clicksApplies &&
    clickRateHigh !== null &&
    clickRateHigh < 1 - CROSS_CHECK.maxClickLoss;

  // Sonuç kontrolü: yalnız web sitesi sonuçları (offsite_conversion.*).
  const resultsCount = meta.results;
  const resultsEligible =
    isWebsiteResultType(meta.resultActionType) &&
    resultsCount !== null &&
    Math.max(resultsCount, ga.keyEvents) >= CROSS_CHECK.minConversions;
  const gap = resultsEligible ? resultsGap(resultsCount, ga.keyEvents) : null;
  const resultsApplies = gap !== null && gap > CROSS_CHECK.maxResultsGap;
  const resultsP =
    resultsEligible && resultsCount !== null
      ? (poissonRateTest(resultsCount, ga.keyEvents)?.p ?? null)
      : null;
  const resultsSignificant =
    resultsApplies && resultsP !== null && resultsP < SIGNIFICANT_P;

  if (!clicksApplies && !resultsApplies) return null;

  const checks: An13Evidence["checks"] = [];
  if (clicksApplies) checks.push("clicks");
  if (resultsApplies) checks.push("results");
  const significant = clicksSignificant || resultsSignificant;
  const confidence: GaFindingConfidence = significant
    ? "SIGNIFICANT"
    : "DIRECTIONAL";
  const severity: GaFindingSeverity =
    clicksSignificant && loss !== null && loss > WARN_LOSS ? "WARN" : "INFO";

  const evidence: An13Evidence = {
    v: 1,
    rule: "AN13",
    window: ads.window,
    campaignExternalId: campaign.campaignExternalId,
    label: capLabel(campaign.label),
    metaCurrency: ads.metaCurrency,
    meta: {
      ads: meta.ads,
      spend: meta.spend,
      linkClicks: meta.linkClicks,
      landingPageViews: meta.landingPageViews,
      results: meta.results,
      resultActionType: meta.resultActionType,
      activeDays: meta.activeDays,
    },
    ga: {
      sessions: ga.sessions,
      engagedSessions: ga.engagedSessions,
      keyEvents: ga.keyEvents,
      revenue: ga.revenue,
    },
    checks,
    clickLoss: loss,
    clickRateHigh,
    resultsGap: gap,
    resultsP,
    costPerResult: costPer(meta.spend, meta.results),
    costPerKeyEvent: costPer(meta.spend, ga.keyEvents),
    excludedDays: [...input.window28.excludedDays],
    holidays: daysIn(ads.window, input.holidays),
  };
  return {
    ruleKey: "AN13",
    kind: "RISK",
    subject: GaSubjects.metaCampaign(campaign.campaignExternalId),
    period: periodOf("WINDOW28", ads.window),
    severity,
    confidence,
    evidence,
    impact: null,
    impactShare: clamp01(
      (clicksApplies ? loss : null) ?? (resultsApplies ? gap : null) ?? 0,
    ),
  };
}

export function evaluateAdsCrossCheck(
  input: GaWeeklyAnalysisInput,
): GaFindingCandidate[] {
  const ads = input.ads;
  if (!ads) return [];
  const campaigns = [...ads.campaigns].sort(
    (a, b) =>
      b.meta.linkClicks - a.meta.linkClicks ||
      a.campaignExternalId.localeCompare(b.campaignExternalId),
  );
  const candidates: GaFindingCandidate[] = [];
  for (const campaign of campaigns) {
    const candidate = candidateOf(input, campaign);
    if (candidate) candidates.push(candidate);
    if (candidates.length >= AN13_MAX) break;
  }
  return candidates;
}
