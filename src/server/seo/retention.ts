import "server-only";

import type { Prisma } from "@prisma/client";

import { GSC_SLICE_KINDS } from "@/lib/seo/catalog";
import {
  dateToDayKey,
  dayKeyToDate,
  firstMonthStartOnOrAfter,
  googleWindowStart,
  gscToday,
  monthEnd,
  monthStart,
  shiftMonthsClamped,
  weekStartOf,
} from "@/lib/seo/dates";
import { GscFlags, gscGlobalWorkAllowedHere } from "@/lib/seo/flags";
import { rollupSliceMonth, type SliceRow } from "@/lib/seo/slices";
import { prisma } from "@/lib/prisma";
import { GOOGLE_PROVIDER } from "@/server/integrations/google-client";
import { gscMockMode } from "@/server/integrations/search-console/search-analytics";
import { claimPeriodic } from "@/server/observability/periodic";
import { deleteSearchConsoleAlertsForProjects } from "@/server/seo/health/alerts";
import { forgetSearchOpportunitiesForLinks } from "@/server/seo/opportunities/forget";
import { SeoSites } from "@/server/seo/site/sites";

// Search Console ambarının saklama temizliği (docs/google-search-console-plan.md
// §4 "Saklama", SK3; docs/search-analytics.md "Saklama"): `seo-retention`
// tick adımı, günde bir. Arşiv açıkken günlük toplamlar ve aylık özetler
// kalıcıdır; haftalık sorgu/sayfa özetleri 36 ay, sorgu×sayfa 16 ay, günlük
// kırılımlar 16 ay tutulur, sonra aylık kırılımlara (kind "<kind>_month")
// katlanır. Arşiv kapalıyken Google'ın 16 ayından eski her şey (sözlük
// satırları dahil) silinir. Silmeler bağ bağ yapılır (linkId ile başlayan
// tekil indeksler); tablo çapında aralık silme yok. Birincilliğini kaybetmiş
// bağlar demotedAt'ten 30 gün sonra, bağlantısı kalmamış bağlar hemen silinir.

const EVERY_MS = 24 * 3_600_000;
const STALE_LINK_DAYS = 30;
const LINK_PAGE = 100;
// Bir turda katlanan en çok ay (bağ başına); kalanı ertesi güne kalır.
const ROLLUP_MONTHS_PER_RUN = 24;

type Cutoffs = {
  // Google'ın penceresinin ilk günü.
  window: Date;
  // Arşiv kapalıyken sözlük budaması (haftanın Pazartesi'si).
  dictionary: Date;
  keep36: Date;
  sliceCut: Date;
};

function cutoffs(now: Date): Cutoffs {
  const today = gscToday(now);
  const window = googleWindowStart(today);
  return {
    window: dayKeyToDate(window),
    dictionary: dayKeyToDate(weekStartOf(window)),
    keep36: dayKeyToDate(shiftMonthsClamped(today, -36)),
    sliceCut: dayKeyToDate(firstMonthStartOnOrAfter(window)),
  };
}

type Other = [number, number, number];

function sliceRows(value: Prisma.JsonValue): SliceRow[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((row) =>
    Array.isArray(row) &&
    typeof row[0] === "string" &&
    typeof row[1] === "number" &&
    typeof row[2] === "number" &&
    typeof row[3] === "number"
      ? [[row[0], row[1], row[2], row[3]] as SliceRow]
      : [],
  );
}

function sliceOther(value: Prisma.JsonValue | null): Other | null {
  if (
    Array.isArray(value) &&
    value.length === 3 &&
    value.every((item) => typeof item === "number")
  ) {
    return value as Other;
  }
  return null;
}

