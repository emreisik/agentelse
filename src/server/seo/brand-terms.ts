import "server-only";

import type { GscSiteLink } from "@prisma/client";

import { prisma } from "@/lib/prisma";
import {
  autoBrandTerms,
  brandTermsHash,
  brandTermsOverflow,
  brandTermsRegex,
  compactBrandTerm,
  effectiveBrandTerms,
  isBrandQuery,
  parseBrandTermsConfig,
  parseBrandTermsInput,
  type BrandTermsConfig,
} from "@/lib/seo/brand-terms";

import { primaryGscLink } from "./store";

// Marka terimlerinin sunucu yanı (docs/search-analytics.md "Marka
// terimleri"): otomatik terimleri tazeler, sorgu sözlüğünü (GscQuery.isBrand)
// yeniden sınıflandırır ve senkronun Google'a gönderdiği regex'i verir.
// brandClassifiedHash, isBrand'in en son hangi terimlerle tamamen
// hesaplandığını tutar; kayıt sonrası null yazılır ki eski terimlerle çalışan
// bir senkronun yazdıkları bir sonraki senkronda düzelsin.

export type GscBrandContext = {
  terms: string[];
  regex: string | null;
  hash: string;
};

export type BrandSplitStatus = "ready" | "pending" | "none" | "error";

const RECLASSIFY_PAGE = 5000;
const UPDATE_CHUNK = 1000;

function sameTerms(a: readonly string[], b: readonly string[]): boolean {
  const left = new Set(a.map(compactBrandTerm));
  const right = new Set(b.map(compactBrandTerm));
  if (left.size !== right.size) return false;
  for (const key of left) if (!right.has(key)) return false;
  return true;
}

async function updateIsBrand(ids: string[], isBrand: boolean): Promise<void> {
  for (let start = 0; start < ids.length; start += UPDATE_CHUNK) {
    await prisma.gscQuery.updateMany({
      where: { id: { in: ids.slice(start, start + UPDATE_CHUNK) } },
      data: { isBrand },
    });
  }
}

// Sözlüğü kimlik sırasıyla sayfa sayfa gezer, yalnız değişenleri yazar.
export async function reclassifyQueries(
  linkId: string,
  terms: readonly string[],
): Promise<number> {
  let changed = 0;
  let cursor: string | null = null;
  for (;;) {
    const rows: { id: string; text: string; isBrand: boolean }[] =
      await prisma.gscQuery.findMany({
        where: { linkId, ...(cursor ? { id: { gt: cursor } } : {}) },
        orderBy: { id: "asc" },
        take: RECLASSIFY_PAGE,
        select: { id: true, text: true, isBrand: true },
      });
    if (rows.length === 0) break;
    const toBrand: string[] = [];
    const toNonBrand: string[] = [];
    for (const row of rows) {
      const isBrand = isBrandQuery(row.text, terms);
      if (isBrand === row.isBrand) continue;
      (isBrand ? toBrand : toNonBrand).push(row.id);
    }
    await updateIsBrand(toBrand, true);
    await updateIsBrand(toNonBrand, false);
    changed += toBrand.length + toNonBrand.length;
    cursor = rows[rows.length - 1]!.id;
    if (rows.length < RECLASSIFY_PAGE) break;
  }
  return changed;
}

async function loadAutoTerms(
  projectId: string,
  siteUrl: string,
): Promise<string[]> {
  const [brand, project] = await Promise.all([
    prisma.brand.findFirst({
      where: { projectId, isDefault: true },
      orderBy: { createdAt: "asc" },
      select: { name: true },
    }),
    prisma.project.findUnique({
      where: { id: projectId },
      select: { name: true, domain: true },
    }),
  ]);
  return autoBrandTerms({
    brandName: brand?.name ?? null,
    projectName: project?.name ?? null,
    domain: project?.domain ?? null,
    siteUrl,
  });
}

