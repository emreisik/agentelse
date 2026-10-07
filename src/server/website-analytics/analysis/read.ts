import "server-only";

import type { GaFinding, Prisma } from "@prisma/client";

import { prisma } from "@/lib/prisma";
import {
  gaInsightsMode,
  gaInsightsModeFor,
} from "@/lib/website-analytics/analysis/flags";
import { gaAttributionEnabled } from "@/lib/website-analytics/attribution/flags";
import { subjectLabelOf } from "@/lib/website-analytics/analysis/keys";
import {
  gaRule,
  isEvaluable,
  isGaRuleKey,
} from "@/lib/website-analytics/analysis/registry";
import {
  evidencePreliminary,
  parseGaFindingEvidence,
  parseGaImpact,
} from "@/lib/website-analytics/analysis/stored";
import {
  GA_ADS_RULE_KEYS,
  type GaFindingConfidence,
  type GaFindingKind,
  type GaFindingMode,
  type GaFindingOutcome,
  type GaFindingSeverity,
  type GaFindingStatus,
  type GaPeriodGrain,
  type GaReviewVerdict,
  type GaRuleKey,
} from "@/lib/website-analytics/analysis/types";
import type {
  GaFindingView,
  GaInsightsOperatorView,
  WebsiteInsightsView,
} from "@/lib/website-analytics/analysis/view-types";
import { dateToDayKey, safeTimezone } from "@/lib/website-analytics/days";
import { Heartbeat } from "@/server/observability/heartbeat";
import { isPlatformOperator } from "@/server/security/operator";
import { primaryGaLink } from "@/server/website-analytics/store";

// GA-F4 okuyucuları (docs/website-insights.md "Yüzeyler"): Website
// sayfasının "What changed" / "Opportunities" listeleri, sohbetin açık
// bulguları ve /health operatör kartı. Gölge satırlar yalnız inceleme
// modunda (platform operatörü + ?insights=review) görünür. Operatör kartı
// küresel sayaçları sayım sorgularıyla, son bulguları yalnız bakanın üye
// olduğu projelerden ve konu/kanıt/açıklama seçmeden okur.

const LIST_LIMIT = 6;
const IN_PROGRESS_LIMIT = 5;
const RECENT_LIMIT = 30;
const EVALUATED_VISIBLE_DAYS = 60;
const ANALYZED_WITHIN_DAYS = 2;
const DAY_MS = 86_400_000;
const HEARTBEAT_KEY = "ga.analyze";

const GRAINS: readonly GaPeriodGrain[] = ["DAY", "WEEK", "MONTH", "WINDOW28"];
const KINDS: readonly GaFindingKind[] = [
  "ANOMALY",
  "CHANGE",
  "OPPORTUNITY",
  "RISK",
  "WIN",
];
const SEVERITIES: readonly GaFindingSeverity[] = ["INFO", "WARN", "CRITICAL"];
const CONFIDENCES: readonly GaFindingConfidence[] = [
  "SIGNIFICANT",
  "DIRECTIONAL",
];
const STATUSES: readonly GaFindingStatus[] = [
  "OPEN",
  "ACCEPTED",
  "DISMISSED",
  "DONE",
  "EVALUATED",
  "EXPIRED",
  "SUPERSEDED",
  "RESOLVED",
];
const OUTCOMES: readonly GaFindingOutcome[] = [
  "WORKED",
  "DIDNT",
  "INCONCLUSIVE",
];
const VERDICTS: readonly GaReviewVerdict[] = ["USEFUL", "NOT_USEFUL"];

function oneOf<T extends string>(
  values: readonly T[],
  value: string | null,
): T | null {
  return values.find((candidate) => candidate === value) ?? null;
}

function iso(date: Date | null): string | null {
  return date ? date.toISOString() : null;
}

