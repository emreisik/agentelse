import "server-only";

import type { GscSiteLink, Prisma } from "@prisma/client";

import { prisma } from "@/lib/prisma";
import { isFuzzyBrandQuery } from "@/lib/seo/brand-fuzzy";
import {
  effectiveBrandTerms,
  parseBrandTermsConfig,
} from "@/lib/seo/brand-terms";
import { fitCtrCurve } from "@/lib/seo/ctr-curve";
import { addWeeks } from "@/lib/seo/dates";
import type { SeoMetric } from "@/lib/seo/opportunity-types";

import { pairCoveredWeeks } from "./snapshot";
import type { SeoCurves } from "./state";

// Siteye özgü CTR eğrisi (docs/search-opportunities.md "CTR eğrisi"): son 13
// tam haftanın query_page özeti olan haftalarından, sorgu × sayfa başına
// toplanmış satırlar. Marka dışı = GscQuery.isBrand false ve bulanık marka
// eşleşmesi yok; geri kalanı marka eğrisine gider. Eğri ve haftası motor
// durumuna yazılır.

const HISTORY_WEEKS = 13;
const PAIR_LIMIT = 100_000;

type PairSqlRow = {
  text: string;
  isBrand: boolean;
  clicks: bigint | number | null;
  impressions: bigint | number | null;
  positionWeighted: number | null;
};

export async function fitAndStoreCurves(input: {
  link: Pick<GscSiteLink, "id" | "brandTerms">;
  stateId: string;
  week: string;
  now: Date;
}): Promise<SeoCurves> {
  const { link, week } = input;
  const weeks = await pairCoveredWeeks(
    link.id,
    addWeeks(week, -(HISTORY_WEEKS - 1)),
    week,
  );
  const rows =
    weeks.length === 0
      ? []
      : await prisma.$queryRaw<PairSqlRow[]>`
          SELECT q."text" AS "text",
                 q."isBrand" AS "isBrand",
                 SUM(p."clicks")::bigint AS "clicks",
                 SUM(p."impressions")::bigint AS "impressions",
                 SUM(p."positionWeighted")::float8 AS "positionWeighted"
            FROM "GscWeeklyQueryPage" p
            JOIN "GscQuery" q ON q."id" = p."queryId"
           WHERE p."linkId" = ${link.id}
             AND p."weekStart" = ANY(${weeks}::date[])
           GROUP BY p."queryId", p."pageId", q."text", q."isBrand"
           ORDER BY "impressions" DESC
           LIMIT ${PAIR_LIMIT}
        `;
  const terms = effectiveBrandTerms(parseBrandTermsConfig(link.brandTerms));
  const nonBrand: SeoMetric[] = [];
  const brand: SeoMetric[] = [];
  for (const row of rows) {
    const metric: SeoMetric = {
      clicks: Number(row.clicks ?? 0),
      impressions: Number(row.impressions ?? 0),
      positionWeighted: Number(row.positionWeighted ?? 0),
    };
    if (row.isBrand || isFuzzyBrandQuery(row.text, terms)) brand.push(metric);
    else nonBrand.push(metric);
  }
  const fittedAt = input.now.toISOString();
  const curves: SeoCurves = {
    nonBrand: fitCtrCurve(nonBrand, "non-brand", fittedAt),
    brand: fitCtrCurve(brand, "brand", fittedAt),
  };
  await prisma.seoEngineState.update({
    where: { id: input.stateId },
    data: {
      curves: curves as unknown as Prisma.InputJsonValue,
      curvesWeek: week,
    },
  });
  return curves;
}
