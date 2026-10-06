import type { GaTableRow } from "@/lib/website-analytics/slices";
import { maskGoogleText } from "@/server/integrations/google/pii";

import { GaSubjects } from "./keys";
import {
  capLabel,
  GA_RATIO_EPSILON,
  weeks4,
  window28Context,
} from "./landing-pages";
import { benjaminiHochberg, rateRatioTest, twoProportionTest } from "./stats";
import type {
  An4Evidence,
  An12Evidence,
  GaFindingCandidate,
  GaFindingConfidence,
  GaImpact,
  GaWeeklyAnalysisInput,
} from "./types";

// GA-F4 AN4 kanal kalitesi ve AN12 kampanya kalitesi
// (docs/website-insights.md): bir kanalın ya da kampanyanın etkileşim veya
// anahtar olay oranı sitenin geri kalanından belirgin biçimde düşük (RISK) ya
// da yüksek (WIN). Geri kalan = 28 günlük pencere toplamı − konu. Anahtar olay
// oranı Poisson oran testiyle (KE oturumu aşabilir), etkileşim oranı iki
// oran testiyle; BH q = 0,10 aile içinde. Saf modül, hata atmaz.

const SIGNIFICANT_P = 0.05;

// ---- AN4 ----

const AN4_MIN_SESSIONS = 200;
const AN4_IGNORED = new Set(["unassigned", "(other)", "(not set)", ""]);
const AN4_BELOW_RATIO = 0.7;
const AN4_ABOVE_RATIO = 1.3;
const AN4_MIN_REST_KEY_EVENTS = 10;
const AN4_MAX = 3;

type ChannelTest = {
  channel: string;
  measure: "engagement" | "keyEventRate";
  sessions: number;
  hits: number;
  restSessions: number;
  restHits: number;
  rate: number;
  restRate: number;
  ratio: number;
  p: number | null;
};

