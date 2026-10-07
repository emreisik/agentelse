import "server-only";

import { prisma } from "@/lib/prisma";
import type { PageSeries, WeekMetric } from "@/lib/seo/actions/did";
import { dateToDayKey, dayKeyToDate } from "@/lib/seo/dates";
import { readPeriodCoverage } from "@/server/seo/store";

// Bölünmüş test kollarının haftalık serileri (GscWeeklyPage). Google'a gitmez
// ve bayrak denetlemez (çağıran koşucu denetler). Kimlikler 1000'lik
// parçalarla okunur; verisi olmayan sayfa seriye girmez.

export const SERIES_CHUNK = 1000;

type WeeklyRow = {
  pageId: string;
  weekStart: Date;
  clicks: number;
  impressions: number;
  positionWeighted: number;
};

async function readArm(
  linkId: string,
  pageIds: readonly string[],
  weeks: readonly Date[],
): Promise<PageSeries[]> {
  const byPage = new Map<string, WeekMetric[]>();
  for (let offset = 0; offset < pageIds.length; offset += SERIES_CHUNK) {
    const chunk = pageIds.slice(offset, offset + SERIES_CHUNK);
    const rows: WeeklyRow[] = await prisma.gscWeeklyPage.findMany({
      where: { linkId, pageId: { in: chunk }, weekStart: { in: [...weeks] } },
      select: {
        pageId: true,
        weekStart: true,
        clicks: true,
        impressions: true,
        positionWeighted: true,
      },
    });
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
  }
  return pageIds.flatMap((pageId) => {
    const list = byPage.get(pageId);
    if (!list) return [];
    list.sort((left, right) => left.weekStart.localeCompare(right.weekStart));
    return [{ pageId, weeks: list }];
  });
}

export async function loadArmSeries(input: {
  linkId: string;
  testIds: readonly string[];
  controlIds: readonly string[];
  weeks: readonly string[];
}): Promise<{
  test: PageSeries[];
  control: PageSeries[];
  coveredWeeks: Set<string>;
  truncated: boolean;
}> {
  const { linkId, weeks } = input;
  if (weeks.length === 0) {
    return {
      test: [],
      control: [],
      coveredWeeks: new Set(),
      truncated: false,
    };
  }
  const sorted = [...weeks].sort();
  const dates = sorted.map((week) => dayKeyToDate(week));
  const test = await readArm(linkId, input.testIds, dates);
  const control = await readArm(linkId, input.controlIds, dates);
  const coverage = await readPeriodCoverage(
    linkId,
    "WEEK",
    "page",
    sorted[0]!,
    sorted[sorted.length - 1]!,
  );
  const wanted = new Set(weeks);
  return {
    test,
    control,
    coveredWeeks: new Set(coverage.periods.filter((week) => wanted.has(week))),
    truncated: coverage.truncated,
  };
}
