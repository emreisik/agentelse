import "server-only";

import type { GscSiteLink } from "@prisma/client";

import { isExpired } from "@/lib/ideas/concept";
import { IDEA_PLANNED_STATUSES, IDEA_POOL_STATUSES } from "@/lib/idea-pool";
import { prisma } from "@/lib/prisma";
import { planInputFromSnapshot } from "@/lib/seo/content-plan/candidates";
import {
  parseContentPlanData,
  type ContentPlanInput,
  type PlanEmptyReason,
  type PlanFindingRef,
  type PlanIntent,
  type PoolIdeaRef,
} from "@/lib/seo/content-plan/types";
import { dayKeyInTimezone } from "@/lib/timezone";
import { readIdeaRows } from "@/server/ideas/idea-context";
import { scopeForProject } from "@/server/seo/opportunities/classify";
import { readClusters } from "@/server/seo/opportunities/clusters";
import { listProjectFindings } from "@/server/seo/opportunities/findings-store";
import { loadRuleSnapshot } from "@/server/seo/opportunities/snapshot";
import {
  parseSeoCurves,
  readEngineState,
} from "@/server/seo/opportunities/state";

import { listSeoPiecesInMonth, type SlotScope } from "./pieces";

// W3 bağdaştırıcısı (docs/search-content-plan.md "Plan nasıl kurulur" 2): fırsat
// motorunun anlık görüntüsünü, bulguları, fikirleri ve önceki planları tek
// ContentPlanInput'a toplar. W3 imzalarını bilen tek yer burasıdır (saf çekirdek
// yalnız planInputFromSnapshot'ta RuleSnapshot görür). Adaylar ASLA saklanmaz:
// oluşturma, Replace ve Refresh her seferinde buradan taze okur.

const FINDINGS_LIMIT = 100;
const EXISTING_POSTS = 60;
const POOL_IDEAS_MAX = 50;
// Önceki aylar: reddedilenler ve önceki slot anahtar kelimeleri bu kadar geriye.
const HISTORY_MONTHS = 3;

export type LoadedPlanInput =
  | {
      ok: true;
      input: ContentPlanInput;
      link: GscSiteLink;
      scope: SlotScope;
      // Bu yerel ayda şu an sayılan seo.article parçaları (yok sayılanlar hariç)
      existingInMonth: number;
      // Bu ayda seo.article parçası olan yerel günler
      takenDates: string[];
      // Proje içerik dili (kod ya da null)
      language: string | null;
    }
  | { ok: false; empty: PlanEmptyReason }
  | { ok: false; retry: "ENGINE_BEHIND" };

// Yeniden planlama: yerine geçecek slotların parçaları ve fikirleri mevcut
// sayılmaz (kendi anahtar kelimelerini, başlıklarını ve günlerini bloklamasın).
export type PlanIgnore = {
  ideaIds?: readonly string[];
  creativeIds?: readonly string[];
};

// "2026-10" -> "2026-07" (n ay geri).
export function monthsBack(month: string, count: number): string {
  const [year, mon] = month.split("-").map(Number);
  const index = year! * 12 + (mon! - 1) - count;
  const y = Math.floor(index / 12);
  const m = (index % 12) + 1;
  return `${y}-${String(m).padStart(2, "0")}`;
}

function intentOf(value: string): PlanIntent | null {
  return value === "informational" ||
    value === "commercial" ||
    value === "transactional"
    ? value
    : null;
}

function toFindingRef(view: {
  id: string;
  ruleKey: string;
  queryId: string | null;
  clusterId: string | null;
  status: string;
  confidence: "SIGNIFICANT" | "DIRECTIONAL";
}): PlanFindingRef | null {
  if (view.ruleKey !== "SO5_CONTENT_GAP" && view.ruleKey !== "SO6_RISING_QUERY") {
    return null;
  }
  if (
    view.status !== "OPEN" &&
    view.status !== "ACCEPTED" &&
    view.status !== "DISMISSED"
  ) {
    return null;
  }
  return {
    id: view.id,
    ruleKey: view.ruleKey,
    queryId: view.queryId,
    clusterId: view.clusterId,
    status: view.status,
    confidence: view.confidence,
  };
}

async function readFindings(projectId: string): Promise<PlanFindingRef[]> {
  const ruleKeys = ["SO5_CONTENT_GAP", "SO6_RISING_QUERY"] as const;
  const [live, dismissed] = await Promise.all([
    listProjectFindings(projectId, {
      statuses: ["OPEN", "ACCEPTED"],
      ruleKeys,
      limit: FINDINGS_LIMIT,
    }),
    listProjectFindings(projectId, {
      statuses: ["DISMISSED"],
      ruleKeys,
      limit: FINDINGS_LIMIT,
    }),
  ]);
  return [...live, ...dismissed]
    .map(toFindingRef)
    .filter((ref): ref is PlanFindingRef => ref !== null);
}

