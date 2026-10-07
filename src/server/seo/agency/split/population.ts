import "server-only";

import { Prisma } from "@prisma/client";

import { prisma } from "@/lib/prisma";
import {
  SPLIT_MAX_PAGES,
  type SplitCandidate,
} from "@/lib/seo/agency/split/assign";
import { OPEN_SPLIT_STATUSES } from "@/lib/seo/agency/split/types";
import { dayKeyToDate } from "@/lib/seo/dates";
import { seoMockMode } from "@/lib/seo/health-flags";
import { parseStoredScope } from "@/server/seo/site/scope";
import { readPeriodCoverage } from "@/server/seo/store";

// Bölünmüş testin nüfus okuyucuları (docs/search-agency.md): ambardan
// (GscWeeklyPage + GscPage) önceki 8 haftanın sayfa özeti ve açık testlere ya
// da açık SEO eylemlerine ayrılmış sayfalar. Google'a gitmez; bayrak
// denetlemez (çağıran depo denetler).

const OPEN_ACTION_STATUSES = ["ACCEPTED", "APPLIED", "VERIFIED", "EVALUATING"];
const OPEN_PAGES_LIMIT = 20_000;
const OPEN_ACTIONS_LIMIT = 5_000;

type PopulationRow = {
  pageId: string;
  pageGroup: string;
  clicks: number;
  impressions: number;
};

export async function readPopulation(input: {
  linkId: string;
  pageGroups: readonly string[];
  preWeeks: readonly string[];
  excludePageIds?: ReadonlySet<string>;
}): Promise<{
  candidates: SplitCandidate[];
  coveredWeeks: number;
  totalPages: number;
  capped: boolean;
}> {
  const { linkId, pageGroups, preWeeks } = input;
  if (pageGroups.length === 0 || preWeeks.length === 0) {
    return { candidates: [], coveredWeeks: 0, totalPages: 0, capped: false };
  }
  const exclude = [...(input.excludePageIds ?? [])];
  const weeks = preWeeks.map((week) => dayKeyToDate(week));
  const excludeSql =
    exclude.length > 0
      ? Prisma.sql`AND NOT (p."id" = ANY(${exclude}::text[]))`
      : Prisma.empty;
  // Tek sorgu: sayfa başına önceki haftaların toplamı. Toplamlar float8'e
  // çevrilir (bigint JS'te BigInt döner). LIMIT cap+1: sınırın aşıldığı bilinir.
  const rows = await prisma.$queryRaw<PopulationRow[]>`
    SELECT p."id" AS "pageId",
           p."pageGroup" AS "pageGroup",
           SUM(w."clicks")::float8 AS "clicks",
           SUM(w."impressions")::float8 AS "impressions"
      FROM "GscWeeklyPage" w
      JOIN "GscPage" p ON p."id" = w."pageId"
     WHERE w."linkId" = ${linkId}
       AND p."linkId" = ${linkId}
       AND p."pageGroup" = ANY(${[...pageGroups]}::text[])
       AND w."weekStart" = ANY(${weeks}::date[])
       ${excludeSql}
     GROUP BY p."id", p."pageGroup"
    HAVING SUM(w."impressions") > 0
     ORDER BY "clicks" DESC, p."id" ASC
     LIMIT ${SPLIT_MAX_PAGES + 1}
  `;
  const capped = rows.length > SPLIT_MAX_PAGES;
  const candidates = rows.slice(0, SPLIT_MAX_PAGES).map((row) => ({
    pageId: row.pageId,
    group: row.pageGroup,
    preClicks: Number(row.clicks),
    preImpressions: Number(row.impressions),
  }));

  const sorted = [...preWeeks].sort();
  const coverage = await readPeriodCoverage(
    linkId,
    "WEEK",
    "page",
    sorted[0]!,
    sorted[sorted.length - 1]!,
  );
  const wanted = new Set(preWeeks);
  const coveredWeeks = coverage.periods.filter((week) =>
    wanted.has(week),
  ).length;
  return { candidates, coveredWeeks, totalPages: candidates.length, capped };
}

// Bir sitenin açık testlerine ve açık SEO eylemlerine ayrılmış sayfa kimlikleri.
// Eylem tarafı en iyi çabayladır: okunamazsa yalnız testler sayılır.
export async function openPageIds(input: {
  projectId: string;
  linkId: string;
  isMock: boolean;
}): Promise<Set<string>> {
  const ids = new Set<string>();
  const assigned = await prisma.gscSplitTestPage.findMany({
    where: {
      linkId: input.linkId,
      test: { status: { in: [...OPEN_SPLIT_STATUSES] }, isMock: input.isMock },
    },
    select: { pageId: true },
    take: OPEN_PAGES_LIMIT,
  });
  for (const row of assigned) ids.add(row.pageId);
  try {
    const actions = await prisma.seoAction.findMany({
      where: {
        projectId: input.projectId,
        isMock: input.isMock,
        status: { in: OPEN_ACTION_STATUSES },
        source: { not: "HEALTH_ISSUE" },
        pageId: { not: null },
      },
      select: { pageId: true },
      take: OPEN_ACTIONS_LIMIT,
    });
    for (const row of actions) if (row.pageId) ids.add(row.pageId);
  } catch {
    console.warn("[gsc-split] open actions could not be read");
  }
  return ids;
}

export type SplitSiteScope = { siteId: string; hosts: string[] };

function hostOf(url: string): string | null {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return null;
  }
}

// Projenin tarama kapsamı: sayfa adresinin sitenin kendi alan adına ait olup
// olmadığı bu kökenlerle (sameSite) sayfa başına denetlenir. SeoSite yok ya da
// kapsamı yoksa null: tarayıcı doğrulaması ve CMS yolu kapalıdır.
export async function splitSiteScope(
  projectId: string,
): Promise<SplitSiteScope | null> {
  const site = await prisma.seoSite.findUnique({
    where: { projectId_isMock: { projectId, isMock: seoMockMode() } },
    select: { id: true, origin: true, scope: true },
  });
  if (!site || !site.origin) return null;
  const scope = parseStoredScope(site.scope);
  if (!scope) return null;
  const hosts = new Set<string>();
  const origin = hostOf(site.origin);
  if (origin) hosts.add(origin);
  hosts.add(scope.root.toLowerCase());
  return { siteId: site.id, hosts: [...hosts] };
}
