import { addDays } from "./sync-plan";

// Ads sayfasının tarih ön ayarları → hesap gününe göre aralık. Meta'nın
// last_Nd ön ayarları bugünü içermez; this_month bugünü içerir.
export function rangeForPreset(
  preset: string,
  today: string,
): { since: string; until: string } | null {
  const yesterday = addDays(today, -1);
  switch (preset) {
    case "today":
      return { since: today, until: today };
    case "yesterday":
      return { since: yesterday, until: yesterday };
    case "last_7d":
      return { since: addDays(today, -7), until: yesterday };
    case "last_14d":
      return { since: addDays(today, -14), until: yesterday };
    case "last_28d":
      return { since: addDays(today, -28), until: yesterday };
    case "last_30d":
      return { since: addDays(today, -30), until: yesterday };
    case "last_90d":
      return { since: addDays(today, -90), until: yesterday };
    case "this_month":
      return { since: `${today.slice(0, 7)}-01`, until: today };
    default:
      // "maximum": aynadaki bütün satırlar.
      return null;
  }
}
