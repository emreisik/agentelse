import "server-only";

import { Prisma, type GscSiteLink } from "@prisma/client";

import { prisma } from "@/lib/prisma";
import { isFuzzyBrandQuery } from "@/lib/seo/brand-fuzzy";
import {
  effectiveBrandTerms,
  parseBrandTermsConfig,
} from "@/lib/seo/brand-terms";
import {
  CLUSTER_MAX_QUERIES,
  buildClusters,
  matchClusters,
  type BuiltCluster,
  type ClusterQueryInput,
} from "@/lib/seo/clusters";
import { addWeeks } from "@/lib/seo/dates";
import type { ClusterInfo } from "@/lib/seo/opportunity-types";
import { decodeVector } from "@/lib/seo/vector";
import { maskGoogleText } from "@/server/integrations/google/pii";
import {
  SEO_CLUSTER_NAME_CLUSTERS,
  SEO_CLUSTER_NAME_QUERIES,
  seoClusterNamesDef,
} from "@/server/reasoning/prompts/seo-cluster-names";
import { ReasoningService } from "@/server/reasoning/reasoning-service";
import { AgentelseError } from "@/server/security/errors";

import type { SeoScope } from "./classify";
import { pairCoveredWeeks } from "./snapshot";

// Konu kümeleri (docs/search-opportunities.md "Konu kümeleri"): marka dışı ve
// 13 haftada ≥ 10 gösterim alan sorgular (≤ 2.000); aynı sayfada birlikte
// sıralanma (query_page özeti olan haftalardan) + embedding benzerliği.
// Jaccard ≥ 0,5 eşleşen eski küme kimliğini ve adını korur; yenilerin adı
// önce en çok gösterim alan sorgudur (TOP_QUERY), en çok 30 yeni küme lite
// LLM'den ad alır (çağrı başına 6 küme × 3 maskelenmiş sorgu). Eşleşmeyen
// eski kümeler STALE olur. Üyelik GscQuery.clusterId'dedir ve tek
// transaction'da yeniden yazılır.

const HISTORY_WEEKS = 13;
const CURRENT_WEEKS = 4;
const MIN_IMPRESSIONS = 10;
const NAMED_CLUSTERS_MAX = 30;
const NAME_MAX_LENGTH = 60;
const TOP_QUERY_IDS = 10;
const UPDATE_CHUNK = 500;
const TX_TIMEOUT_MS = 30_000;

type InputSqlRow = {
  id: string;
  text: string;
  impressions: bigint | number | null;
  clicks: bigint | number | null;
  impressions28d: bigint | number | null;
  clicks28d: bigint | number | null;
  vector: Uint8Array | null;
  dims: number | null;
};

type QueryFacts = {
  text: string;
  impressions: number;
  impressions28d: number;
  clicks28d: number;
};

function chunks<T>(items: readonly T[], size: number): T[][] {
  const result: T[][] = [];
  for (let start = 0; start < items.length; start += size) {
    result.push(items.slice(start, start + size));
  }
  return result;
}

// Adın her rakam dizisi kümenin sorgularından birinde geçmeli.
export function clusterNameAllowed(
  name: string,
  queries: readonly string[],
): boolean {
  const digits = name.match(/\d+/g) ?? [];
  return digits.every((run) => queries.some((query) => query.includes(run)));
}

function cleanName(name: string): string {
  return name.replace(/\s+/g, " ").trim().slice(0, NAME_MAX_LENGTH).trim();
}

function isBudgetError(error: unknown): boolean {
  return error instanceof AgentelseError && error.code === "BUDGET_EXCEEDED";
}

