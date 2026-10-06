import "server-only";

import { Prisma, type GscSiteLink } from "@prisma/client";

import { GSC_SITEMAPS_EVERY_MS } from "@/lib/seo/audit-constants";
import { GscFlags, gscSyncAllowedFor } from "@/lib/seo/flags";
import { nextPacificMidnight } from "@/lib/seo/governor";
import {
  SeoFlags,
  seoMockMode,
  seoRestrictedProjects,
  seoWorkAllowedFor,
} from "@/lib/seo/health-flags";
import { prisma } from "@/lib/prisma";
import type { GoogleErrorClass } from "@/server/integrations/google/error-catalog";
import { GoogleApiError } from "@/server/integrations/google/errors";
import { getFreshGoogleAccessToken } from "@/server/integrations/google-token";
import { gscQuotaKind } from "@/server/integrations/search-console/errors";
import {
  listSearchConsoleSitemaps,
  type GscSitemapInfo,
} from "@/server/integrations/search-console/sitemaps";
import { primaryGscLink } from "@/server/seo/store";
import { SeoSites } from "@/server/seo/site/sites";

// Search Console'un sitemap görünümü (docs/search-health.md "Sitemap ve
// robots"): sitemaps.list günde bir okunur ve GscSitemap'e yazılır (Google
// verisi; bağa cascade'li). YALNIZ OKUMA, gönderim yok (SK10). Kendi
// zamanlaması SeoSite.gscSitemapsNextAt'tedir:
// - başarı → +24 saat;
// - yetki/izin/bulunamadı/API kapalı → +6 saat;
// - günlük kota → PT gece yarısı;
// - RATE/LOAD → +15 dk;
// - diğer → +1 saat.
// Geliştirme süreci yalnız SEO ve GSC izin listesindeki projelere dokunur.

const HOUR_MS = 3_600_000;
const STOP_WAIT_MS = 6 * HOUR_MS;
const QUOTA_SHORT_WAIT_MS = 15 * 60_000;
const OTHER_WAIT_MS = HOUR_MS;
const CANDIDATES = 20;

const STOPPED_HEALTH = new Set([
  "AUTH",
  "NEEDS_PERMISSION",
  "ACCESS_LOST",
  "GONE",
  "API_DISABLED",
]);

const AUTH_CLASSES = new Set<GoogleErrorClass>([
  "AUTH",
  "SCOPE_MISSING",
  "PERMISSION",
  "NOT_FOUND",
  "API_DISABLED",
]);

// Hata → bir sonraki deneme zamanı.
export function gscSitemapsRetryAt(error: unknown, now: Date): Date {
  if (error instanceof GoogleApiError) {
    if (AUTH_CLASSES.has(error.errorClass)) {
      return new Date(now.getTime() + STOP_WAIT_MS);
    }
    const quota = gscQuotaKind(error);
    if (quota === "DAILY") return nextPacificMidnight(now);
    if (quota === "RATE" || quota === "LOAD") {
      return new Date(now.getTime() + QUOTA_SHORT_WAIT_MS);
    }
  }
  return new Date(now.getTime() + OTHER_WAIT_MS);
}

