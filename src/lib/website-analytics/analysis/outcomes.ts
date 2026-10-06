import { campaignRows } from "./channels";
import { notFoundPathLabel } from "./content";
import { deviceRow } from "./devices";
import { funnelStep } from "./ecommerce";
import { landingRowsByPath } from "./landing-pages";
import { poissonRateTest, rateRatioTest, twoProportionTest } from "./stats";
import type {
  GaFindingEvidence,
  GaFindingOutcome,
  GaOutcomeEvidence,
  GaRuleKey,
  GaWindowTables,
} from "./types";

// GA-F4 bulgu sonucu (docs/website-insights.md, plan §6.3): kullanıcı "Done"
// dedikten sonra önce [d−28, d−1] ve sonra [d+7, d+34] pencerelerinde konunun
// ölçüsü karşılaştırılır. Kontrol sitenin geri kalanıdır: konu sitenin
// genel değişiminden daha çok iyileşmediyse WORKED değildir. Pencere başına 7
// günden çok şüpheli gün varsa ölçüm güvenilmez (tracking_issue). Saf modül,
// hata atmaz.

export type GaOutcomeResult =
  | { wait: true }
  | { wait: false; outcome: GaFindingOutcome; evidence: GaOutcomeEvidence };

const MAX_EXCLUDED_DAYS = 7;
const SIGNIFICANT_P = 0.05;
const MIN_UPLIFT_PCT = 10;
const MIN_WINDOW_SESSIONS = 200;
const MIN_TOTAL_HITS = 10;
const PROMOTE_MIN_UPLIFT_PCT = 20;
const PROMOTE_MIN_BEFORE_SESSIONS = 100;
const NOT_FOUND_WORKED_SHARE = 0.3;

type TestKind = "rateRatio" | "proportion" | "sessions" | "views";

// Bir penceredeki konu ölçüsü ve (varsa) sitenin geri kalanı.
type Measure = {
  sessions: number;
  hits: number;
  rate: number | null;
  rest: { sessions: number; hits: number; rate: number | null } | null;
};

type Spec = {
  kind: TestKind;
  measure: (tables: GaWindowTables) => Measure;
};

function ratio(hits: number, exposure: number): number | null {
  return exposure > 0 ? hits / exposure : null;
}

// Konu ve geri kalan: oran = isabet / oturum.
function withRest(
  tables: GaWindowTables,
  subject: { sessions: number; hits: number },
  siteHits: number,
): Measure {
  const restSessions = Math.max(0, tables.totals.sessions - subject.sessions);
  const restHits = Math.max(0, siteHits - subject.hits);
  return {
    sessions: subject.sessions,
    hits: subject.hits,
    rate: ratio(subject.hits, subject.sessions),
    rest: {
      sessions: restSessions,
      hits: restHits,
      rate: ratio(restHits, restSessions),
    },
  };
}

// Pencerede ölçülen gün sayısı (dışlananlar hariç); oturum hızı için.
function cleanDays(tables: GaWindowTables): number {
  return tables.usedDays > 0
    ? tables.usedDays
    : Math.max(0, tables.days - tables.excludedDays.length);
}

function specFor(ruleKey: GaRuleKey, evidence: GaFindingEvidence): Spec | null {
  if (evidence.rule !== ruleKey) return null;
  switch (evidence.rule) {
    case "AN3": {
      const page = (tables: GaWindowTables) =>
        landingRowsByPath(tables.landing).find(
          (row) => row.path === evidence.page,
        ) ?? { sessions: 0, keyEvents: 0 };
      if (evidence.variant === "promote") {
        // Ölçü sayfanın günlük oturum hızı; kontrol sitenin geri kalanı.
        return {
          kind: "sessions",
          measure: (tables) => {
            const row = page(tables);
            const days = cleanDays(tables);
            const restSessions = Math.max(
              0,
              tables.totals.sessions - row.sessions,
            );
            return {
              sessions: row.sessions,
              hits: row.keyEvents,
              rate: ratio(row.sessions, days),
              rest: {
                sessions: restSessions,
                hits: restSessions,
                rate: ratio(restSessions, days),
              },
            };
          },
        };
      }
      return {
        kind: "rateRatio",
        measure: (tables) => {
          const row = page(tables);
          return withRest(
            tables,
            { sessions: row.sessions, hits: row.keyEvents },
            tables.totals.keyEvents,
          );
        },
      };
    }
    case "AN4": {
      const engagement = evidence.measure === "engagement";
      return {
        kind: engagement ? "proportion" : "rateRatio",
        measure: (tables) => {
          const subject = { sessions: 0, hits: 0 };
          for (const row of tables.channel) {
            if (row.key[0] !== evidence.channel) continue;
            subject.sessions += row.values[0] ?? 0;
            subject.hits += row.values[engagement ? 1 : 2] ?? 0;
          }
          return withRest(
            tables,
            subject,
            engagement
              ? tables.totals.engagedSessions
              : tables.totals.keyEvents,
          );
        },
      };
    }
    case "AN5":
      return {
        kind: "rateRatio",
        measure: (tables) => {
          const mobile = deviceRow(tables.device, "mobile");
          return withRest(
            tables,
            { sessions: mobile.sessions, hits: mobile.keyEvents },
            tables.totals.keyEvents,
          );
        },
      };
    case "AN9": {
      const paths = new Set(evidence.pages.map((page) => page.path));
      return {
        kind: "views",
        measure: (tables) => {
          const views = tables.pages.reduce(
            (sum, row) =>
              paths.has(notFoundPathLabel(row.key[0] ?? ""))
                ? sum + (row.values[0] ?? 0)
                : sum,
            0,
          );
          return {
            sessions: tables.totals.sessions,
            hits: views,
            rate: ratio(views, tables.totals.screenPageViews),
            rest: null,
          };
        },
      };
    }
    case "AN11": {
      const { from, to } = evidence.step;
      return {
        kind: "proportion",
        measure: (tables) => {
          // Hunide "oturum" adımın girişidir; sitenin geri kalanı yok.
          const step = funnelStep(tables.events, from, to);
          return {
            sessions: step.entered,
            hits: step.completed,
            rate: ratio(step.completed, step.entered),
            rest: null,
          };
        },
      };
    }
    case "AN12":
      return {
        kind: "rateRatio",
        measure: (tables) => {
          const row = campaignRows(tables.campaign).find(
            (candidate) =>
              candidate.campaign === evidence.campaign &&
              candidate.source === evidence.source &&
              candidate.medium === evidence.medium,
          ) ?? { sessions: 0, keyEvents: 0 };
          return withRest(
            tables,
            { sessions: row.sessions, hits: row.keyEvents },
            tables.totals.keyEvents,
          );
        },
      };
    default:
      return null;
  }
}