export function evaluateChannelQuality(
  input: GaWeeklyAnalysisInput,
): GaFindingCandidate[] {
  const context = window28Context(input);
  const totals = input.window28.totals;
  const tests: ChannelTest[] = [];
  for (const row of input.window28.channel) {
    const channel = row.key[0] ?? "";
    if (AN4_IGNORED.has(channel.trim().toLowerCase())) continue;
    const sessions = row.values[0] ?? 0;
    if (sessions < AN4_MIN_SESSIONS) continue;
    const restSessions = Math.max(0, totals.sessions - sessions);
    if (restSessions <= 0) continue;

    const engaged = row.values[1] ?? 0;
    const restEngaged = Math.max(0, totals.engagedSessions - engaged);
    if (restEngaged > 0) {
      const rate = engaged / sessions;
      const restRate = restEngaged / restSessions;
      tests.push({
        channel,
        measure: "engagement",
        sessions,
        hits: engaged,
        restSessions,
        restHits: restEngaged,
        rate,
        restRate,
        ratio: rate / restRate,
        p:
          twoProportionTest(engaged, sessions, restEngaged, restSessions)?.p ??
          null,
      });
    }

    const keyEvents = row.values[2] ?? 0;
    const restKeyEvents = Math.max(0, totals.keyEvents - keyEvents);
    if (restKeyEvents >= AN4_MIN_REST_KEY_EVENTS) {
      const rate = keyEvents / sessions;
      const restRate = restKeyEvents / restSessions;
      tests.push({
        channel,
        measure: "keyEventRate",
        sessions,
        hits: keyEvents,
        restSessions,
        restHits: restKeyEvents,
        rate,
        restRate,
        ratio: rate / restRate,
        p:
          rateRatioTest(keyEvents, sessions, restKeyEvents, restSessions)?.p ??
          null,
      });
    }
  }

  // BH ailesi: bütün kanal testleri birlikte.
  const accepted = benjaminiHochberg(tests.map((test) => test.p ?? 1));
  const candidates: GaFindingCandidate[] = [];
  tests.forEach((test, index) => {
    const below = test.ratio <= AN4_BELOW_RATIO + GA_RATIO_EPSILON;
    const above =
      test.measure === "keyEventRate" &&
      test.ratio >= AN4_ABOVE_RATIO - GA_RATIO_EPSILON;
    if (!below && !above) return;
    const bhAccepted = accepted[index] ?? false;
    const confidence: GaFindingConfidence =
      test.p !== null && test.p < SIGNIFICANT_P && bhAccepted
        ? "SIGNIFICANT"
        : "DIRECTIONAL";
    const perWeek = below
      ? weeks4((test.restRate - test.rate) * test.sessions)
      : weeks4(test.hits - test.restRate * test.sessions);
    const impact: GaImpact = {
      metric: test.measure === "engagement" ? "engagedSessions" : "keyEvents",
      perWeek,
      low: perWeek,
      high: perWeek,
      directional: below ? confidence !== "SIGNIFICANT" : true,
    };
    const total =
      test.measure === "engagement" ? totals.engagedSessions : totals.keyEvents;
    const evidence: An4Evidence = {
      v: 1,
      rule: "AN4",
      window: context.range,
      channel: test.channel,
      measure: test.measure,
      direction: below ? "below" : "above",
      sessions: test.sessions,
      hits: test.hits,
      rate: test.rate,
      restSessions: test.restSessions,
      restHits: test.restHits,
      restRate: test.restRate,
      ratio: test.ratio,
      p: test.p,
      bhAccepted,
      excludedDays: context.excludedDays,
      holidays: context.holidays,
    };
    candidates.push({
      ruleKey: "AN4",
      kind: below ? "RISK" : "WIN",
      subject: GaSubjects.channel(test.channel, test.measure),
      period: context.period,
      severity: below && confidence === "SIGNIFICANT" ? "WARN" : "INFO",
      confidence,
      evidence,
      impact,
      impactShare: perWeek / Math.max(1, weeks4(total)),
    });
  });
  return topByImpactShare(candidates, AN4_MAX);
}

function topByImpactShare(
  candidates: GaFindingCandidate[],
  max: number,
): GaFindingCandidate[] {
  return candidates
    .sort(
      (a, b) =>
        b.impactShare - a.impactShare || a.subject.localeCompare(b.subject),
    )
    .slice(0, max);
}

// ---- AN12 ----

const AN12_MIN_SESSIONS = 50;
const AN12_BELOW_RATIO = 0.5;
const AN12_ABOVE_RATIO = 1.5;
const AN12_ABOVE_MIN_KEY_EVENTS = 5;
const AN12_SIGNIFICANT_MIN_SESSIONS = 200;
const AN12_SIGNIFICANT_MIN_REST_KEY_EVENTS = 10;
const AN12_MAX = 3;
// GA'nın kampanya olmayan sözde değerleri.
const AN12_IGNORED = new Set([
  "",
  "(not set)",
  "(other)",
  "(direct)",
  "(organic)",
  "(referral)",
]);
const AGENTELSE_PREFIX = "agx-";

export function campaignLabel(value: string): string {
  return capLabel(maskGoogleText(value));
}

export type GaCampaignRow = {
  campaign: string;
  source: string;
  medium: string;
  sessions: number;
  keyEvents: number;
};

// Kampanya satırları maskelenmiş etiketlere göre birleştirilir.
export function campaignRows(rows: readonly GaTableRow[]): GaCampaignRow[] {
  const byKey = new Map<string, GaCampaignRow>();
  for (const row of rows) {
    const raw = row.key[0] ?? "";
    if (AN12_IGNORED.has(raw.trim().toLowerCase())) continue;
    const campaign = campaignLabel(raw);
    const source = campaignLabel(row.key[1] ?? "");
    const medium = campaignLabel(row.key[2] ?? "");
    if (campaign === "") continue;
    const id = JSON.stringify([campaign, source, medium]);
    const entry = byKey.get(id) ?? {
      campaign,
      source,
      medium,
      sessions: 0,
      keyEvents: 0,
    };
    entry.sessions += row.values[0] ?? 0;
    entry.keyEvents += row.values[2] ?? 0;
    byKey.set(id, entry);
  }
  return [...byKey.values()];
}