// Arşiv açık: 16 aydan eski bütün ayların günlük kırılımları aylık satıra
// katlanır, günlük satırlar silinir. Ay zaten katlanmışsa (ör. geri doldurma
// sonradan aynı aya gün yazdıysa) günlük satırlar yalnız silinir: aynı günler
// iki kez sayılmasın.
async function rollupSlices(linkId: string, cut: Cutoffs): Promise<number> {
  let deleted = 0;
  for (let round = 0; round < ROLLUP_MONTHS_PER_RUN; round += 1) {
    const oldest = await prisma.gscDailySlice.findFirst({
      where: {
        linkId,
        kind: { in: [...GSC_SLICE_KINDS] },
        date: { lt: cut.sliceCut },
      },
      orderBy: { date: "asc" },
      select: { date: true, projectId: true },
    });
    if (!oldest) break;
    const month = monthStart(dateToDayKey(oldest.date));
    const from = dayKeyToDate(month);
    const to = dayKeyToDate(monthEnd(month));
    const days = await prisma.gscDailySlice.findMany({
      where: {
        linkId,
        kind: { in: [...GSC_SLICE_KINDS] },
        date: { gte: from, lte: to },
      },
      select: { kind: true, rows: true, other: true, truncated: true },
    });
    deleted += await prisma.$transaction(async (tx) => {
      for (const kind of GSC_SLICE_KINDS) {
        const ofKind = days.filter((day) => day.kind === kind);
        if (ofKind.length === 0) continue;
        const monthKind = `${kind}_month`;
        const existing = await tx.gscDailySlice.findUnique({
          where: {
            linkId_kind_date: { linkId, kind: monthKind, date: from },
          },
          select: { id: true },
        });
        if (existing) continue;
        const rolled = rollupSliceMonth(
          kind,
          ofKind.map((day) => ({
            rows: sliceRows(day.rows),
            other: sliceOther(day.other),
          })),
        );
        await tx.gscDailySlice.create({
          data: {
            linkId,
            projectId: oldest.projectId,
            kind: monthKind,
            date: from,
            rows: rolled.rows as unknown as Prisma.InputJsonValue,
            ...(rolled.other
              ? { other: rolled.other as unknown as Prisma.InputJsonValue }
              : {}),
            rowCount: rolled.rows.length,
            truncated: ofKind.some((day) => day.truncated),
            fetchedAt: new Date(),
          },
        });
      }
      const removed = await tx.gscDailySlice.deleteMany({
        where: {
          linkId,
          kind: { in: [...GSC_SLICE_KINDS] },
          date: { gte: from, lte: to },
        },
      });
      return removed.count;
    });
  }
  return deleted;
}

// Arşiv kapalı: Google'ın penceresinden eski her şey gider.
async function pruneArchiveOff(linkId: string, cut: Cutoffs): Promise<number> {
  const counts = await Promise.all([
    prisma.gscDailyTotal.deleteMany({
      where: { linkId, date: { lt: cut.window } },
    }),
    prisma.gscDailySlice.deleteMany({
      where: { linkId, date: { lt: cut.window } },
    }),
    prisma.gscWeeklyQuery.deleteMany({
      where: { linkId, weekStart: { lt: cut.window } },
    }),
    prisma.gscWeeklyPage.deleteMany({
      where: { linkId, weekStart: { lt: cut.window } },
    }),
    prisma.gscWeeklyQueryPage.deleteMany({
      where: { linkId, weekStart: { lt: cut.window } },
    }),
    prisma.gscMonthlyQuery.deleteMany({
      where: { linkId, month: { lt: cut.window } },
    }),
    prisma.gscMonthlyPage.deleteMany({
      where: { linkId, month: { lt: cut.window } },
    }),
    prisma.gscPeriodFetch.deleteMany({
      where: { linkId, periodStart: { lt: cut.window } },
    }),
  ]);
  // Sözlük en son: kalan çocuk satırlar daha eskidir ve cascade ile gider.
  const queries = await prisma.gscQuery.deleteMany({
    where: { linkId, lastSeenWeek: { lt: cut.dictionary } },
  });
  const pages = await prisma.gscPage.deleteMany({
    where: { linkId, lastSeenWeek: { lt: cut.dictionary } },
  });
  return (
    counts.reduce((sum, result) => sum + result.count, 0) +
    queries.count +
    pages.count
  );
}

type RetentionLink = {
  id: string;
  archive: boolean;
  backfillDoneAt: Date | null;
};

async function pruneOne(
  link: RetentionLink,
  cut: Cutoffs,
): Promise<number> {
  const linkId = link.id;
  const counts = await Promise.all([
    prisma.gscWeeklyQueryPage.deleteMany({
      where: { linkId, weekStart: { lt: cut.window } },
    }),
    prisma.gscWeeklyQuery.deleteMany({
      where: { linkId, weekStart: { lt: cut.keep36 } },
    }),
    prisma.gscWeeklyPage.deleteMany({
      where: { linkId, weekStart: { lt: cut.keep36 } },
    }),
    prisma.gscPeriodFetch.deleteMany({
      where: {
        linkId,
        grain: "WEEK",
        key: { in: ["query", "page"] },
        periodStart: { lt: cut.keep36 },
      },
    }),
    prisma.gscPeriodFetch.deleteMany({
      where: {
        linkId,
        grain: "WEEK",
        key: "query_page",
        periodStart: { lt: cut.window },
      },
    }),
  ]);
  let deleted = counts.reduce((sum, result) => sum + result.count, 0);
  if (link.archive) {
    // İlk geri doldurma bitmeden katlama yok: kırılımlar 30 günlük parçalarla
    // yeniden eskiye yazılır ve pencere başındaki yarım ay iki parçaya
    // bölünebilir; erken katlanırsa eski parçanın günleri sonra yalnız silinir
    // ve o ayın kırılımı kalıcı eksik kalır.
    if (link.backfillDoneAt) deleted += await rollupSlices(linkId, cut);
  } else {
    deleted += await pruneArchiveOff(linkId, cut);
  }
  return deleted;
}