export async function loadPlanInput(input: {
  link: GscSiteLink;
  month: string;
  timezone: string;
  now: Date;
  ignore?: PlanIgnore;
}): Promise<LoadedPlanInput> {
  const { link, month, timezone, now } = input;
  const ignoredIdeas = new Set(input.ignore?.ideaIds ?? []);
  const ignoredCreatives = new Set(input.ignore?.creativeIds ?? []);
  const week = link.lastWeeklyWeek;
  if (!week) return { ok: false, empty: "NO_DATA" };

  // Motor bu haftayı bitirmediyse (sınıflama, kümeler) plan eski veriyle
  // kurulmaz; çağıran sonra yeniden dener.
  const state = await readEngineState(link.id);
  if (!state || state.lastWeek !== week || state.clustersWeek !== week) {
    return { ok: false, retry: "ENGINE_BEHIND" };
  }

  const scope = await scopeForProject(link.projectId);
  if (!scope) return { ok: false, empty: "NO_DATA" };

  const clusters = await readClusters(link.id);
  const snapshot = await loadRuleSnapshot({
    link,
    week,
    curves: parseSeoCurves(state.curves),
    clusters,
    now,
  });
  if (!snapshot) return { ok: false, empty: "NO_DATA" };

  const historyFrom = monthsBack(month, HISTORY_MONTHS);
  const [findings, posts, ideaRows, plans, pieces] = await Promise.all([
    readFindings(link.projectId),
    prisma.post.findMany({
      where: {
        projectId: link.projectId,
        archivedAt: null,
        deliveries: {
          some: {
            formatKey: "seo.article",
            status: { notIn: ["ARCHIVED", "REJECTED"] },
            ...(ignoredCreatives.size > 0
              ? { id: { notIn: [...ignoredCreatives] } }
              : {}),
          },
        },
      },
      orderBy: { createdAt: "desc" },
      take: EXISTING_POSTS,
      select: { topic: true },
    }),
    readIdeaRows(link.projectId),
    prisma.seoContentPlan.findMany({
      where: { linkId: link.id, month: { gte: historyFrom, lte: month } },
      select: { month: true, data: true },
    }),
    listSeoPiecesInMonth(prisma, {
      projectId: link.projectId,
      month,
      timezone,
    }),
  ]);

  // Önceki slot anahtar kelimeleri yalnız Creative'i hâlâ var olan ve
  // arşivlenmemiş olanlarda sayılır (süpürülen/kaldırılan slot yeniden
  // planlanabilir).
  const parsedPlans = plans.map((row) => ({
    month: row.month,
    data: parseContentPlanData(row.data, now),
  }));
  const slotCreativeIds = parsedPlans.flatMap((plan) =>
    plan.data.slots
      .filter((slot) => !ignoredCreatives.has(slot.creativeId))
      .map((slot) => slot.creativeId),
  );
  const liveCreatives =
    slotCreativeIds.length > 0
      ? new Set(
          (
            await prisma.creative.findMany({
              where: {
                id: { in: slotCreativeIds },
                status: { not: "ARCHIVED" },
              },
              select: { id: true },
            })
          ).map((row) => row.id),
        )
      : new Set<string>();
  const earlierSlotKeywords = parsedPlans.flatMap((plan) =>
    plan.data.slots
      .filter((slot) => liveCreatives.has(slot.creativeId))
      .map((slot) => slot.keyword),
  );
  const rejectedKeys = [...new Set(parsedPlans.flatMap((plan) => plan.data.rejected))];

  // Fikirler: yalnız aynı kipin (isMock) SEO fikirleri. Havuzdakiler yeniden
  // kullanılabilir (poolIdeas); planlanmışlar (PLANNING/ACTIVE/MEASURING) var
  // olan anahtar kelime sayılır. Havuz fikirleri existingKeywords'e girmez:
  // girseydi eşleşen aday kapı sayfası korumasında elenir, fikir hiç
  // tüketilemezdi.
  const seoIdeas = ideaRows.filter(
    (row) =>
      row.isMock === link.isMock &&
      row.concept?.module === "seo" &&
      !ignoredIdeas.has(row.id),
  );
  const plannedStatuses: readonly string[] = IDEA_PLANNED_STATUSES;
  const poolStatuses: readonly string[] = IDEA_POOL_STATUSES;
  const plannedKeywords: string[] = [];
  const poolIdeas: PoolIdeaRef[] = [];
  for (const row of seoIdeas) {
    const concept = row.concept;
    if (concept?.module !== "seo") continue;
    if (plannedStatuses.includes(row.status)) {
      plannedKeywords.push(concept.draft.keyword);
    } else if (poolStatuses.includes(row.status) && !isExpired(concept, now)) {
      if (poolIdeas.length >= POOL_IDEAS_MAX) continue;
      poolIdeas.push({
        id: row.id,
        keyword: concept.draft.keyword,
        title: concept.draft.title,
        angle: concept.draft.angle,
        description: concept.draft.description,
        intent: intentOf(concept.draft.intent),
      });
    }
  }

  const crawlTitles = (snapshot.crawl?.pages ?? []).flatMap((page) => [
    ...(page.title ? [page.title] : []),
    ...page.h1,
  ]);
  const existingTitles = [
    ...new Set([...posts.map((post) => post.topic), ...crawlTitles]),
  ];
  const existingKeywords = [
    ...new Set([...plannedKeywords, ...earlierSlotKeywords]),
  ];

  const planInput = planInputFromSnapshot(snapshot, {
    month,
    findings,
    existingTitles,
    existingKeywords,
    poolIdeas,
    rejectedKeys,
    deprioritizedKeys: [],
  });

  const counted = pieces.filter((piece) => !ignoredCreatives.has(piece.id));
  const takenDates = [
    ...new Set(
      counted
        .map((piece) =>
          piece.scheduledFor
            ? dayKeyInTimezone(piece.scheduledFor, timezone)
            : null,
        )
        .filter((day): day is string => day !== null),
    ),
  ].sort();

  return {
    ok: true,
    input: planInput,
    link,
    scope,
    existingInMonth: counted.length,
    takenDates,
    language: snapshot.projectLanguage ?? null,
  };
}
