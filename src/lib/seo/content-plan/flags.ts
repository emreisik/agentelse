import { gscSyncAllowedFor, type GscSyncEnvironment } from "@/lib/seo/flags";
import { seoInsightsMode } from "@/lib/seo/insight-flags";

// Aylık SEO içerik planı bayrağı (docs/google-search-console-plan.md SC-F7).
// Değerler çağrı anında okunur; yalnız tam "true" açar. Kontrollerin hepsi
// Search sayfasında (/projects/<id>/arama) durduğu için plan; ambar (GSC_SYNC),
// fırsat motoru (SEO_INSIGHTS=on) ve Search sayfası (GSC_SEARCH_PAGE) açık
// değilken hiçbir şey yapmaz.

export type SeoContentPlanEnvironment = GscSyncEnvironment & {
  SEO_CONTENT_PLAN?: string;
  GSC_SYNC?: string;
  SEO_INSIGHTS?: string;
  GSC_SEARCH_PAGE?: string;
};

export function seoContentPlanOn(
  env: SeoContentPlanEnvironment = process.env,
): boolean {
  return (
    env.SEO_CONTENT_PLAN === "true" &&
    env.GSC_SYNC === "true" &&
    seoInsightsMode(env) === "on" &&
    env.GSC_SEARCH_PAGE === "true"
  );
}

// Proje kimliği olmayan genel işler (saklama temizliği, /health sayaçları).
export const SeoContentPlanFlags = {
  on: (): boolean => seoContentPlanOn(),
};

// Projeye özel her kapı: bayrak + W1 izin listesi (geliştirme sürecinde canlı
// veritabanını paylaşan projelere dokunulmaz).
export function seoContentPlanActiveFor(
  projectId: string,
  env: SeoContentPlanEnvironment = process.env,
): boolean {
  return seoContentPlanOn(env) && gscSyncAllowedFor(projectId, env);
}