async function readInputs(
  linkId: string,
  week: string,
  terms: readonly string[],
): Promise<{ inputs: ClusterQueryInput[]; facts: Map<string, QueryFacts> }> {
  const from = addWeeks(week, -(HISTORY_WEEKS - 1));
  const currentFrom = addWeeks(week, -(CURRENT_WEEKS - 1));
  const rows = await prisma.$queryRaw<InputSqlRow[]>`
    SELECT q."id", q."text",
           SUM(w."impressions")::bigint AS "impressions",
           SUM(w."clicks")::bigint AS "clicks",
           SUM(CASE WHEN w."weekStart" >= ${currentFrom}::date THEN w."impressions" ELSE 0 END)::bigint AS "impressions28d",
           SUM(CASE WHEN w."weekStart" >= ${currentFrom}::date THEN w."clicks" ELSE 0 END)::bigint AS "clicks28d",
           e."vector" AS "vector",
           e."dims" AS "dims"
      FROM "GscQuery" q
      JOIN "GscWeeklyQuery" w ON w."queryId" = q."id"
      LEFT JOIN "SeoQueryEmbedding" e ON e."queryId" = q."id"
     WHERE q."linkId" = ${linkId}
       AND q."isBrand" = false
       AND w."weekStart" BETWEEN ${from}::date AND ${week}::date
     GROUP BY q."id", e."vector", e."dims"
    HAVING SUM(w."impressions") >= ${MIN_IMPRESSIONS}
     ORDER BY "impressions" DESC, q."id" ASC
     LIMIT ${CLUSTER_MAX_QUERIES}
  `;
  const kept = rows.filter((row) => !isFuzzyBrandQuery(row.text, terms));
  const ids = kept.map((row) => row.id);

  // En güçlü sayfa ve payı: yalnız query_page özeti olan haftalar; pay
  // GscWeeklyQuery'nin aynı haftalarına bölünür (çiftlerin toplamına değil).
  const weeks = await pairCoveredWeeks(linkId, from, week);
  const top = new Map<string, { pageId: string; impressions: number }>();
  const pairWeekQ = new Map<string, number>();
  if (weeks.length > 0 && ids.length > 0) {
    const [pairs, totals] = await Promise.all([
      prisma.$queryRaw<
        { queryId: string; pageId: string; impressions: bigint | number }[]
      >`
        SELECT "queryId", "pageId", SUM("impressions")::bigint AS "impressions"
          FROM "GscWeeklyQueryPage"
         WHERE "linkId" = ${linkId}
           AND "weekStart" = ANY(${weeks}::date[])
           AND "queryId" = ANY(${ids}::text[])
         GROUP BY "queryId", "pageId"
      `,
      prisma.$queryRaw<{ queryId: string; impressions: bigint | number }[]>`
        SELECT "queryId", SUM("impressions")::bigint AS "impressions"
          FROM "GscWeeklyQuery"
         WHERE "linkId" = ${linkId}
           AND "weekStart" = ANY(${weeks}::date[])
           AND "queryId" = ANY(${ids}::text[])
         GROUP BY "queryId"
      `,
    ]);
    for (const row of totals) {
      pairWeekQ.set(row.queryId, Number(row.impressions));
    }
    for (const row of pairs) {
      const impressions = Number(row.impressions);
      const best = top.get(row.queryId);
      if (
        !best ||
        impressions > best.impressions ||
        (impressions === best.impressions && row.pageId < best.pageId)
      ) {
        top.set(row.queryId, { pageId: row.pageId, impressions });
      }
    }
  }

  const facts = new Map<string, QueryFacts>();
  const inputs = kept.map((row): ClusterQueryInput => {
    facts.set(row.id, {
      text: row.text,
      impressions: Number(row.impressions ?? 0),
      impressions28d: Number(row.impressions28d ?? 0),
      clicks28d: Number(row.clicks28d ?? 0),
    });
    const best = top.get(row.id);
    const q = pairWeekQ.get(row.id) ?? 0;
    return {
      queryId: row.id,
      impressions: Number(row.impressions ?? 0),
      clicks: Number(row.clicks ?? 0),
      topPageId: best?.pageId ?? null,
      topPageShare: best && q > 0 ? Math.min(1, best.impressions / q) : 0,
      vector:
        row.vector && row.dims ? decodeVector(row.vector, row.dims) : null,
    };
  });
  return { inputs, facts };
}

// Yeni kümelere LLM adı: ≤ 30 küme, çağrı başına 6 küme × 3 sorgu.
async function nameClusters(
  clusters: readonly BuiltCluster[],
  facts: ReadonlyMap<string, QueryFacts>,
  scope: SeoScope | null,
): Promise<{ names: Map<string, string>; budgetHit: boolean }> {
  const names = new Map<string, string>();
  if (!scope || clusters.length === 0 || ReasoningService.isMockMode()) {
    return { names, budgetHit: false };
  }
  const targets = [...clusters]
    .sort((a, b) => b.impressions - a.impressions)
    .slice(0, NAMED_CLUSTERS_MAX);
  for (const batch of chunks(targets, SEO_CLUSTER_NAME_CLUSTERS)) {
    const queriesOf = batch.map((cluster) =>
      cluster.queryIds
        .slice(0, SEO_CLUSTER_NAME_QUERIES)
        .map((id) => maskGoogleText(facts.get(id)?.text ?? ""))
        .filter(Boolean),
    );
    try {
      const { output, isMock } = await ReasoningService.run(
        seoClusterNamesDef,
        {
          ...scope,
          context: { clusters: queriesOf.map((queries, i) => [i, queries]) },
        },
      );
      if (isMock) continue;
      for (const item of output.names) {
        const cluster = Number.isInteger(item.i) ? batch[item.i] : undefined;
        const queries = Number.isInteger(item.i)
          ? queriesOf[item.i]
          : undefined;
        if (!cluster || !queries) continue;
        const name = cleanName(item.name);
        if (!name || !clusterNameAllowed(name, queries)) continue;
        names.set(cluster.key, name);
      }
    } catch (error) {
      if (isBudgetError(error)) return { names, budgetHit: true };
      console.warn(
        "[seo-opportunities] cluster naming failed:",
        error instanceof Error ? error.name : "UnknownError",
      );
      return { names, budgetHit: false };
    }
  }
  return { names, budgetHit: false };
}

