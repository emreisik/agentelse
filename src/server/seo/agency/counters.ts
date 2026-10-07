import "server-only";

import { gscAgencyOn } from "@/lib/seo/agency/flags";
import type { GscAgencyCounters } from "@/lib/seo/agency/types";
import { prisma } from "@/lib/prisma";
import { gscMockMode } from "@/server/integrations/search-console/search-analytics";
import { loadShareCounters } from "@/server/report-share/counters";
import { loadBqCounters } from "@/server/seo/agency/bq/counters";
import { loadSplitCounters } from "@/server/seo/agency/split/counters";

// Operatör sayaçları (SC-F9): yalnız sayılar, ad ya da URL yok. Bayrak kapalıyken
// null ve veritabanına gidilmez. Her parça kendi hatasında null (ya da 0) olur;
// biri çökerse diğerleri yine görünür.
export async function loadGscAgencyCounters(
  now: Date = new Date(),
): Promise<GscAgencyCounters | null> {
  if (!gscAgencyOn()) return null;
  const mock = gscMockMode();
  const [extraSites, pageGroupRuleSets, bigQuery, splitTests, shares] =
    await Promise.all([
      prisma.gscSiteLink
        .count({ where: { isSecondary: true, isMock: mock } })
        .catch(() => 0),
      prisma
        .$queryRaw<{ count: bigint }[]>`
          SELECT COUNT(*) AS "count"
            FROM "GscSiteSetting"
           WHERE "isMock" = ${mock}
             AND "rulesVersion" > 0
             AND jsonb_array_length(COALESCE("pageGroupRules"->'rules', '[]'::jsonb)) > 0
        `
        .then((rows) => Number(rows[0]?.count ?? 0))
        .catch(() => 0),
      loadBqCounters(now).catch(() => null),
      loadSplitCounters(now).catch(() => null),
      loadShareCounters(now).catch(() => null),
    ]);
  return { extraSites, pageGroupRuleSets, bigQuery, splitTests, shares };
}