// Senkronun başında çağrılır (refresh: metadata aşamasında otomatik terimleri
// de tazeler). Terimler ya da sınıflandırma özeti değiştiyse sözlüğü yeniden
// sınıflandırır ve brandClassifiedHash'i yazar.
export async function brandContextForLink(
  link: Pick<
    GscSiteLink,
    "id" | "projectId" | "siteUrl" | "brandTerms" | "brandClassifiedHash"
  >,
  options: { refresh?: boolean; now?: Date } = {},
): Promise<GscBrandContext> {
  let config = parseBrandTermsConfig(link.brandTerms);
  let autoChanged = false;
  if (options.refresh) {
    const auto = await loadAutoTerms(link.projectId, link.siteUrl);
    if (!sameTerms(auto, config.auto)) {
      // Kullanıcının araya giren kaydını ezmemek için güncel ayar okunur.
      const current = await prisma.gscSiteLink.findUnique({
        where: { id: link.id },
        select: { brandTerms: true },
      });
      config = {
        ...parseBrandTermsConfig(current?.brandTerms ?? link.brandTerms),
        auto,
        updatedAt: (options.now ?? new Date()).toISOString(),
      };
      await prisma.gscSiteLink.update({
        where: { id: link.id },
        data: { brandTerms: config },
      });
      autoChanged = true;
    }
  }
  const terms = effectiveBrandTerms(config);
  const hash = brandTermsHash(terms);
  if (autoChanged || link.brandClassifiedHash !== hash) {
    await reclassifyQueries(link.id, terms);
    await prisma.gscSiteLink.update({
      where: { id: link.id },
      data: { brandClassifiedHash: hash },
    });
  }
  return { terms, regex: brandTermsRegex(terms), hash };
}

// none: terim yok; ready: günlük marka serisi bu terimlerle tamam; error:
// Google regex'i reddetti; pending: seri yeni terimlerle yeniden çekiliyor.
export function brandSplitStatus(
  link: Pick<GscSiteLink, "brandTerms" | "brandSeriesHash">,
): BrandSplitStatus {
  const terms = effectiveBrandTerms(parseBrandTermsConfig(link.brandTerms));
  if (terms.length === 0) return "none";
  if (link.brandSeriesHash === brandTermsHash(terms)) return "ready";
  if (link.brandSeriesHash === "error") return "error";
  return "pending";
}

// Formdan gelen tam liste: otomatiklerden eksik olanlar "removed",
// otomatiklerde olmayanlar "user" olur.
export async function saveBrandTerms(input: {
  projectId: string;
  terms: string[];
  now?: Date;
}): Promise<
  { ok: true; terms: string[] } | { ok: false; reason: "no_link" | "too_long" }
> {
  const link = await primaryGscLink(input.projectId);
  if (!link) return { ok: false, reason: "no_link" };
  const config = parseBrandTermsConfig(link.brandTerms);
  const cleaned = parseBrandTermsInput(input.terms.join("\n"));
  const autoKeys = new Set(config.auto.map(compactBrandTerm));
  const cleanedKeys = new Set(cleaned.map(compactBrandTerm));
  const next: BrandTermsConfig = {
    v: 1,
    auto: config.auto,
    user: cleaned.filter((term) => !autoKeys.has(compactBrandTerm(term))),
    removed: config.auto.filter(
      (term) => !cleanedKeys.has(compactBrandTerm(term)),
    ),
    updatedAt: (input.now ?? new Date()).toISOString(),
  };
  // Google'a gidecek düzenli ifadeye sığmayan terim sessizce düşmesin:
  // kayıt reddedilir, kullanıcı terimleri kısaltır ya da azaltır.
  if (brandTermsOverflow(next) > 0) return { ok: false, reason: "too_long" };
  await prisma.gscSiteLink.update({
    where: { id: link.id },
    data: { brandTerms: next },
  });
  const terms = effectiveBrandTerms(next);
  await reclassifyQueries(link.id, terms);
  // Eski terimlerle süren bir senkronun yazdığı isBrand değerleri bir sonraki
  // senkronda yeniden sınıflandırılarak geri alınır.
  await prisma.gscSiteLink.update({
    where: { id: link.id },
    data: { brandClassifiedHash: null },
  });
  return { ok: true, terms };
}
