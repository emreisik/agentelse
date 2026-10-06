import "server-only";

import { GscFlags } from "@/lib/seo/flags";
import { addDays, dayRange } from "@/lib/seo/dates";
import { brandSplitStatus } from "@/server/seo/brand-terms";
import {
  primaryGscLink,
  readGscDays,
  type GscDayRow,
} from "@/server/seo/store";

// Sağ dokun Brand sekmesindeki "Search" kartı (SC-F2): son 28 kesin gün ve
// önceki 28 gün. Yalnız ambardan; Google'a çağrı yok. Günler PT'dir.

export type SearchOverview =
  | { ok: false; reason: "off" | "not_synced" }
  | {
      ok: true;
      from: string;
      to: string;
      clicks: number;
      previousClicks: number | null;
      nonBrandClicks: number | null;
      previousNonBrandClicks: number | null;
      trend: number[];
      health: string;
      finalThrough: string;
      pageHref: string | null;
      isMock: boolean;
    };

const WINDOW_DAYS = 28;

type Sums = { clicks: number; nonBrandClicks: number | null };

// Marka ayrımı yalnız her günün marka değeri varsa sayılır; eksik bir gün
// toplamı yanıltır.
function sums(days: readonly GscDayRow[], brandReady: boolean): Sums {
  const clicks = days.reduce((sum, day) => sum + day.clicks, 0);
  const complete =
    brandReady &&
    days.length > 0 &&
    days.every((day) => day.brandClicks !== null);
  if (!complete) return { clicks, nonBrandClicks: null };
  const brand = days.reduce((sum, day) => sum + (day.brandClicks ?? 0), 0);
  return { clicks, nonBrandClicks: Math.max(0, clicks - brand) };
}

export async function loadSearchOverview(
  projectId: string,
  now: Date = new Date(),
): Promise<SearchOverview> {
  // Pencere saatten değil, kesinleşen son PT gününden hesaplanır; `now`
  // yalnız imza uyumu için (loadAdsOverview ile aynı).
  void now;
  if (!GscFlags.sync()) return { ok: false, reason: "off" };
  const link = await primaryGscLink(projectId);
  if (!link?.lastFinalDate) return { ok: false, reason: "not_synced" };

  const to = link.lastFinalDate;
  const from = addDays(to, -(WINDOW_DAYS - 1));
  const previousTo = addDays(from, -1);
  const previousFrom = addDays(previousTo, -(WINDOW_DAYS - 1));
  const [rawCurrent, rawPrevious] = await Promise.all([
    readGscDays(link.id, from, to),
    readGscDays(link.id, previousFrom, previousTo),
  ]);
  // Taze (kesinleşmemiş) satırlar karşılaştırmaya girmez.
  const current = rawCurrent.filter((day) => !day.fresh);
  const previous = rawPrevious.filter((day) => !day.fresh);
  // GA kartıyla aynı kural: 28 günün hepsi yoksa (geçmiş hâlâ yükleniyor,
  // boşluk) kısa toplam "28 gün" diye gösterilmez; karşılaştırma yalnız
  // önceki pencere de eksiksizse.
  if (current.length < WINDOW_DAYS) return { ok: false, reason: "not_synced" };
  const previousComplete = previous.length >= WINDOW_DAYS;

  const brandReady = brandSplitStatus(link) === "ready";
  const now28 = sums(current, brandReady);
  const before28 = sums(previous, brandReady);
  const useNonBrand = now28.nonBrandClicks !== null;

  // Kıvılcım çizgisi: pencerenin her günü, eksik gün 0.
  const byDay = new Map(current.map((day) => [day.day, day]));
  const trend = dayRange(from, to).map((key) => {
    const day = byDay.get(key);
    if (!day) return 0;
    return useNonBrand
      ? Math.max(0, day.clicks - (day.brandClicks ?? 0))
      : day.clicks;
  });

  return {
    ok: true,
    from,
    to,
    clicks: now28.clicks,
    previousClicks: previousComplete ? before28.clicks : null,
    nonBrandClicks: now28.nonBrandClicks,
    previousNonBrandClicks:
      previousComplete && useNonBrand ? before28.nonBrandClicks : null,
    trend,
    health: link.health,
    finalThrough: to,
    pageHref: GscFlags.searchPage() ? `/projects/${projectId}/arama` : null,
    isMock: link.isMock,
  };
}
