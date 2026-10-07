import "server-only";

import { Prisma } from "@prisma/client";

import { prisma } from "@/lib/prisma";
import {
  controlBasis,
  type PageSeries,
  type WeekMetric,
} from "@/lib/seo/actions/did";
import { isSeoFixKind } from "@/lib/seo/actions/kinds";
import {
  dayInRange,
  queryBounds,
  yearAgoWeeks,
  type EvaluationWindows,
} from "@/lib/seo/actions/windows";
import type { DidMetric, SeoActionView } from "@/lib/seo/actions/types";
import { parseProposal } from "@/lib/seo/actions/types";
import { dateToDayKey, dayKeyToDate } from "@/lib/seo/dates";
import { normalizePageUrl } from "@/lib/seo/normalize";
import { readPeriodCoverage } from "@/server/seo/store";

// Eylem değerlendirmesinin ambar okuması (docs/search-actions.md
// "Değerlendirme"): işlenen sayfanın, aynı gruptan kontrol adaylarının ve
// geçen yılın haftalık serileri GscWeeklyPage'den okunur. Google'a gitmez ve
// bayrak denetlemez (çağıran koşucu denetler). Sayfa eşlemesi yalnız GscPage
// kimliği ve normalizePageUrl().hash (= GscPage.urlHash) iledir; tarayıcının
// targetUrlHash'i (crawlUrlHash) bu anahtarla KARŞILAŞTIRILMAZ.

export type ActionSeries = {
  linkId: string;
  lastWeeklyWeek: string | null;
  treated: PageSeries[];
  treatedYearAgo: PageSeries[];
  candidates: PageSeries[];
  excluded: Set<string>;
  coveredWeeks: Set<string>;
  yearAgoCovered: boolean;
  truncated: boolean;
  pageGroup: string | null;
  overlappingChange: boolean;
};

// Aday havuzu üst sınırı ve grup yeterlilik eşiği (§6.4).
export const CANDIDATE_LIMIT = 300;
export const MIN_GROUP_CANDIDATES = 4;
// Aday sayfa kendi haftalarının en az yarısında gösterim almış olmalı.
const BAND_LOW = 0.5;
const BAND_HIGH = 1.5;
// Eylem ve tarayıcı sorgularında üst sınır (koruyucu).
const OTHER_ACTIONS_LIMIT = 500;
const CRAWLED_PAGES_LIMIT = 2000;
const CRITICAL_KEYS = ["title", "canonical", "noindex", "status"] as const;

type WeeklyRow = {
  pageId: string;
  weekStart: Date;
  clicks: number;
  impressions: number;
  positionWeighted: number;
};

function seriesOf(
  rows: readonly WeeklyRow[],
  pageIds: readonly string[],
): PageSeries[] {
  const byPage = new Map<string, WeekMetric[]>();
  for (const row of rows) {
    const list = byPage.get(row.pageId) ?? [];
    list.push({
      weekStart: dateToDayKey(row.weekStart),
      clicks: row.clicks,
      impressions: row.impressions,
      positionWeighted: row.positionWeighted,
    });
    byPage.set(row.pageId, list);
  }
  return pageIds.flatMap((pageId) => {
    const weeks = byPage.get(pageId);
    if (!weeks) return [];
    weeks.sort((left, right) => left.weekStart.localeCompare(right.weekStart));
    return [{ pageId, weeks }];
  });
}

async function weeklyRows(
  linkId: string,
  pageIds: readonly string[],
  weekFilter: Prisma.GscWeeklyPageWhereInput["weekStart"],
): Promise<WeeklyRow[]> {
  if (pageIds.length === 0) return [];
  return prisma.gscWeeklyPage.findMany({
    where: { linkId, pageId: { in: [...pageIds] }, weekStart: weekFilter },
    select: {
      pageId: true,
      weekStart: true,
      clicks: true,
      impressions: true,
      positionWeighted: true,
    },
  });
}

function hashOf(url: string | null | undefined): string | null {
  return url ? (normalizePageUrl(url)?.hash ?? null) : null;
}