export function findingViewOf(row: GaFinding): GaFindingView | null {
  if (!isGaRuleKey(row.ruleKey)) return null;
  const evidence = parseGaFindingEvidence(row.evidence);
  const kind = oneOf(KINDS, row.kind);
  const grain = oneOf(GRAINS, row.periodGrain);
  const severity = oneOf(SEVERITIES, row.severity);
  const confidence = oneOf(CONFIDENCES, row.confidence);
  const status = oneOf(STATUSES, row.status);
  const mode: GaFindingMode | null =
    row.mode === "live" || row.mode === "shadow" ? row.mode : null;
  if (
    !evidence ||
    evidence.rule !== row.ruleKey ||
    !kind ||
    !grain ||
    !severity ||
    !confidence ||
    !status ||
    !mode
  ) {
    return null;
  }
  return {
    id: row.id,
    ruleKey: row.ruleKey,
    kind,
    subject: row.subject,
    subjectLabel: subjectLabelOf(row.subject),
    period: {
      grain,
      from: dateToDayKey(row.periodStart),
      to: dateToDayKey(row.periodEnd),
      key: row.periodKey,
    },
    severity,
    confidence,
    status,
    mode,
    priority: row.priority,
    evidence,
    impact: parseGaImpact(row.impact),
    explanation: row.explanation,
    occurrences: row.occurrences,
    evaluable: isEvaluable(row.ruleKey, evidence),
    preliminary: evidencePreliminary(evidence),
    createdAt: row.createdAt.toISOString(),
    acceptedAt: iso(row.acceptedAt),
    doneAt: iso(row.doneAt),
    evaluateAfter: iso(row.evaluateAfter),
    evaluatedAt: iso(row.evaluatedAt),
    outcome: oneOf(OUTCOMES, row.outcome),
    reviewVerdict: oneOf(VERDICTS, row.reviewVerdict),
  };
}

function views(rows: readonly GaFinding[]): GaFindingView[] {
  const result: GaFindingView[] = [];
  for (const row of rows) {
    const view = findingViewOf(row);
    if (view) result.push(view);
  }
  return result;
}

export async function loadWebsiteInsights(
  projectId: string,
  viewer: { userId: string; review: boolean },
  now: Date = new Date(),
): Promise<WebsiteInsightsView | null> {
  const projectMode = gaInsightsModeFor(projectId);
  if (projectMode === "off") return null;
  const reviewer = viewer.review && isPlatformOperator(viewer.userId);
  if (projectMode !== "on" && !reviewer) return null;
  const link = await primaryGaLink(projectId);
  if (!link) return null;

  const modes: GaFindingMode[] = reviewer ? ["live", "shadow"] : ["live"];
  const where: Prisma.GaFindingWhereInput = {
    linkId: link.id,
    mode: { in: modes },
  };
  const [open, progress] = await Promise.all([
    prisma.gaFinding.findMany({
      where: { ...where, status: "OPEN" },
      orderBy: [{ priority: "desc" }, { createdAt: "desc" }],
      take: 200,
    }),
    prisma.gaFinding.findMany({
      where: {
        ...where,
        OR: [
          { status: { in: ["ACCEPTED", "DONE"] } },
          {
            status: "EVALUATED",
            evaluatedAt: {
              gte: new Date(now.getTime() - EVALUATED_VISIBLE_DAYS * DAY_MS),
            },
          },
        ],
      },
      orderBy: [{ updatedAt: "desc" }],
      take: 50,
    }),
  ]);
  const openViews = views(open);
  return {
    review: reviewer,
    timeZone: safeTimezone(link.timeZone),
    currency: link.currencyCode,
    changed: openViews
      .filter((view) => gaRule(view.ruleKey).list === "changed")
      .slice(0, LIST_LIMIT),
    opportunities: openViews
      .filter((view) => gaRule(view.ruleKey).list === "opportunities")
      .slice(0, LIST_LIMIT),
    // Kabul edilmiş ama değerlendirilemeyen bulgu ("noted") listede durmaz.
    inProgress: views(progress)
      .filter((view) => view.status !== "ACCEPTED" || view.evaluable)
      .slice(0, IN_PROGRESS_LIMIT),
  };
}

export async function loadOpenFindingsForChat(
  projectId: string,
  limit = 5,
): Promise<GaFindingView[]> {
  if (gaInsightsModeFor(projectId) !== "on") return [];
  const link = await primaryGaLink(projectId);
  if (!link) return [];
  const rows = await prisma.gaFinding.findMany({
    where: { linkId: link.id, mode: "live", status: "OPEN" },
    orderBy: [{ priority: "desc" }, { createdAt: "desc" }],
    take: limit,
  });
  return views(rows);
}