function dateOrNull(value: string | null): Date | null {
  if (!value) return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function count(value: unknown): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function rowData(info: GscSitemapInfo, projectId: string, now: Date) {
  return {
    projectId,
    type: info.type,
    isIndex: info.isIndex,
    isPending: info.isPending,
    lastSubmitted: dateOrNull(info.lastSubmitted),
    lastDownloaded: dateOrNull(info.lastDownloaded),
    errors: count(info.errors) || 0,
    warnings: count(info.warnings) || 0,
    submittedCount: info.contents.reduce(
      (sum, content) => sum + (count(content.submitted) || 0),
      0,
    ),
    checkedAt: now,
  };
}

type StoredSitemap = {
  path: string;
  isPending: boolean;
  lastDownloaded: Date | null;
  errors: number;
  warnings: number;
  submittedCount: number;
};

function sameSitemap(
  stored: StoredSitemap | undefined,
  next: ReturnType<typeof rowData>,
): boolean {
  return (
    !!stored &&
    stored.isPending === next.isPending &&
    stored.errors === next.errors &&
    stored.warnings === next.warnings &&
    stored.submittedCount === next.submittedCount &&
    (stored.lastDownloaded?.getTime() ?? null) ===
      (next.lastDownloaded?.getTime() ?? null)
  );
}

async function scheduleSite(
  projectId: string,
  data: Prisma.SeoSiteUpdateManyMutationInput,
): Promise<{ id: string } | null> {
  await prisma.seoSite.updateMany({
    where: { projectId, isMock: seoMockMode() },
    data,
  });
  return prisma.seoSite.findFirst({
    where: { projectId, isMock: seoMockMode() },
    select: { id: true },
  });
}

async function accessTokenFor(link: GscSiteLink): Promise<string | null> {
  if (seoMockMode()) return "mock-access-token";
  const credential = await prisma.integrationCredential.findUnique({
    where: { id: link.credentialId },
    select: { id: true, status: true, encryptedSecret: true },
  });
  if (
    !credential ||
    credential.status !== "ACTIVE" ||
    !credential.encryptedSecret
  ) {
    return null;
  }
  return getFreshGoogleAccessToken(credential);
}

// Bir bağın sitemap listesini yazar; döndürülen: yazılan satır sayısı.
// Hata geri çekilmeye dönüşür ve 0 döner (fırlatmaz).
async function syncLinkRow(link: GscSiteLink, now: Date): Promise<number> {
  const retryLater = new Date(now.getTime() + STOP_WAIT_MS);
  if (STOPPED_HEALTH.has(link.health)) {
    await scheduleSite(link.projectId, { gscSitemapsNextAt: retryLater });
    return 0;
  }
  try {
    const accessToken = await accessTokenFor(link);
    if (!accessToken) {
      await scheduleSite(link.projectId, { gscSitemapsNextAt: retryLater });
      return 0;
    }
    const list = await listSearchConsoleSitemaps(accessToken, link.siteUrl);
    const stored = await prisma.gscSitemap.findMany({
      where: { linkId: link.id },
      select: {
        path: true,
        isPending: true,
        lastDownloaded: true,
        errors: true,
        warnings: true,
        submittedCount: true,
      },
    });
    const storedByPath = new Map(stored.map((row) => [row.path, row]));
    const paths = new Set<string>();
    let changed = false;
    for (const info of list) {
      if (paths.has(info.path)) continue;
      paths.add(info.path);
      const data = rowData(info, link.projectId, now);
      if (!sameSitemap(storedByPath.get(info.path), data)) changed = true;
      await prisma.gscSitemap.upsert({
        where: { linkId_path: { linkId: link.id, path: info.path } },
        create: { ...data, linkId: link.id, path: info.path },
        update: data,
      });
    }
    const removed = await prisma.gscSitemap.deleteMany({
      where: { linkId: link.id, path: { notIn: [...paths] } },
    });
    if (removed.count > 0) changed = true;

    const site = await scheduleSite(link.projectId, {
      gscSitemapsAt: now,
      gscSitemapsNextAt: new Date(now.getTime() + GSC_SITEMAPS_EVERY_MS),
    });
    if (changed && site) await SeoSites.markHealthDue(site.id, now);
    return paths.size;
  } catch (error) {
    // Bağ arada silindiyse (P2003) satır yazılamaz; site bir sonraki
    // uzlaştırmada bağsız kalır.
    if (
      !(error instanceof Prisma.PrismaClientKnownRequestError) ||
      error.code !== "P2003"
    ) {
      console.warn(
        `[gsc-sitemaps] sitemaps could not be read for site ${link.siteUrl}:`,
        error instanceof Error ? error.message : error,
      );
    }
    await scheduleSite(link.projectId, {
      gscSitemapsNextAt: gscSitemapsRetryAt(error, now),
    });
    return 0;
  }
}

export const GscSitemaps = {
  async syncDue(limit = 3, now: Date = new Date()): Promise<number> {
    if (!SeoFlags.health() || !GscFlags.sync()) return 0;
    const restricted = seoRestrictedProjects();
    if (restricted && restricted.length === 0) return 0;
    const candidates = await prisma.seoSite.findMany({
      where: {
        isMock: seoMockMode(),
        gscSitemapsNextAt: { not: null, lte: now },
        ...(restricted ? { projectId: { in: restricted } } : {}),
      },
      orderBy: { gscSitemapsNextAt: "asc" },
      take: CANDIDATES,
      select: { id: true, projectId: true },
    });
    let processed = 0;
    for (const site of candidates) {
      if (processed >= limit) break;
      if (
        !seoWorkAllowedFor(site.projectId) ||
        !gscSyncAllowedFor(site.projectId)
      ) {
        // Bu süreç bu projeye dokunmaz; site boşta kalır (uzlaştırma kurar).
        await prisma.seoSite.updateMany({
          where: { id: site.id },
          data: { gscSitemapsNextAt: null },
        });
        continue;
      }
      try {
        const link = await primaryGscLink(site.projectId);
        if (!link) {
          await prisma.seoSite.updateMany({
            where: { id: site.id },
            data: { gscSitemapsNextAt: null },
          });
          continue;
        }
        processed += 1;
        await syncLinkRow(link, now);
      } catch (error) {
        processed += 1;
        console.error(
          `[gsc-sitemaps] site ${site.id} failed:`,
          error instanceof Error ? error.message : error,
        );
      }
    }
    return processed;
  },

  async syncLink(linkId: string, now: Date = new Date()): Promise<number> {
    const link = await prisma.gscSiteLink.findUnique({ where: { id: linkId } });
    if (!link) return 0;
    return syncLinkRow(link, now);
  },
};
