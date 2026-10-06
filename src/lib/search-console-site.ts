import { normalizeDomain } from "@/lib/domain";

// Search Console mülkü projenin web sitesini kapsıyor mu (SC-F1 alan adı
// uyarısı; docs/google-search-console-plan.md). Domain mülkü
// (`sc-domain:example.com`) alan adını ve bütün alt alan adlarını kapsar; URL
// önekli mülk (`https://www.example.com/`) yalnız kendi host'unu. Proje alanı
// "www."suz saklandığı için "www." farkı eşleşme sayılır. Karar verilemiyorsa
// (alan adı yok, adres okunamıyor) uyarı gösterilmez.
export function searchConsoleSiteCoversDomain(
  siteUrl: string,
  domain: string | null | undefined,
): boolean {
  const project = domain ? normalizeDomain(domain) : "";
  if (!project) return true;
  if (siteUrl.startsWith("sc-domain:")) {
    const root = normalizeDomain(siteUrl.slice("sc-domain:".length));
    return project === root || project.endsWith(`.${root}`);
  }
  try {
    return normalizeDomain(new URL(siteUrl).hostname) === project;
  } catch {
    return true;
  }
}

// Seçim listesinin sırası: projenin sitesini kapsayan mülkler önce, onların
// içinde Domain mülkü önce (bütün alt alan adlarını ve protokolleri kapsadığı
// için önerilen tür). Diğerlerinin sırası korunur.
export function rankSearchConsoleSites<T extends { siteUrl: string }>(
  sites: T[],
  domain: string | null | undefined,
): T[] {
  const score = (site: T) =>
    (searchConsoleSiteCoversDomain(site.siteUrl, domain) && domain ? 0 : 2) +
    (site.siteUrl.startsWith("sc-domain:") ? 0 : 1);
  return sites
    .map((site, index) => ({ site, index }))
    .sort((a, b) => score(a.site) - score(b.site) || a.index - b.index)
    .map(({ site }) => site);
}
