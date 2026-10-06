import type { SeoReportKind } from "./types";

// SEO rapor kimlikleri (docs/search-reports.md "Kimlikler"). Saf ve
// izomorfik.

// Proje başına tek "Search & SEO" Work'ü. SEO Manager sohbetleri de "seo"
// modülünü paylaştığı için rapor her zaman bu belirlenimci kimliğe gider,
// "en yeni seo Work'ü"ne değil.
export const SEO_WORK_PREFIX = "wkseo_";

export function seoWorkId(projectId: string): string {
  return `${SEO_WORK_PREFIX}${projectId}`;
}

// Dönem anahtarı: PULSE "D:<gün>", WEEKLY "W:<pazartesi>", MONTHLY ve ROADMAP
// "M:<YYYY-MM>". `start` gün, Pazartesi ya da ayın ilk günüdür.
export function periodKeyOf(kind: SeoReportKind, start: string): string {
  if (kind === "PULSE") return `D:${start}`;
  if (kind === "WEEKLY") return `W:${start}`;
  return `M:${start.slice(0, 7)}`;
}

// Komut kimliği GscSiteLink kimliğine bağlıdır (proje kimliğine değil): sahte
// bağ ile canlı bağ ayrı satırlardır ve yeniden bağlanma yeni bir bağ
// oluşturur; böylece kimlikler kipler ve bağlantılar arasında çakışmaz.
export function seoReportCommandId(
  kind: SeoReportKind,
  linkId: string,
  periodKey: string,
): string {
  return `seo${kind.toLowerCase()}_${linkId}_${periodKey.slice(2)}`;
}
