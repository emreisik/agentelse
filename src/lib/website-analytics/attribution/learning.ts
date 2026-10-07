import { rateRatioTest } from "@/lib/website-analytics/analysis/stats";
import type {
  AttributionGroup,
  AttributionMetrics,
} from "@/lib/website-analytics/attribution/types";

// GA-F6 öğrenme kapısı (docs/website-attribution.md "Öğrenmeler"): etiketli
// bir grubun (Agentelse reklamı, bio linki, gönderi) site ziyaretçileri,
// sitenin geri kalanından key event oranında belirgin farklıysa tek bir
// Brand Brain öğrenmesi yazılır. GA-F4 kuralı: GA4 öğrenme metni yol, terim
// ve SAYI taşımaz (sonraki marka bağlamlarına eklenir). Oran, p ve oturum
// yalnız çağırana döner; polariteyi ve güven kademesini belirler.

export const ATTRIBUTION_LEARNING_GATE = {
  windowDays: 28,
  minSessions: 200,
  minRestSessions: 200,
  minExpectedKeyEvents: 10,
  maxP: 0.05,
  worksRatio: 1.25,
  avoidRatio: 0.8,
} as const;

export const GA_ATTRIBUTION_LEARNING_PREFIX = "ga-utm:";

export type AttributionLearning = {
  sourceRef: string;
  insight: string;
  polarity: "WORKS" | "AVOID";
  confidence: number;
  ratio: number;
  p: number;
  sessions: number;
};

const LABEL_LIMIT = 60;

// Yalnız bizim etiketimiz (plan / kampanya adı) metne girer; yine de rakam,
// tırnak, kontrol karakteri ve yol/sorgu işaretleri atılır.
function cleanLabel(label: string): string {
  const cleaned = label
    .replace(/[\p{Cc}\p{N}"'`‘’“”]/gu, " ")
    .replace(/[/\\?&=#<>{}[\]|]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return cleaned.slice(0, LABEL_LIMIT).trim();
}

function subjectOf(
  group: Pick<AttributionGroup, "kind" | "entityType" | "label">,
): string {
  const label = cleanLabel(group.label);
  const named = (noun: string) => (label ? `${noun} "${label}"` : noun);
  if (group.kind === "meta_campaign") return named("the Meta campaign");
  switch (group.entityType) {
    case "instagram_bio":
      return "your Instagram bio link";
    case "facebook_post":
      return named("the Facebook post");
    case "social_post":
      return named("the post");
    case "meta_ad":
      return named("the Meta ad");
  }
}

export function attributionLearningOf(input: {
  group: Pick<
    AttributionGroup,
    "key" | "kind" | "entityType" | "label" | "metrics"
  >;
  rest: AttributionMetrics;
}): AttributionLearning | null {
  const { group, rest } = input;
  const gate = ATTRIBUTION_LEARNING_GATE;
  const sessions = group.metrics.sessions;
  const keyEvents = group.metrics.keyEvents;
  const numbers = [sessions, keyEvents, rest.sessions, rest.keyEvents];
  if (!numbers.every(Number.isFinite)) return null;
  if (sessions < gate.minSessions) return null;
  if (rest.sessions < gate.minRestSessions) return null;
  const expected = (rest.keyEvents / rest.sessions) * sessions;
  if (!(expected >= gate.minExpectedKeyEvents)) return null;

  const test = rateRatioTest(
    keyEvents,
    sessions,
    rest.keyEvents,
    rest.sessions,
  );
  if (!test || test.ratio === null || !(test.p < gate.maxP)) return null;

  const subject = subjectOf(group);
  let polarity: AttributionLearning["polarity"];
  let insight: string;
  if (test.ratio >= gate.worksRatio) {
    polarity = "WORKS";
    insight = `Visitors from ${subject} took a key action clearly more often than other website visitors.`;
  } else if (test.ratio <= gate.avoidRatio) {
    polarity = "AVOID";
    insight = `Visitors from ${subject} took a key action clearly less often than other website visitors; check that the ad or post matches the page it opens.`;
  } else {
    return null;
  }
  return {
    sourceRef: GA_ATTRIBUTION_LEARNING_PREFIX + group.key,
    insight,
    polarity,
    confidence: test.p < 0.01 && sessions >= 1000 ? 0.8 : 0.6,
    ratio: test.ratio,
    p: test.p,
    sessions,
  };
}
