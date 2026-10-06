import { gscSyncAllowedFor } from "@/lib/seo/flags";

// SEO fırsat motoru bayrağı (docs/google-search-console-plan.md SC-F4).
// SEO_INSIGHTS=off|shadow|on; başka her değer "off". Motor yalnız GSC_SYNC ile
// birlikte çalışır (ambar olmadan okuyacak veri yok). Değerler çağrı anında
// okunur; GscFlags bilerek içe aktarılmaz ki ortam testte enjekte edilebilsin.
// "shadow": motor hesaplar ve saklar, kullanıcı hiçbir şey görmez.
// "on": liste, Signals, fikirler, açıklamalar, sohbet araçları ve eğri
// tabanlı quick wins açılır.

export type SeoInsightsMode = "off" | "shadow" | "on";

export type SeoInsightsEnvironment = {
  SEO_INSIGHTS?: string;
  GSC_SYNC?: string;
  NODE_ENV?: string;
  DATABASE_URL?: string;
  GSC_SYNC_DEV_PROJECTS?: string;
  GSC_ROLLOUT_PROJECTS?: string;
};

// Yalnız tam küçük harfli "shadow" ve "on" tanınır ("ON", "true" → "off").
export function seoInsightsMode(
  env: SeoInsightsEnvironment = process.env,
): SeoInsightsMode {
  const value = env.SEO_INSIGHTS;
  return value === "shadow" || value === "on" ? value : "off";
}

function syncOn(env: SeoInsightsEnvironment): boolean {
  return env.GSC_SYNC === "true";
}

export const SeoInsightFlags = {
  mode: (env: SeoInsightsEnvironment = process.env): SeoInsightsMode =>
    seoInsightsMode(env),
  // Motor çalışır (shadow ya da on): sınıflama, eğri, küme, bulgu.
  active: (env: SeoInsightsEnvironment = process.env): boolean =>
    seoInsightsMode(env) !== "off" && syncOn(env),
  // Kullanıcıya görünen her yüzey.
  userFacing: (env: SeoInsightsEnvironment = process.env): boolean =>
    seoInsightsMode(env) === "on" && syncOn(env),
};

// İzin listesi GSC ile aynı: canlı veritabanını paylaşan geliştirme süreci
// yalnız GSC_SYNC_DEV_PROJECTS'e, açılış listesi doluysa yalnız ona dokunur.
export function seoInsightsAllowedFor(
  projectId: string,
  env: SeoInsightsEnvironment = process.env,
): boolean {
  return gscSyncAllowedFor(projectId, env);
}

// Projenin fırsatlarını eski GSC taraması yerine motor üretir (yalnız "on").
export function seoEngineOwnsProject(
  projectId: string,
  env: SeoInsightsEnvironment = process.env,
): boolean {
  return (
    SeoInsightFlags.userFacing(env) && seoInsightsAllowedFor(projectId, env)
  );
}
