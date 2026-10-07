import type { GaTableRow } from "@/lib/website-analytics/slices";
import { maskGoogleText } from "@/server/integrations/google/pii";

import type { GoogleAdsCampaignRow, GoogleAdsViewRow } from "./types";

// GA4'ün Google Ads kampanya raporu (docs/website-attribution.md "Reklam
// ölçümü"): maliyet ve tıklama Google Ads'ten, key event ve gelir GA4'ten
// gelir. Rapor yalnız mülk Google Ads'e bağlıysa ve katalog denetimi açtıysa
// vardır. Saf modül.

export const GOOGLE_ADS_REPORT_KEY = "google_ads";
// catalog.ts GA_OPTIONAL_DAILY_REPORTS "google_ads" v1 ile aynı sıra.
export const GOOGLE_ADS_DIMENSIONS = ["sessionGoogleAdsCampaignName"] as const;
export const GOOGLE_ADS_METRICS = [
  "advertiserAdCost",
  "advertiserAdClicks",
  "sessions",
  "keyEvents",
  "totalRevenue",
] as const;

const DEFAULT_LIMIT = 10;
const CAMPAIGN_LABEL_MAX = 80;

export function googleAdsRowsOf(
  table: readonly GaTableRow[],
): GoogleAdsCampaignRow[] {
  return table.map((row) => ({
    campaign: row.key[0] ?? "",
    cost: row.values[0] ?? 0,
    clicks: row.values[1] ?? 0,
    sessions: row.values[2] ?? 0,
    keyEvents: row.values[3] ?? 0,
    revenue: row.values[4] ?? 0,
  }));
}

// Gelir / maliyet; maliyet yoksa null.
export function roasOf(revenue: number, cost: number): number | null {
  return cost > 0 ? revenue / cost : null;
}

function costPerKeyEvent(row: GoogleAdsCampaignRow): number | null {
  return row.keyEvents > 0 && row.cost > 0 ? row.cost / row.keyEvents : null;
}

// Kampanya adı bir Google dizesidir (e-posta, telefon, kod olabilir): görünüm
// ve rapor satırlarına yalnız maskelenmiş, kırpılmış ad çıkar. Maskeleme sonrası
// aynılaşan satırlar birleşir (React anahtarı benzersiz kalır); boş ad düşer.
function maskedRows(
  rows: readonly GoogleAdsCampaignRow[],
): Map<string, GoogleAdsCampaignRow> {
  const map = new Map<string, GoogleAdsCampaignRow>();
  for (const row of rows) {
    const campaign = maskGoogleText(row.campaign)
      .trim()
      .slice(0, CAMPAIGN_LABEL_MAX);
    if (campaign === "") continue;
    const entry = map.get(campaign);
    if (!entry) {
      map.set(campaign, { ...row, campaign });
      continue;
    }
    entry.cost += row.cost;
    entry.clicks += row.clicks;
    entry.sessions += row.sessions;
    entry.keyEvents += row.keyEvents;
    entry.revenue += row.revenue;
  }
  return map;
}

// Maliyete göre azalan ilk `limit` kampanya; önceki dönem aynı (maskelenmiş)
// ada göre eşlenir (yeni kampanyada null).
export function googleAdsViewRows(
  current: readonly GoogleAdsCampaignRow[],
  previous: readonly GoogleAdsCampaignRow[],
  limit: number = DEFAULT_LIMIT,
): GoogleAdsViewRow[] {
  const before = maskedRows(previous);
  return [...maskedRows(current).values()]
    .sort((a, b) => b.cost - a.cost || a.campaign.localeCompare(b.campaign))
    .slice(0, Math.max(0, limit))
    .map((row) => {
      const prior = before.get(row.campaign);
      return {
        ...row,
        roas: roasOf(row.revenue, row.cost),
        costPerKeyEvent: costPerKeyEvent(row),
        previousRoas: prior ? roasOf(prior.revenue, prior.cost) : null,
        previousCostPerKeyEvent: prior ? costPerKeyEvent(prior) : null,
      };
    });
}