// Bir eylemin dokunduğu sayfa adresleri: hedef, (CONSOLIDATE için) birleşen
// ve kalan sayfalar.
function urlsOf(
  targetUrl: string | null,
  proposal: ReturnType<typeof parseProposal>,
): string[] {
  const urls: string[] = targetUrl ? [targetUrl] : [];
  if (proposal && proposal.kind === "CONSOLIDATE") {
    urls.push(...proposal.from, proposal.to);
  }
  return urls;
}

function criticalChange(
  page: {
    title: string | null;
    canonical: string | null;
    noindex: boolean;
    status: number | null;
  },
  previous: unknown,
): boolean {
  if (!previous || typeof previous !== "object" || Array.isArray(previous)) {
    return false;
  }
  const before = previous as Record<string, unknown>;
  return CRITICAL_KEYS.some(
    (key) => key in before && (before[key] ?? null) !== (page[key] ?? null),
  );
}

type PageLookup = { id: string; urlHash: string; pageGroup: string | null };

async function lookupPages(
  linkId: string,
  ids: ReadonlySet<string>,
  hashes: ReadonlySet<string>,
): Promise<PageLookup[]> {
  const or: Prisma.GscPageWhereInput[] = [];
  if (ids.size > 0) or.push({ id: { in: [...ids] } });
  if (hashes.size > 0) or.push({ urlHash: { in: [...hashes] } });
  if (or.length === 0) return [];
  return prisma.gscPage.findMany({
    where: { linkId, OR: or },
    select: { id: true, urlHash: true, pageGroup: true },
  });
}

// Aynı pencerede başka eyleme ya da kritik sayfa değişikliğine uğrayan
// sayfalar (kontrol dışı) ve işlenen sayfayla çakışan başka eylem var mı.
async function changedPages(input: {
  action: SeoActionView;
  linkId: string;
  windows: EvaluationWindows;
  treatedIds: ReadonlySet<string>;
}): Promise<{ excluded: Set<string>; overlappingChange: boolean }> {
  const { action, windows } = input;
  const bounds = queryBounds(windows.windowFrom, windows.overlapTo);

  // Sağlık-uyarısı eylemleri hiçbir zaman dışlamaz ya da çakışma saymaz.
  const others = (
    await prisma.seoAction.findMany({
      where: {
        projectId: action.projectId,
        isMock: action.isMock,
        source: { not: "HEALTH_ISSUE" },
        id: { not: action.id },
        appliedAt: { gte: bounds.gte, lt: bounds.lt },
      },
      select: {
        kind: true,
        pageId: true,
        targetUrl: true,
        proposal: true,
        appliedAt: true,
      },
      take: OTHER_ACTIONS_LIMIT,
    })
  ).filter(
    (row) =>
      row.appliedAt !== null &&
      dayInRange(row.appliedAt, windows.windowFrom, windows.overlapTo),
  );

  const crawled: { url: string }[] = [];
  const site = await prisma.seoSite.findUnique({
    where: {
      projectId_isMock: {
        projectId: action.projectId,
        isMock: action.isMock,
      },
    },
    select: { id: true },
  });
  if (site) {
    const pages = await prisma.seoPage.findMany({
      where: {
        siteId: site.id,
        lastChangedAt: { gte: bounds.gte, lt: bounds.lt },
      },
      select: {
        url: true,
        title: true,
        canonical: true,
        noindex: true,
        status: true,
        previous: true,
        lastChangedAt: true,
        firstSeenAt: true,
      },
      take: CRAWLED_PAGES_LIMIT,
    });
    for (const page of pages) {
      if (!page.lastChangedAt) continue;
      if (
        !dayInRange(page.lastChangedAt, windows.windowFrom, windows.overlapTo)
      ) {
        continue;
      }
      // İlk görülme ve metin değişimleri dışlamaz: yalnız ilk görülmeden en
      // az 1 gün sonra olan kritik alan değişimi.
      if (
        page.lastChangedAt.getTime() <=
        page.firstSeenAt.getTime() + 86_400_000
      ) {
        continue;
      }
      if (!criticalChange(page, page.previous)) continue;
      crawled.push({ url: page.url });
    }
  }

  const ids = new Set<string>();
  const hashes = new Set<string>();
  const perAction = others.map((row) => {
    const proposal = isSeoFixKind(row.kind)
      ? parseProposal(row.proposal, row.kind)
      : null;
    const rowHashes = urlsOf(row.targetUrl, proposal)
      .map(hashOf)
      .filter((hash): hash is string => hash !== null);
    if (row.pageId) ids.add(row.pageId);
    for (const hash of rowHashes) hashes.add(hash);
    return {
      pageId: row.pageId,
      hashes: rowHashes,
      appliedAt: row.appliedAt as Date,
    };
  });
  const crawledHashes = crawled
    .map((page) => hashOf(page.url))
    .filter((hash): hash is string => hash !== null);
  for (const hash of crawledHashes) hashes.add(hash);

  const pages = await lookupPages(input.linkId, ids, hashes);
  const idByHash = new Map(pages.map((page) => [page.urlHash, page.id]));

  const excluded = new Set<string>();
  let overlappingChange = false;
  for (const row of perAction) {
    const touched = new Set<string>();
    if (row.pageId) touched.add(row.pageId);
    for (const hash of row.hashes) {
      const id = idByHash.get(hash);
      if (id) touched.add(id);
    }
    for (const id of touched) excluded.add(id);
    if (
      !overlappingChange &&
      dayInRange(row.appliedAt, windows.overlapFrom, windows.overlapTo) &&
      [...touched].some((id) => input.treatedIds.has(id))
    ) {
      overlappingChange = true;
    }
  }
  for (const hash of crawledHashes) {
    const id = idByHash.get(hash);
    if (id) excluded.add(id);
  }
  // Kontrol dışı kümesi yalnız aday sayfaları anlatır.
  for (const id of input.treatedIds) excluded.delete(id);
  return { excluded, overlappingChange };
}

