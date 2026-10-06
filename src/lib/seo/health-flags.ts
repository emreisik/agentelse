import { isLocalDatabaseUrl } from "@/lib/local-worker-policy";

// Arama sağlığı ve teknik denetim bayrakları (docs/google-search-console-plan.md
// SC-F3). Değerler çağrı anında process.env'den okunur (tick adımları bayrağı
// her turda yeniden okur); yalnız "true" açar. SEO_CRAWL tek başına bir şey
// açmaz: tarayıcı yalnız SEO_HEALTH ile birlikte çalışır.

function on(name: string): boolean {
  return process.env[name] === "true";
}

export const SeoFlags = {
  // Denetimler, URL Inspection, GSC sitemap'leri, uyarılar, puan ve panel.
  health: () => on("SEO_HEALTH"),
  // Kendi tarayıcımız: robots, sitemap, haftalık tarama, gerileme bekçisi.
  crawl: () => on("SEO_HEALTH") && on("SEO_CRAWL"),
};

export type SeoEnvironment = {
  NODE_ENV?: string;
  DATABASE_URL?: string;
  SEO_DEV_PROJECTS?: string;
  SEO_ROLLOUT_PROJECTS?: string;
  AGENTELSE_PROVIDER_MODE?: string;
  GOOGLE_API_KEY?: string;
};

// Virgülle ayrılmış proje kimlikleri; boşluklar kırpılır, boş öğeler atılır.
function projectList(value: string | undefined): string[] {
  return (value ?? "")
    .split(",")
    .map((id) => id.trim())
    .filter(Boolean);
}

// Bütün projeleri ilgilendiren işler (search-updates-sync, saklama temizliği,
// heartbeat, claimPeriodic): yerel geliştirme süreci canlı veritabanını
// paylaşırken hiç çalışmaz.
export function seoGlobalWorkAllowedHere(
  env: SeoEnvironment = process.env,
): boolean {
  return env.NODE_ENV !== "development" || isLocalDatabaseUrl(env.DATABASE_URL);
}

// Yerel geliştirme süreci canlı veritabanını paylaşırken müşteri sitelerini
// taramasın diye yalnız SEO_DEV_PROJECTS'teki projelere dokunur.
// SEO_ROLLOUT_PROJECTS doluysa her ortamda yalnız o projeler denetim işi ve
// yazma eylemi alır (GSC izin listesiyle aynı anlam).
export function seoWorkAllowedFor(
  projectId: string,
  env: SeoEnvironment = process.env,
): boolean {
  const here =
    seoGlobalWorkAllowedHere(env) ||
    projectList(env.SEO_DEV_PROJECTS).includes(projectId);
  if (!here) return false;
  const rollout = projectList(env.SEO_ROLLOUT_PROJECTS);
  return rollout.length === 0 || rollout.includes(projectId);
}

// Geçerli izin listesi: geliştirme sürecinde dev listesi (açılış listesi
// varsa onunla kesişimi), aksi hâlde açılış listesi; null = bütün projeler.
// Koşucular bunu WHERE koşuluna koyar (take(n)'den sonra süzmez).
export function seoRestrictedProjects(
  env: SeoEnvironment = process.env,
): string[] | null {
  const rollout = projectList(env.SEO_ROLLOUT_PROJECTS);
  if (!seoGlobalWorkAllowedHere(env)) {
    const dev = projectList(env.SEO_DEV_PROJECTS);
    return rollout.length > 0 ? dev.filter((id) => rollout.includes(id)) : dev;
  }
  return rollout.length > 0 ? rollout : null;
}

// Mock kipinde hiçbir çağrı süreçten çıkmaz (tarayıcı bellek içi siteyi,
// Google istemcileri fixture'ları okur).
export function seoMockMode(env: SeoEnvironment = process.env): boolean {
  return env.AGENTELSE_PROVIDER_MODE === "mock";
}

// CrUX anahtarı; yalnız X-Goog-Api-Key başlığında gider, hiç loglanmaz.
export function cruxApiKey(env: SeoEnvironment = process.env): string | null {
  const key = (env.GOOGLE_API_KEY ?? "").trim();
  return key ? key : null;
}

// Core Web Vitals: SEO_HEALTH açık ve anahtar var (mock kipi anahtarsız çalışır).
export function cwvEnabled(env: SeoEnvironment = process.env): boolean {
  return SeoFlags.health() && (seoMockMode(env) || cruxApiKey(env) !== null);
}