export function evaluateCampaigns(
  input: GaWeeklyAnalysisInput,
): GaFindingCandidate[] {
  const context = window28Context(input);
  const totals = input.window28.totals;
  const tests = campaignRows(input.window28.campaign)
    .filter((row) => row.sessions >= AN12_MIN_SESSIONS)
    .flatMap((row) => {
      const restSessions = Math.max(0, totals.sessions - row.sessions);
      const restKeyEvents = Math.max(0, totals.keyEvents - row.keyEvents);
      if (restSessions <= 0 || restKeyEvents <= 0) return [];
      const rate = row.keyEvents / row.sessions;
      const restRate = restKeyEvents / restSessions;
      return [
        {
          row,
          restSessions,
          restKeyEvents,
          rate,
          restRate,
          ratio: rate / restRate,
          p:
            rateRatioTest(
              row.keyEvents,
              row.sessions,
              restKeyEvents,
              restSessions,
            )?.p ?? null,
        },
      ];
    });

  const accepted = benjaminiHochberg(tests.map((test) => test.p ?? 1));
  const candidates: GaFindingCandidate[] = [];
  tests.forEach((test, index) => {
    const { row } = test;
    const below = test.ratio <= AN12_BELOW_RATIO + GA_RATIO_EPSILON;
    const above =
      test.ratio >= AN12_ABOVE_RATIO - GA_RATIO_EPSILON &&
      row.keyEvents >= AN12_ABOVE_MIN_KEY_EVENTS;
    if (!below && !above) return;
    const bhAccepted = accepted[index] ?? false;
    const confidence: GaFindingConfidence =
      test.p !== null &&
      test.p < SIGNIFICANT_P &&
      bhAccepted &&
      row.sessions >= AN12_SIGNIFICANT_MIN_SESSIONS &&
      test.restKeyEvents >= AN12_SIGNIFICANT_MIN_REST_KEY_EVENTS
        ? "SIGNIFICANT"
        : "DIRECTIONAL";
    const perWeek = below
      ? weeks4((test.restRate - test.rate) * row.sessions)
      : weeks4(row.keyEvents - test.restRate * row.sessions);
    const evidence: An12Evidence = {
      v: 1,
      rule: "AN12",
      window: context.range,
      campaign: row.campaign,
      source: row.source,
      medium: row.medium,
      agentelse: row.campaign.toLowerCase().startsWith(AGENTELSE_PREFIX),
      direction: below ? "below" : "above",
      sessions: row.sessions,
      keyEvents: row.keyEvents,
      rate: test.rate,
      restSessions: test.restSessions,
      restKeyEvents: test.restKeyEvents,
      restRate: test.restRate,
      ratio: test.ratio,
      p: test.p,
      bhAccepted,
      excludedDays: context.excludedDays,
      holidays: context.holidays,
    };
    candidates.push({
      ruleKey: "AN12",
      kind: below ? "RISK" : "WIN",
      subject: GaSubjects.campaign(row.campaign, row.source, row.medium),
      period: context.period,
      severity: below && confidence === "SIGNIFICANT" ? "WARN" : "INFO",
      confidence,
      evidence,
      impact: {
        metric: "keyEvents",
        perWeek,
        low: perWeek,
        high: perWeek,
        directional: below ? confidence !== "SIGNIFICANT" : true,
      },
      impactShare: perWeek / Math.max(1, weeks4(totals.keyEvents)),
    });
  });
  return topByImpactShare(candidates, AN12_MAX);
}