export const GscRetention = {
  async runDue(now: Date = new Date()): Promise<number> {
    if (!gscGlobalWorkAllowedHere()) return 0;
    // GSC_SYNC sonradan kapatılsa da gizlilik metnindeki saklama sözleri
    // (30 gün, 16 ay, bağlantısız bağ) geçerli kalır: ambarda bağ varsa
    // temizlik sürer. Bağ yoksa hiçbir şey yazılmaz (bayrak kapalı = değişiklik
    // yok).
    if (
      !GscFlags.sync() &&
      !(await prisma.gscSiteLink.findFirst({ select: { id: true } }))
    ) {
      return 0;
    }
    if (!(await claimPeriodic("gsc.retention", EVERY_MS, now))) return 0;
    const cut = cutoffs(now);
    let deleted = 0;

    let cursor: string | null = null;
    for (;;) {
      const links: RetentionLink[] = await prisma.gscSiteLink.findMany({
        where: cursor ? { id: { gt: cursor } } : {},
        orderBy: { id: "asc" },
        take: LINK_PAGE,
        select: { id: true, archive: true, backfillDoneAt: true },
      });
      if (links.length === 0) break;
      for (const link of links) {
        try {
          deleted += await pruneOne(link, cut);
        } catch (error) {
          console.error(
            `[seo-retention] link ${link.id} could not be pruned:`,
            error instanceof Error ? error.message : error,
          );
        }
      }
      cursor = links[links.length - 1]!.id;
    }

    // Seçimi değişen sitenin bağı demotedAt'ten 30 gün sonra (kota yazımı
    // updatedAt'i ilerletse de).
    // SC-F4: silinen bağların fırsat sinyalleri ve havuzdaki kanıtlı fikirleri de silinir.
    const demoted = (
      await prisma.gscSiteLink.findMany({
        where: {
          isPrimary: false,
          demotedAt: {
            lt: new Date(now.getTime() - STALE_LINK_DAYS * 86_400_000),
          },
        },
        select: { id: true },
      })
    ).map((link) => link.id);
    if (demoted.length > 0) {
      await forgetSearchOpportunitiesForLinks(demoted).catch(() => undefined);
      deleted += (
        await prisma.gscSiteLink.deleteMany({
          where: { id: { in: demoted } },
        })
      ).count;
    }

    // Bağlantısı kalmamış bağlar: Disconnect bunları zaten siler; arada
    // kalanlar burada temizlenir.
    const all = await prisma.gscSiteLink.findMany({
      select: { id: true, credentialId: true },
    });
    if (all.length > 0) {
      const live = new Set(
        (
          await prisma.integrationCredential.findMany({
            where: {
              id: { in: [...new Set(all.map((link) => link.credentialId))] },
              provider: GOOGLE_PROVIDER.search_console,
              status: { in: ["ACTIVE", "EXPIRED"] },
            },
            select: { id: true },
          })
        ).map((row) => row.id),
      );
      const orphaned = all
        .filter((link) => !live.has(link.credentialId))
        .map((link) => link.id);
      if (orphaned.length > 0) {
        const orphanProjects = [
          ...new Set(
            (
              await prisma.gscSiteLink.findMany({
                where: { id: { in: orphaned } },
                select: { projectId: true },
              })
            ).map((row) => row.projectId),
          ),
        ];
        await forgetSearchOpportunitiesForLinks(orphaned).catch(
          () => undefined,
        );
        deleted += (
          await prisma.gscSiteLink.deleteMany({
            where: { id: { in: orphaned } },
          })
        ).count;
        // SC-F3: Disconnect'in kaçırdığı bağlarda da GSC kökenli uyarılar ve
        // denetim durumu silinir.
        await deleteSearchConsoleAlertsForProjects(orphanProjects).catch(
          () => 0,
        );
        await SeoSites.forgetSearchConsoleData(orphanProjects, {
          resetScope: true,
        }).catch(() => 0);
      }
    }

    // Canlı süreçte mock bağlar (yerel denemeden kalan) silinir.
    if (!gscMockMode()) {
      deleted += (
        await prisma.gscSiteLink.deleteMany({ where: { isMock: true } })
      ).count;
    }
    return deleted;
  },

  // Arşiv kapatıldı: "yalnız son 16 ay" hemen geçerli olur.
  async pruneLink(linkId: string, now: Date = new Date()): Promise<number> {
    const link = await prisma.gscSiteLink.findUnique({
      where: { id: linkId },
      select: { id: true },
    });
    if (!link) return 0;
    return pruneArchiveOff(link.id, cutoffs(now));
  },
};
