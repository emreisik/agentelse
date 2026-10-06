import {
  WEBSITE_GOAL_KEYS,
  type GaWebsiteGoalKey,
} from "@/lib/website-analytics/analysis/types";

import type { ForecastMetric } from "./types";

// GA-F5 hedef anahtarları: GA-F4'ün WEBSITE_GOAL_KEYS sözleşmesi (AN15 bu
// anahtarlarla çalışır). Hedef değeri mülk saatiyle takvim ayı hedefidir.

export { WEBSITE_GOAL_KEYS };
export type { GaWebsiteGoalKey };

export function isWebsiteGoalKey(value: unknown): value is GaWebsiteGoalKey {
  return (
    typeof value === "string" &&
    (WEBSITE_GOAL_KEYS as readonly string[]).includes(value)
  );
}

// Hedef anahtarının izlediği ambar metriği.
export function goalMetricOf(key: GaWebsiteGoalKey): ForecastMetric {
  if (key === "web.key_events") return "keyEvents";
  if (key === "web.revenue") return "revenue";
  return "sessions";
}

export function goalFormatOf(key: GaWebsiteGoalKey): "count" | "money" {
  return key === "web.revenue" ? "money" : "count";
}

// Sayılar tam sayıya, para iki ondalığa yuvarlanır.
export function roundGoalValue(key: GaWebsiteGoalKey, value: number): number {
  return goalFormatOf(key) === "money"
    ? Math.round(value * 100) / 100
    : Math.round(value);
}

export const WEBSITE_GOAL_LABEL: Readonly<Record<GaWebsiteGoalKey, string>> = {
  "web.sessions": "Sessions",
  "web.key_events": "Key events",
  "web.revenue": "Revenue",
};

export const WEBSITE_GOAL_TITLE: Readonly<Record<GaWebsiteGoalKey, string>> = {
  "web.sessions": "Website sessions per month",
  "web.key_events": "Website key events per month",
  "web.revenue": "Website revenue per month",
};

export const WEBSITE_GOAL_DESCRIPTION =
  "Monthly target, measured every day from Google Analytics (property time).";