export async function loadGaInsightsOperatorView(
  viewer: { userId: string },
  now: Date = new Date(),
): Promise<GaInsightsOperatorView | null> {
  const mode = gaInsightsMode();
  if (mode === "off") return null;

  const memberProjects = await prisma.project.findMany({
    where: { workspace: { members: { some: { userId: viewer.userId } } } },
    select: { id: true, name: true },
  });
  const memberIds = memberProjects.map((project) => project.id);
  const names = new Map(
    memberProjects.map((project) => [project.id, project.name]),
  );

  const [
    openByMode,
    createdLast7d,
    verdicts,
    byRule,
    reviewable,
    linksAnalyzed,
    primaryLinks,
    heartbeat,
    recent,
  ] = await Promise.all([
    prisma.gaFinding.groupBy({
      by: ["mode"],
      where: { status: "OPEN" },
      _count: { _all: true },
    }),
    prisma.gaFinding.count({
      where: { createdAt: { gte: new Date(now.getTime() - 7 * DAY_MS) } },
    }),
    prisma.gaFinding.groupBy({
      by: ["reviewVerdict"],
      where: { reviewVerdict: { not: null } },
      _count: { _all: true },
    }),
    prisma.gaFinding.groupBy({
      by: ["ruleKey"],
      where: { status: "OPEN" },
      _count: { _all: true },
    }),
    memberIds.length > 0
      ? prisma.gaFinding.count({
          where: { status: "OPEN", projectId: { in: memberIds } },
        })
      : Promise.resolve(0),
    prisma.gaAnalysisRun.count({
      where: {
        lastDailyAt: {
          gte: new Date(now.getTime() - ANALYZED_WITHIN_DAYS * DAY_MS),
        },
      },
    }),
    prisma.gaPropertyLink.count({ where: { isPrimary: true } }),
    Heartbeat.read(HEARTBEAT_KEY),
    memberIds.length > 0
      ? prisma.gaFinding.findMany({
          where: { projectId: { in: memberIds } },
          orderBy: { createdAt: "desc" },
          take: RECENT_LIMIT,
          select: {
            id: true,
            projectId: true,
            ruleKey: true,
            kind: true,
            confidence: true,
            mode: true,
            createdAt: true,
            reviewVerdict: true,
          },
        })
      : Promise.resolve([]),
  ]);

  const openCount = (value: string) =>
    openByMode.find((row) => row.mode === value)?._count._all ?? 0;
  const verdictCount = (value: GaReviewVerdict) =>
    verdicts.find((row) => row.reviewVerdict === value)?._count._all ?? 0;
  const useful = verdictCount("USEFUL");
  const notUseful = verdictCount("NOT_USEFUL");
  const reviewed = useful + notUseful;
  const lastBeat = heartbeat?.lastBeatAt ?? null;

  // AN13/AN14 sayaçları yalnız GA_UTM açıkken görünür; kapalıyken /health
  // kartı değişmez.
  const adsRulesVisible = gaAttributionEnabled();
  const rules: { ruleKey: GaRuleKey; open: number }[] = [];
  for (const row of byRule) {
    if (!isGaRuleKey(row.ruleKey)) continue;
    if (
      !adsRulesVisible &&
      (GA_ADS_RULE_KEYS as readonly string[]).includes(row.ruleKey)
    ) {
      continue;
    }
    rules.push({ ruleKey: row.ruleKey, open: row._count._all });
  }
  rules.sort((a, b) => b.open - a.open || a.ruleKey.localeCompare(b.ruleKey));

  const recentRows: GaInsightsOperatorView["recent"] = [];
  for (const row of recent) {
    const kind = oneOf(KINDS, row.kind);
    const confidence = oneOf(CONFIDENCES, row.confidence);
    if (!isGaRuleKey(row.ruleKey) || !kind || !confidence) continue;
    if (row.mode !== "live" && row.mode !== "shadow") continue;
    recentRows.push({
      id: row.id,
      projectId: row.projectId,
      projectName: names.get(row.projectId) ?? "",
      ruleKey: row.ruleKey,
      kind,
      confidence,
      mode: row.mode,
      createdAt: row.createdAt.toISOString(),
      verdict: oneOf(VERDICTS, row.reviewVerdict),
    });
  }

  return {
    mode,
    counters: {
      openShadow: openCount("shadow"),
      openLive: openCount("live"),
      createdLast7d,
      reviewable,
      reviewed,
      useful,
      notUseful,
      precision: reviewed > 0 ? useful / reviewed : null,
      linksAnalyzed,
      linksDue: Math.max(0, primaryLinks - linksAnalyzed),
      lastRunMinutesAgo: lastBeat
        ? Math.max(0, Math.floor((now.getTime() - lastBeat.getTime()) / 60_000))
        : null,
      byRule: rules,
    },
    recent: recentRows,
  };
}