export async function refreshClusters(input: {
  link: Pick<GscSiteLink, "id" | "projectId" | "workspaceId">;
  scope: SeoScope | null;
  week: string;
  now: Date;
}): Promise<{ clusters: number; named: number; budgetHit: boolean }> {
  const { link, week } = input;
  const config = await prisma.gscSiteLink.findUnique({
    where: { id: link.id },
    select: { brandTerms: true },
  });
  const terms = effectiveBrandTerms(parseBrandTermsConfig(config?.brandTerms));
  const { inputs, facts } = await readInputs(link.id, week, terms);
  const built = buildClusters(inputs);

  const [active, members] = await Promise.all([
    prisma.seoCluster.findMany({
      where: { linkId: link.id, status: "ACTIVE" },
      select: { id: true },
    }),
    prisma.gscQuery.findMany({
      where: { linkId: link.id, clusterId: { not: null } },
      select: { id: true, clusterId: true },
    }),
  ]);
  const previousMembers = new Map<string, string[]>(
    active.map((cluster) => [cluster.id, []]),
  );
  for (const row of members) {
    if (row.clusterId) previousMembers.get(row.clusterId)?.push(row.id);
  }
  const matches = matchClusters(
    [...previousMembers.entries()].map(([id, queryIds]) => ({ id, queryIds })),
    built,
  );
  const fresh = built.filter((cluster) => !matches.has(cluster.key));
  const named = await nameClusters(fresh, facts, input.scope);
  const matchedIds = new Set(matches.values());
  const stale = active
    .map((cluster) => cluster.id)
    .filter((id) => !matchedIds.has(id));

  const totalsOf = (cluster: BuiltCluster) => {
    let impressions28d = 0;
    let clicks28d = 0;
    for (const id of cluster.queryIds) {
      impressions28d += facts.get(id)?.impressions28d ?? 0;
      clicks28d += facts.get(id)?.clicks28d ?? 0;
    }
    return {
      pillarPageId: cluster.pillarPageId,
      queryCount: cluster.queryIds.length,
      impressions28d,
      clicks28d,
      topQueryIds: cluster.queryIds.slice(0, TOP_QUERY_IDS),
      status: "ACTIVE",
      week,
    };
  };

  await prisma.$transaction(
    async (tx) => {
      const assignments: [string, string][] = [];
      for (const cluster of built) {
        const matched = matches.get(cluster.key);
        let clusterId: string;
        if (matched) {
          await tx.seoCluster.update({
            where: { id: matched },
            data: totalsOf(cluster),
          });
          clusterId = matched;
        } else {
          const llmName = named.names.get(cluster.key);
          const topText = facts.get(cluster.queryIds[0] ?? "")?.text ?? "";
          const created = await tx.seoCluster.create({
            data: {
              workspaceId: link.workspaceId,
              projectId: link.projectId,
              linkId: link.id,
              name: llmName ?? (cleanName(topText) || "Topic"),
              nameSource: llmName ? "LLM" : "TOP_QUERY",
              ...totalsOf(cluster),
            },
            select: { id: true },
          });
          clusterId = created.id;
        }
        for (const queryId of cluster.queryIds) {
          assignments.push([queryId, clusterId]);
        }
      }
      if (stale.length > 0) {
        await tx.seoCluster.updateMany({
          where: { id: { in: stale } },
          data: { status: "STALE" },
        });
      }
      await tx.gscQuery.updateMany({
        where: { linkId: link.id, clusterId: { not: null } },
        data: { clusterId: null },
      });
      for (const part of chunks(assignments, UPDATE_CHUNK)) {
        const values = part.map(
          ([queryId, clusterId]) =>
            Prisma.sql`(${queryId}::text, ${clusterId}::text)`,
        );
        await tx.$executeRaw`
          UPDATE "GscQuery" AS q
             SET "clusterId" = v."clusterId"
            FROM (VALUES ${Prisma.join(values)}) AS v("id", "clusterId")
           WHERE q."id" = v."id"
             AND q."linkId" = ${link.id}
        `;
      }
      await tx.seoEngineState.updateMany({
        where: { linkId: link.id },
        data: { clustersWeek: week },
      });
    },
    { timeout: TX_TIMEOUT_MS },
  );
  return {
    clusters: built.length,
    named: named.names.size,
    budgetHit: named.budgetHit,
  };
}

// Kurallar için ACTIVE kümeler ve üyeleri.
export async function readClusters(linkId: string): Promise<ClusterInfo[]> {
  const clusters = await prisma.seoCluster.findMany({
    where: { linkId, status: "ACTIVE" },
    orderBy: [{ impressions28d: "desc" }, { id: "asc" }],
    select: { id: true, name: true, pillarPageId: true },
  });
  if (clusters.length === 0) return [];
  const members = await prisma.gscQuery.findMany({
    where: { linkId, clusterId: { in: clusters.map((cluster) => cluster.id) } },
    select: { id: true, clusterId: true },
  });
  const byCluster = new Map<string, string[]>();
  for (const row of members) {
    if (!row.clusterId) continue;
    const list = byCluster.get(row.clusterId);
    if (list) list.push(row.id);
    else byCluster.set(row.clusterId, [row.id]);
  }
  return clusters.map((cluster) => ({
    clusterId: cluster.id,
    name: cluster.name,
    queryIds: byCluster.get(cluster.id) ?? [],
    pillarPageId: cluster.pillarPageId,
  }));
}
