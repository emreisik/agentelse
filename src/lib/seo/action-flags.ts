import {
  SeoFlags,
  seoGlobalWorkAllowedHere,
  seoRestrictedProjects,
  seoWorkAllowedFor,
  type SeoEnvironment,
} from "@/lib/seo/health-flags";

// SEO eylem döngüsü bayrakları (docs/google-search-console-plan.md SC-F6).
// Değerler çağrı anında process.env'den okunur (tick adımları bayrağı her
// turda yeniden okur); yalnız tam "true" açar.

export const SeoActionFlags = {
  // SEO Manager açık maddeleri: kart damgası, "Write another", arka plan
  // koşusu, Brief dili, öğrenmeler, liveSlotCount düzeltmesi, durum ucu.
  manager: () => process.env.SEO_ACTIONS === "true",
  // Eylem kaydı, Fix this, doğrulayıcı, değerlendirici, Search sayfası bölümü:
  // kendi tarayıcımız da (SEO_HEALTH + SEO_CRAWL) açık olmalı.
  loop: () => process.env.SEO_ACTIONS === "true" && SeoFlags.crawl(),
};

// İzin listeleri W2'nin SEO listeleriyle aynıdır (SEO_DEV_PROJECTS,
// SEO_ROLLOUT_PROJECTS); eylem döngüsü ayrı bir liste tutmaz.
export function seoActionsAllowedFor(
  projectId: string,
  env: SeoEnvironment = process.env,
): boolean {
  return seoWorkAllowedFor(projectId, env);
}

// Koşucular bunu WHERE koşuluna koyar; null = bütün projeler.
export function seoActionsRestrictedProjects(
  env: SeoEnvironment = process.env,
): string[] | null {
  return seoRestrictedProjects(env);
}

// Bütün projeleri ilgilendiren işler (heartbeat, saklama) için.
export function seoActionsGlobalWorkAllowedHere(
  env: SeoEnvironment = process.env,
): boolean {
  return seoGlobalWorkAllowedHere(env);
}