async function candidateIds(input: {
  linkId: string;
  preWeeks: readonly string[];
  skipIds: readonly string[];
  group: string | null;
  metric: DidMetric;
  basis: number;
}): Promise<string[]> {
  const { preWeeks } = input;
  const minWeeks = Math.ceil(preWeeks.length / 2);
  const basisSql =
    input.metric === "impressions"
      ? Prisma.sql`w."impressions"`
      : Prisma.sql`w."clicks"`;
  const groupSql = input.group
    ? Prisma.sql`AND p."pageGroup" = ${input.group}`
    : Prisma.empty;
  // ±%50 bandı SQL'de uygulanır: ilk 300 kesimi bandın içindeki tüm
  // kontrolleri düşürmesin. Taban 0 ise bant anlamsızdır, gösterime göre sırala.
  const banded = input.basis > 0;
  const bandSql = banded
    ? Prisma.sql`AND SUM(${basisSql})::float8 BETWEEN ${input.basis * BAND_LOW}::float8 AND ${input.basis * BAND_HIGH}::float8`
    : Prisma.empty;
  const orderSql = banded
    ? Prisma.sql`ABS(LN((SUM(${basisSql}) + 1)::float8 / ${input.basis + 1}::float8)) ASC`
    : Prisma.sql`SUM(w."impressions") DESC`;
  const rows = await prisma.$queryRaw<{ pageId: string }[]>`
    SELECT w."pageId" AS "pageId"
      FROM "GscWeeklyPage" w
      JOIN "GscPage" p ON p."id" = w."pageId"
     WHERE w."linkId" = ${input.linkId}
       AND w."weekStart" = ANY(${[...preWeeks]}::date[])
       AND NOT (w."pageId" = ANY(${[...input.skipIds]}::text[]))
       ${groupSql}
     GROUP BY w."pageId"
    HAVING COUNT(*) FILTER (WHERE w."impressions" > 0) >= ${minWeeks}::int
       ${bandSql}
     ORDER BY ${orderSql}, w."pageId" ASC
     LIMIT ${CANDIDATE_LIMIT}
  `;
  return rows.map((row) => row.pageId);
}

