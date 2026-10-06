import "server-only";

import { prisma } from "@/lib/prisma";
import {
  addDays,
  addMonths,
  daysInRange,
  lastCompleteMonthStart,
  monthEnd,
} from "@/lib/seo/dates";
import { forecastMonth } from "@/lib/seo/reports/forecast";
import type { MonthlyPoint, SearchForecast } from "@/lib/seo/reports/types";

import type { ReportLinkContext } from "./inputs";

// Aylık tıklama serisi ve gelecek ay tahmini için veri okuyucuları
// (docs/search-reports.md "Tahmin"). Yalnız ambarın günlük toplamları ve
// sayfa sözlüğü; Google'a çağrı yok.

const DEFAULT_MONTHS = 27;
const MIN_SERIES_FOR_NON_BRAND = 3;
const NEW_CONTENT_DAYS = 90;

type MonthlySqlRow = {
  month: string;
  days: number;
  finals: number;
  brandDays: number;
  clicks: bigint | number | null;
  brandClicks: bigint | number | null;
};

// `throughMonth` (ayın ilk günü, dahil) ve öncesindeki `months` ay. Yalnız tam
// aylar kalır: her gün ambarda ve kesinleşmiş, markasız seri için her günün
// marka değeri de dolu olmalı.
export async function readMonthlySeries(
  linkId: string,
  metric: "nonBrandClicks" | "clicks",
  throughMonth: string,
  months: number = DEFAULT_MONTHS,
): Promise<MonthlyPoint[]> {
  const from = addMonths(throughMonth, -(Math.max(1, months) - 1));
  const to = monthEnd(throughMonth);
  const rows = await prisma.$queryRaw<MonthlySqlRow[]>`
    SELECT to_char("date", 'YYYY-MM') || '-01' AS "month",
           COUNT(*)::int AS "days",
           COUNT(*) FILTER (WHERE NOT "fresh")::int AS "finals",
           COUNT("brandClicks")::int AS "brandDays",
           SUM("clicks")::bigint AS "clicks",
           SUM("brandClicks")::bigint AS "brandClicks"
      FROM "GscDailyTotal"
     WHERE "linkId" = ${linkId}
       AND "searchType" = 'web'
       AND "date" BETWEEN ${from}::date AND ${to}::date
     GROUP BY 1
     ORDER BY 1 ASC
  `;
  const series: MonthlyPoint[] = [];
  for (const row of rows) {
    const length = daysInRange(row.month, monthEnd(row.month));
    if (row.days !== length || row.finals !== length) continue;
    if (metric === "nonBrandClicks" && row.brandDays !== length) continue;
    const clicks = Number(row.clicks ?? 0);
    const value =
      metric === "nonBrandClicks"
        ? Math.max(0, clicks - Number(row.brandClicks ?? 0))
        : clicks;
    series.push({ month: row.month, value, days: length });
  }
  return series;
}

// Son 90 günde ilk kez görülen sayfaların `month` ayındaki tıklamaları
// (yönlendirici). Sayfa özetleri yoksa ya da ambarın geçmişi 90 günden kısaysa
// (her sayfa "yeni" görünür) null.
export async function readNewContent(
  linkId: string,
  month: string,
): Promise<{ clicks: number; pages: number; share: number | null } | null> {
  const cutoff = addDays(monthEnd(month), -(NEW_CONTENT_DAYS - 1));
  const oldest = await prisma.gscPage.aggregate({
    where: { linkId },
    _min: { firstSeenWeek: true },
  });
  const oldestDay = oldest._min.firstSeenWeek
    ? oldest._min.firstSeenWeek.toISOString().slice(0, 10)
    : null;
  if (!oldestDay || oldestDay >= cutoff) return null;

  const rows = await prisma.$queryRaw<
    {
      pages: number;
      clicks: bigint | number | null;
      total: bigint | number | null;
    }[]
  >`
    SELECT COUNT(*) FILTER (WHERE p."firstSeenWeek" >= ${cutoff}::date)::int AS "pages",
           SUM(m."clicks") FILTER (WHERE p."firstSeenWeek" >= ${cutoff}::date)::bigint AS "clicks",
           SUM(m."clicks")::bigint AS "total"
      FROM "GscMonthlyPage" m
      JOIN "GscPage" p ON p."id" = m."pageId"
     WHERE m."linkId" = ${linkId}
       AND m."month" = ${month}::date
  `;
  const row = rows[0];
  const pages = Number(row?.pages ?? 0);
  if (!row || pages === 0) return null;
  const clicks = Number(row.clicks ?? 0);
  const total = Number(row.total ?? 0);
  return { clicks, pages, share: total > 0 ? clicks / total : null };
}

// Hedef ayın (ayın ilk günü) tıklama tahmini. Geçmiş, hedeften önceki ay ile son
// tam ayın küçüğünde biter. Marka ayrımı hazırsa ve en az 3 tam aylık markasız
// seri varsa markasız tıklama, yoksa toplam tıklama tahmin edilir.
export async function forecastSearchMonth(
  ctx: ReportLinkContext,
  target: string,
): Promise<SearchForecast | null> {
  const lastComplete = lastCompleteMonthStart(ctx.finalThrough);
  const before = addMonths(target, -1);
  const historyEnd = before < lastComplete ? before : lastComplete;

  // Markasız seri yalnız toplam serinin her ayını kapsıyorsa kullanılır: bir
  // ayın marka değeri eksikse karışık seri yerine toplam tıklama tahmin edilir.
  const clicks = await readMonthlySeries(ctx.link.id, "clicks", historyEnd);
  let metric: SearchForecast["metric"] = "clicks";
  let history: MonthlyPoint[] = clicks;
  if (ctx.brandSplitReady) {
    const nonBrand = await readMonthlySeries(
      ctx.link.id,
      "nonBrandClicks",
      historyEnd,
    );
    if (
      nonBrand.length >= MIN_SERIES_FOR_NON_BRAND &&
      nonBrand.length === clicks.length
    ) {
      metric = "nonBrandClicks";
      history = nonBrand;
    }
  }

  const forecast = forecastMonth({ metric, history, target });
  if (!forecast) return null;
  const newContent = await readNewContent(ctx.link.id, historyEnd);
  return { ...forecast, newContent };
}
