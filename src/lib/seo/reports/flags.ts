import { gscSyncAllowedFor, type GscSyncEnvironment } from "../flags";

// SEO raporlama bayrakları (docs/search-reports.md "Bayraklar"). Değerler
// çağrı anında okunur; yalnız "true" açar. SEO_REPORTS tek başına yetmez:
// raporlar ambardan okunduğu için GSC_SYNC da açık olmalıdır.

export type SeoReportsEnvironment = GscSyncEnvironment & {
  SEO_REPORTS?: string;
  GSC_SYNC?: string;
};

export function seoReportsOn(
  env: SeoReportsEnvironment = process.env,
): boolean {
  return env.SEO_REPORTS === "true" && env.GSC_SYNC === "true";
}

export const SeoReportFlags = {
  on: () => seoReportsOn(process.env),
};

// Proje izin listesi W1 ile ortaktır: yerel geliştirme süreci canlı
// veritabanını paylaşırken yalnız listedeki projeler, GSC_ROLLOUT_PROJECTS
// doluysa her ortamda yalnız o projeler.
export function seoReportsAllowedFor(
  projectId: string,
  env: SeoReportsEnvironment = process.env,
): boolean {
  return gscSyncAllowedFor(projectId, env);
}

export function seoReportsActiveFor(
  projectId: string,
  env: SeoReportsEnvironment = process.env,
): boolean {
  return seoReportsOn(env) && seoReportsAllowedFor(projectId, env);
}