export async function loadActionSeries(input: {
  action: SeoActionView;
  windows: EvaluationWindows;
  metric: DidMetric;
  // Yalnız işlenen sayfa gerekiyorsa (lansman kuralı): aday, dışlama ve
  // geçen yıl okunmaz.
  treatedOnly?: boolean;
}): Promise<ActionSeries | { missing: "NO_LINK" | "NO_PAGE" }> {
  const { action, windows, metric } = input;
  if (!action.linkId) return { missing: "NO_LINK" };
  const link = await prisma.gscSiteLink.findUnique({
    where: { id: action.linkId },
    select: { id: true, lastWeeklyWeek: true },
  });
  if (!link) return { missing: "NO_LINK" };
  const linkId = link.id;

  // İşlenen sayfalar: pageId ∪ hedef adres özeti ∪ CONSOLIDATE sayfaları.
  const hashes = new Set<string>();
  for (const url of urlsOf(action.targetUrl, action.proposal)) {
    const hash = hashOf(url);
    if (hash) hashes.add(hash);
  }
  const treatedPages = await lookupPages(
    linkId,
    new Set(action.pageId ? [action.pageId] : []),
    hashes,
  );
  if (treatedPages.length === 0) return { missing: "NO_PAGE" };
  const treatedIds = [...new Set(treatedPages.map((page) => page.id))].sort();
  const treatedSet = new Set(treatedIds);

  // Birincil hedefin grubu: pageId öncelikli, yoksa ilk eşleşen sayfa.
  const primary =
    treatedPages.find((page) => page.id === action.pageId) ?? treatedPages[0]!;
  const pageGroup = primary.pageGroup ?? null;

  const windowRange = {
    gte: dayKeyToDate(windows.windowFrom),
    lte: dayKeyToDate(windows.lastNeededWeek),
  };
  const treated = seriesOf(
    await weeklyRows(linkId, treatedIds, windowRange),
    treatedIds,
  );

  let excluded = new Set<string>();
  let overlappingChange = false;
  let candidates: PageSeries[] = [];
  if (!input.treatedOnly) {
    const changed = await changedPages({
      action,
      linkId,
      windows,
      treatedIds: treatedSet,
    });
    excluded = changed.excluded;
    overlappingChange = changed.overlappingChange;

    const basis = treated.reduce(
      (sum, series) => sum + controlBasis(series, windows.preWeeks, metric),
      0,
    );
    const skipIds = [...treatedIds, ...excluded];
    const base = {
      linkId,
      preWeeks: windows.preWeeks,
      skipIds,
      metric,
      basis,
    };
    // Önce aynı grup; bant içinde 4'ten az aday varsa sitenin tüm sayfaları.
    let ids = pageGroup
      ? await candidateIds({ ...base, group: pageGroup })
      : [];
    if (!pageGroup || ids.length < MIN_GROUP_CANDIDATES) {
      ids = await candidateIds({ ...base, group: null });
    }
    candidates = seriesOf(await weeklyRows(linkId, ids, windowRange), ids);
  }

  const coverage = await readPeriodCoverage(
    linkId,
    "WEEK",
    "page",
    windows.windowFrom,
    windows.lastNeededWeek,
  );

  let treatedYearAgo: PageSeries[] = [];
  let yearAgoCovered = false;
  if (!input.treatedOnly) {
    const yearAgo = yearAgoWeeks([...windows.preWeeks, ...windows.postWeeks]);
    if (yearAgo.length > 0) {
      const sorted = [...yearAgo].sort();
      const yearAgoCoverage = await readPeriodCoverage(
        linkId,
        "WEEK",
        "page",
        sorted[0]!,
        sorted[sorted.length - 1]!,
      );
      const have = new Set(yearAgoCoverage.periods);
      yearAgoCovered = yearAgo.every((week) => have.has(week));
      treatedYearAgo = seriesOf(
        await weeklyRows(linkId, treatedIds, {
          in: yearAgo.map((week) => dayKeyToDate(week)),
        }),
        treatedIds,
      );
    }
  }

  return {
    linkId,
    lastWeeklyWeek: link.lastWeeklyWeek ?? null,
    treated,
    treatedYearAgo,
    candidates,
    excluded,
    coveredWeeks: new Set(coverage.periods),
    yearAgoCovered,
    truncated: coverage.truncated,
    pageGroup,
    overlappingChange,
  };
}
