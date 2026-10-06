import { addDays } from "@/lib/website-analytics/days";

import { aiAssistantOf } from "./ai-sources";
import { daysIn } from "./baseline";
import { GaSubjects, periodOf } from "./keys";
import { poissonRateTest } from "./stats";
import type {
  An7Evidence,
  GaFindingCandidate,
  GaWeeklyAnalysisInput,
  GaWindowTables,
} from "./types";

// AN7: yapay zekâ asistanlarından gelen ziyaretler (docs/google-analytics-
// plan.md §6.2; ayrıntı docs/website-insights.md "AN7"). Son 28 günün
// sessionSource değerleri asistan alan adlarıyla eşlenir (ai-sources.ts) ve
// önceki 28 günle karşılaştırılır. İlk kez görünme (önceki < 3) yön
// göstergesidir; büyüme ≥ %50 ve Poisson p < 0.05 anlamlıdır. Katalogda
// kaynak × giriş sayfası raporu olmadığından sayfa adı verilmez. Saf.

const MIN_SESSIONS = 10;
const FIRST_SEEN_BELOW = 3;
const MIN_GROWTH_PCT = 50;
const P_THRESHOLD = 0.05;
const MAX_ASSISTANTS = 5;
// Kayan nokta payı: %50 sınırı tam 50 olarak okunur.
const EPSILON = 1e-9;
// sourceMedium: [sessionSource, sessionMedium] × [sessions, engagedSessions, keyEvents]
const SESSIONS_INDEX = 0;
const KEY_EVENTS_INDEX = 2;

type AssistantTotals = Map<string, { sessions: number; keyEvents: number }>;

function assistantTotals(tables: GaWindowTables): AssistantTotals {
  const totals: AssistantTotals = new Map();
  for (const row of tables.sourceMedium) {
    const name = aiAssistantOf(row.key[0] ?? "");
    if (!name) continue;
    const entry = totals.get(name) ?? { sessions: 0, keyEvents: 0 };
    const sessions = row.values[SESSIONS_INDEX] ?? 0;
    const keyEvents = row.values[KEY_EVENTS_INDEX] ?? 0;
    entry.sessions += Number.isFinite(sessions) ? sessions : 0;
    entry.keyEvents += Number.isFinite(keyEvents) ? keyEvents : 0;
    totals.set(name, entry);
  }
  return totals;
}

function sumOf(totals: AssistantTotals): {
  sessions: number;
  keyEvents: number;
} {
  let sessions = 0;
  let keyEvents = 0;
  for (const entry of totals.values()) {
    sessions += entry.sessions;
    keyEvents += entry.keyEvents;
  }
  return { sessions, keyEvents };
}

export function evaluateAiReferrals(
  input: GaWeeklyAnalysisInput,
): GaFindingCandidate | null {
  const { window28, window28Previous } = input;
  const currentByName = assistantTotals(window28);
  const previousByName = assistantTotals(window28Previous);
  const current = sumOf(currentByName);
  const previous = sumOf(previousByName);
  if (current.sessions < MIN_SESSIONS) return null;

  const firstSeen = previous.sessions < FIRST_SEEN_BELOW;
  const changePct =
    previous.sessions > 0
      ? ((current.sessions - previous.sessions) / previous.sessions) * 100
      : null;
  const test = poissonRateTest(
    current.sessions,
    previous.sessions,
    window28.usedDays,
    window28Previous.usedDays,
  );
  const p = test?.p ?? null;
  const significant =
    !firstSeen &&
    changePct !== null &&
    changePct >= MIN_GROWTH_PCT - EPSILON &&
    p !== null &&
    p < P_THRESHOLD;
  if (!firstSeen && !significant) return null;

  const names = new Set([...currentByName.keys(), ...previousByName.keys()]);
  const assistants = [...names]
    .map((name) => ({
      name,
      sessions: currentByName.get(name)?.sessions ?? 0,
      previousSessions: previousByName.get(name)?.sessions ?? 0,
    }))
    .sort(
      (a, b) =>
        b.sessions - a.sessions ||
        b.previousSessions - a.previousSessions ||
        (a.name < b.name ? -1 : 1),
    )
    .slice(0, MAX_ASSISTANTS);

  const siteSessions = window28.totals.sessions;
  const sunday = input.week.sunday;
  const window = { from: addDays(sunday, -27), to: sunday };
  const evidence: An7Evidence = {
    v: 1,
    rule: "AN7",
    current: {
      from: window28.from,
      to: window28.to,
      sessions: current.sessions,
      keyEvents: current.keyEvents,
    },
    previous: {
      from: window28Previous.from,
      to: window28Previous.to,
      sessions: previous.sessions,
      keyEvents: previous.keyEvents,
    },
    assistants,
    changePct,
    p,
    firstSeen,
    siteSessions,
    holidays: daysIn(window, input.holidays),
  };
  return {
    ruleKey: "AN7",
    kind: "WIN",
    subject: GaSubjects.ai(),
    period: periodOf("WINDOW28", window),
    severity: "INFO",
    confidence: firstSeen ? "DIRECTIONAL" : "SIGNIFICANT",
    evidence,
    impact: null,
    impactShare: current.sessions / Math.max(1, siteSessions),
  };
}