function upliftPct(before: number | null, after: number | null): number | null {
  if (before === null || after === null || before <= 0) return null;
  return ((after - before) / before) * 100;
}

function emptyMeasure(): Measure {
  return { sessions: 0, hits: 0, rate: null, rest: null };
}

function testP(
  kind: TestKind,
  before: Measure,
  after: Measure,
  exposure: { before: number; after: number },
): number | null {
  switch (kind) {
    case "rateRatio":
      return (
        rateRatioTest(after.hits, after.sessions, before.hits, before.sessions)
          ?.p ?? null
      );
    case "proportion":
      return (
        twoProportionTest(
          after.hits,
          after.sessions,
          before.hits,
          before.sessions,
        )?.p ?? null
      );
    case "sessions":
      return (
        poissonRateTest(
          after.sessions,
          before.sessions,
          exposure.after,
          exposure.before,
        )?.p ?? null
      );
    case "views":
      return null;
  }
}

export function evaluateGaOutcome(input: {
  ruleKey: GaRuleKey;
  evidence: GaFindingEvidence;
  before: GaWindowTables;
  after: GaWindowTables;
  graceOver: boolean;
}): GaOutcomeResult {
  const spec = specFor(input.ruleKey, input.evidence);
  const before = spec ? spec.measure(input.before) : emptyMeasure();
  const after = spec ? spec.measure(input.after) : emptyMeasure();
  const exposure = {
    before: cleanDays(input.before),
    after: cleanDays(input.after),
  };
  const p = spec ? testP(spec.kind, before, after, exposure) : null;
  const uplift = upliftPct(before.rate, after.rate);
  const siteUplift = upliftPct(
    before.rest?.rate ?? null,
    after.rest?.rate ?? null,
  );

  const result = (
    outcome: GaFindingOutcome,
    reason: GaOutcomeEvidence["reason"],
  ): GaOutcomeResult => ({
    wait: false,
    outcome,
    evidence: {
      v: 1,
      before: {
        from: input.before.from,
        to: input.before.to,
        sessions: before.sessions,
        hits: before.hits,
        rate: before.rate,
      },
      after: {
        from: input.after.from,
        to: input.after.to,
        sessions: after.sessions,
        hits: after.hits,
        rate: after.rate,
      },
      siteBefore: before.rest ? { rate: before.rest.rate } : null,
      siteAfter: after.rest ? { rate: after.rest.rate } : null,
      p,
      upliftPct: uplift,
      siteUpliftPct: siteUplift,
      reason,
    },
  });

  if (
    input.before.excludedDays.length > MAX_EXCLUDED_DAYS ||
    input.after.excludedDays.length > MAX_EXCLUDED_DAYS
  ) {
    return result("INCONCLUSIVE", "tracking_issue");
  }
  // Değerlendirilemeyen kural ya da kurala uymayan kanıt.
  if (!spec) {
    return input.graceOver
      ? result("INCONCLUSIVE", "too_little_data")
      : { wait: true };
  }

  if (spec.kind === "views") {
    // AN9: "bulunamadı" görüntülemeleri önceki düzeyin %30'una indiyse işe
    // yaradı.
    if (before.hits <= 0) return result("INCONCLUSIVE", "too_little_data");
    return after.hits <= NOT_FOUND_WORKED_SHARE * before.hits
      ? result("WORKED", "worked")
      : result("DIDNT", "no_change");
  }

  const rb = before.rate;
  const ra = after.rate;
  const significant = p !== null && p < SIGNIFICANT_P;
  const beatsSite =
    uplift !== null && (siteUplift === null || uplift > siteUplift);
  const minUplift =
    spec.kind === "sessions" ? PROMOTE_MIN_UPLIFT_PCT : MIN_UPLIFT_PCT;
  if (
    rb !== null &&
    ra !== null &&
    ra > rb &&
    significant &&
    uplift !== null &&
    uplift >= minUplift &&
    beatsSite
  ) {
    return result("WORKED", "worked");
  }

  const enoughData =
    spec.kind === "sessions"
      ? before.sessions >= PROMOTE_MIN_BEFORE_SESSIONS
      : before.sessions >= MIN_WINDOW_SESSIONS &&
        after.sessions >= MIN_WINDOW_SESSIONS &&
        before.hits + after.hits >= MIN_TOTAL_HITS;
  if (enoughData) {
    const worse = rb !== null && ra !== null && ra < rb && significant;
    return result("DIDNT", worse ? "worse" : "no_change");
  }
  return input.graceOver
    ? result("INCONCLUSIVE", "too_little_data")
    : { wait: true };
}
