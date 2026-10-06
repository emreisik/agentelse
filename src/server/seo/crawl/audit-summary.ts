import "server-only";

import { Prisma } from "@prisma/client";

import {
  TA_CATALOG,
  type IssueSeverity,
  type TaCode,
} from "@/lib/seo/technical-audit";
import { prisma } from "@/lib/prisma";
import { keyPagesFor } from "@/server/seo/site/key-pages";
import { SeoSites } from "@/server/seo/site/sites";

// Teknik denetim özeti (panel ve sağlık kontrolleri için): taranan ve
// indekslenebilir sayfa sayıları, TA sorun grupları (önem, sonra sayı) ve
// kilit sayfaların son durumu. Yalnız kendi taramamızın verisi; Google
// verisi içermez.

export type AuditIssueGroup = {
  code: TaCode;
  title: string;
  severity: IssueSeverity;
  count: number;
  samples: string[];
};

export type AuditKeyPage = {
  url: string;
  urlHash: string;
  path: string;
  isHomepage: boolean;
  status: number | null;
  fetchError: string | null;
  finalUrl: string | null;
  robotsBlocked: boolean;
  noindex: boolean;
  indexable: boolean | null;
  lastCheckedAt: Date | null;
};

export type AuditSummary = {
  crawledPages: number;
  indexablePages: number;
  cleanShare: number | null;
  groups: AuditIssueGroup[];
  keyPages: AuditKeyPage[];
};

const SAMPLES = 5;
const RANK: Record<IssueSeverity, number> = { CRITICAL: 3, WARN: 2, INFO: 1 };
const BY_RANK: Record<number, IssueSeverity> = {
  3: "CRITICAL",
  2: "WARN",
  1: "INFO",
};

type GroupRow = {
  code: string;
  count: number;
  rank: number;
  samples: string[] | null;
};

function isTaCode(value: string): value is TaCode {
  return Object.prototype.hasOwnProperty.call(TA_CATALOG, value);
}

export async function readAuditSummary(
  projectId: string,
): Promise<AuditSummary | null> {
  const site = await SeoSites.forProject(projectId);
  if (!site) return null;
  const siteId = site.id;
  const [crawledPages, indexablePages, groupRows, cleanRows, keyPages] =
    await Promise.all([
      prisma.seoPage.count({
        where: {
          siteId,
          goneAt: null,
          robotsBlocked: false,
          lastCrawledAt: { not: null },
        },
      }),
      prisma.seoPage.count({
        where: { siteId, goneAt: null, indexable: true },
      }),
      prisma.$queryRaw<GroupRow[]>`
        SELECT i->>'code' AS "code",
               COUNT(*)::int AS "count",
               MAX(CASE i->>'severity' WHEN 'CRITICAL' THEN 3 WHEN 'WARN' THEN 2 ELSE 1 END)::int AS "rank",
               (array_agg(p."path" ORDER BY p."inlinks" DESC, p."path" ASC))[1:${Prisma.raw(String(SAMPLES))}] AS "samples"
          FROM "SeoPage" p,
               jsonb_array_elements(CASE WHEN jsonb_typeof(p."issues") = 'array' THEN p."issues" ELSE '[]'::jsonb END) AS i
         WHERE p."siteId" = ${siteId}
           AND p."goneAt" IS NULL
         GROUP BY i->>'code'
      `,
      prisma.$queryRaw<{ total: number; clean: number }[]>`
        SELECT COUNT(*)::int AS "total",
               COUNT(*) FILTER (
                 WHERE NOT EXISTS (
                   SELECT 1
                     FROM jsonb_array_elements(CASE WHEN jsonb_typeof(p."issues") = 'array' THEN p."issues" ELSE '[]'::jsonb END) AS i
                    WHERE i->>'severity' IN ('WARN', 'CRITICAL')
                 )
               )::int AS "clean"
          FROM "SeoPage" p
         WHERE p."siteId" = ${siteId}
           AND p."goneAt" IS NULL
           AND p."status" = 200
           AND p."contentType" ILIKE '%html%'
      `,
      keyPagesFor(site),
    ]);

  const groups: AuditIssueGroup[] = groupRows
    .filter((row) => isTaCode(row.code))
    .map((row) => {
      const code = row.code as TaCode;
      return {
        code,
        title: TA_CATALOG[code].title,
        severity: BY_RANK[Number(row.rank)] ?? TA_CATALOG[code].severity,
        count: Number(row.count),
        samples: (row.samples ?? []).slice(0, SAMPLES),
      };
    })
    .sort(
      (a, b) =>
        RANK[b.severity] - RANK[a.severity] ||
        b.count - a.count ||
        a.code.localeCompare(b.code, "en", { numeric: true }),
    );

  const clean = cleanRows[0];
  const total = Number(clean?.total ?? 0);
  const cleanShare = total > 0 ? Number(clean?.clean ?? 0) / total : null;

  const rows = keyPages.length
    ? await prisma.seoPage.findMany({
        where: {
          siteId,
          urlHash: { in: keyPages.map((page) => page.urlHash) },
        },
        select: {
          urlHash: true,
          status: true,
          fetchError: true,
          finalUrl: true,
          robotsBlocked: true,
          noindex: true,
          indexable: true,
          lastCrawledAt: true,
        },
      })
    : [];
  const byHash = new Map(rows.map((row) => [row.urlHash, row]));
  return {
    crawledPages,
    indexablePages,
    cleanShare,
    groups,
    keyPages: keyPages.map((page) => {
      const row = byHash.get(page.urlHash);
      return {
        url: page.url,
        urlHash: page.urlHash,
        path: page.path,
        isHomepage: page.isHomepage,
        status: row?.status ?? null,
        fetchError: row?.fetchError ?? null,
        finalUrl: row?.finalUrl ?? null,
        robotsBlocked: row?.robotsBlocked ?? false,
        noindex: row?.noindex ?? false,
        indexable: row?.indexable ?? null,
        lastCheckedAt: row?.lastCrawledAt ?? null,
      };
    }),
  };
}
