import {
  SeoFlags,
  seoGlobalWorkAllowedHere,
  seoMockMode,
  seoRestrictedProjects,
  seoWorkAllowedFor,
  type SeoEnvironment,
} from "@/lib/seo/health-flags";
import { GaFlags } from "@/lib/website-analytics/flags";

// SC-F8 bayrakları (WordPress uygulama katmanı, IndexNow, GEO/AEO). Değerler
// çağrı anında process.env'den okunur (tick adımları bayrağı her turda yeniden
// okur); yalnız "true" açar. Kapalıyken yeni sorgu, ekran ya da istemci isteği
// yoktur.

export type { SeoEnvironment };

function on(name: string): boolean {
  return process.env[name] === "true";
}

export const SeoApplyFlags = {
  // WordPress bağlayıcısı, öneri + onay + uygulama + geri alma. SEO_HEALTH ister.
  apply: () => on("SEO_APPLY"),
  // IndexNow bildirimi (SEO_APPLY altında alt bayrak).
  indexNow: () => on("SEO_INDEXNOW"),
  // AI arama görünürlüğü denetimi. SEO_HEALTH + SEO_CRAWL ister.
  geo: () => on("SEO_GEO"),
};

export function seoApplyEnabled(): boolean {
  return SeoApplyFlags.apply() && SeoFlags.health();
}

// Proje başına: yerel geliştirme süreci canlı veritabanını paylaşırken yalnız
// SEO_DEV_PROJECTS, açılış listesi doluysa yalnız o projeler.
export function seoApplyEnabledFor(
  projectId: string,
  env: SeoEnvironment = process.env,
): boolean {
  return seoApplyEnabled() && seoWorkAllowedFor(projectId, env);
}

export function seoIndexNowEnabled(): boolean {
  return seoApplyEnabled() && SeoApplyFlags.indexNow();
}

export function seoGeoEnabled(): boolean {
  return SeoApplyFlags.geo() && SeoFlags.crawl();
}

export function seoGeoEnabledFor(
  projectId: string,
  env: SeoEnvironment = process.env,
): boolean {
  return seoGeoEnabled() && seoWorkAllowedFor(projectId, env);
}

// AI yönlendirme trafiği GA ambarından okunur; GA_SYNC de açık olmalı.
export function seoGeoTrafficEnabled(): boolean {
  return seoGeoEnabled() && GaFlags.sync();
}

// Koşucular bunu WHERE koşuluna koyar (take(n)'den sonra süzmez).
export function seoApplyRestrictedProjects(
  env: SeoEnvironment = process.env,
): string[] | null {
  return seoRestrictedProjects(env);
}

export function seoApplyGlobalWorkAllowedHere(
  env: SeoEnvironment = process.env,
): boolean {
  return seoGlobalWorkAllowedHere(env);
}

export function applyMockMode(env: SeoEnvironment = process.env): boolean {
  return seoMockMode(env);
}

// Mock süreç yalnız mock siteye, gerçek süreç yalnız gerçek siteye dokunur
// (kimlik bilgisi ve değişiklik satırları karışmaz).
export function mockMatchesSite(mock: boolean, siteIsMock: boolean): boolean {
  return mock === siteIsMock;
}
