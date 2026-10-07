import "server-only";

import { randomUUID } from "node:crypto";

import { Prisma, type SeoGeoAudit } from "@prisma/client";

import { prisma } from "@/lib/prisma";
import { fnv1a64Hex } from "@/lib/seo/crawl-url";
import { GEO_MANUAL_GAP_MS } from "@/lib/seo/geo/catalog";
import { evaluateGeo } from "@/lib/seo/geo/evaluate";
import { parseGeoResult } from "@/lib/seo/geo/types";
import {
  applyMockMode,
  seoApplyGlobalWorkAllowedHere,
  seoApplyRestrictedProjects,
  seoGeoEnabled,
  seoGeoEnabledFor,
} from "@/lib/seo/apply/flags";
import { claimPeriodic } from "@/server/observability/periodic";

import { collectGeoInput } from "./collect";
import { templateRecommendations, writeGeoRecommendations } from "./recommend";
import { saveGeoAudit, validAcknowledged, type StoredRecommendations } from "./store";

// GEO/AEO denetimi koşucusu (SC-F8, docs/ai-search-visibility.md "Puan ve
// haftalık takvim"): `seo-geo` tick adımı. Site başına haftada bir
// (nextAuditAt = +7 gün + site kimliğinden türeyen en çok 6 saat sapma); ilk
// denetim yalnız tarama verisi (SeoPage) olduktan sonra. Kilit SeoGeoAudit
// satırında CAS ile alınır; satırı olmayan site için satır kilitle birlikte
// oluşturulur (siteId benzersiz: ikinci kopya P2002 alır). Bayrak kapalıyken
// hiçbir sorgu yok; izinli projeler WHERE'de; canlı veritabanını paylaşan
// geliştirme süreci yalnız izinli projelere dokunur ve genel kilit almaz.
// Bu dosya tenant-context, next-auth ya da next/navigation içe aktarmaz (işçi
// grafiği): oturum ve rol denetimi eylem katmanındadır.

const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;
export const GEO_EVERY_MS = 7 * DAY_MS;
export const GEO_JITTER_MS = 6 * HOUR_MS;
export const GEO_RETRY_MS = 6 * HOUR_MS;
const LEASE_MS = 10 * 60_000;
const SCAN_EVERY_MS = 60_000;
const DUE_BATCH = 10;
const NEW_BATCH = 10;
const INSTANCE = `geo:${randomUUID()}`;

type Target = { siteId: string; projectId: string; workspaceId: string };

function jitterMs(siteId: string): number {
  return parseInt(fnv1a64Hex(siteId).slice(0, 8), 16) % GEO_JITTER_MS;
}

function nextAuditAfter(siteId: string, now: Date): Date {
  return new Date(now.getTime() + GEO_EVERY_MS + jitterMs(siteId));
}

function isUniqueViolation(error: unknown): boolean {
  return (
    error instanceof Prisma.PrismaClientKnownRequestError &&
    error.code === "P2002"
  );
}

// Mevcut satırı CAS ile sahiplenir; satır yoksa kilitli satırı oluşturur.
// Kilit bir başkasındaysa null.
async function claim(
  target: Target,
  row: Pick<SeoGeoAudit, "id" | "nextAuditAt" | "acknowledged"> | null,
  now: Date,
): Promise<{ acknowledged: unknown } | null> {
  const leaseUntil = new Date(now.getTime() + LEASE_MS);
  if (row) {
    const claimed = await prisma.seoGeoAudit.updateMany({
      where: {
        id: row.id,
        nextAuditAt: row.nextAuditAt,
        OR: [{ leaseUntil: null }, { leaseUntil: { lte: now } }],
      },
      data: { leaseUntil, leaseOwner: INSTANCE },
    });
    return claimed.count === 1 ? { acknowledged: row.acknowledged } : null;
  }
  try {
    await prisma.seoGeoAudit.create({
      data: {
        workspaceId: target.workspaceId,
        projectId: target.projectId,
        isMock: applyMockMode(),
        siteId: target.siteId,
        // Yer tutucu: sonuç gelene kadar panel "bekliyor" gösterir (v: 0).
        result: { v: 0 },
        acknowledged: [],
        auditedAt: now,
        nextAuditAt: now,
        leaseUntil,
        leaseOwner: INSTANCE,
      },
    });
    return { acknowledged: [] };
  } catch (error) {
    if (isUniqueViolation(error)) return null;
    throw error;
  }
}

async function release(
  siteId: string,
  nextAuditAt: Date,
  lastError: string | null,
): Promise<void> {
  await prisma.seoGeoAudit.updateMany({
    where: { siteId, leaseOwner: INSTANCE },
    data: { leaseUntil: null, leaseOwner: null, nextAuditAt, lastError },
  });
}

async function recommendationsFor(
  target: Target,
  result: ReturnType<typeof evaluateGeo>,
  now: Date,
): Promise<StoredRecommendations | null> {
  const brand = await prisma.brand.findFirst({
    where: { projectId: target.projectId, isDefault: true },
    orderBy: { createdAt: "asc" },
    select: { id: true },
  });
  const written = brand
    ? await writeGeoRecommendations({
        workspaceId: target.workspaceId,
        projectId: target.projectId,
        brandId: brand.id,
        result,
      })
    : templateRecommendations(result);
  if (written.items.length === 0) return null;
  return {
    source: written.source,
    language: written.language,
    items: written.items,
    at: now.toISOString(),
  };
}

type AuditOutcome = "saved" | "no_crawl" | "skipped";

// Kilit alınmış bir sitenin denetimi: topla, değerlendir, öneri yaz, kaydet.
async function auditClaimed(
  target: Target,
  acknowledgedRaw: unknown,
  now: Date,
): Promise<AuditOutcome> {
  const collected = await collectGeoInput(target.projectId, { now });
  if (!collected.ok) {
    if (collected.reason === "not_allowed") {
      await release(target.siteId, new Date(now.getTime() + GEO_RETRY_MS), null);
      return "skipped";
    }
    await release(
      target.siteId,
      new Date(now.getTime() + GEO_RETRY_MS),
      "crawl_missing",
    );
    return "no_crawl";
  }
  if (collected.siteId !== target.siteId) {
    await release(target.siteId, new Date(now.getTime() + GEO_RETRY_MS), null);
    return "skipped";
  }
  const acknowledged = validAcknowledged(acknowledgedRaw);
  const result = evaluateGeo({ ...collected.input, acknowledged });
  const recommendations = await recommendationsFor(target, result, now);
  const fetchFailed =
    collected.input.home === null && collected.input.llms.state === "unknown";
  await saveGeoAudit({
    siteId: target.siteId,
    workspaceId: target.workspaceId,
    projectId: target.projectId,
    isMock: collected.isMock,
    scopeKey: collected.scopeKey,
    result,
    recommendations,
    acknowledged,
    now,
    nextAuditAt: nextAuditAfter(target.siteId, now),
    lastError: fetchFailed ? "fetch_failed" : null,
  });
  return "saved";
}

// Hata adı dışında hiçbir şey loglanmaz (modelin ya da sitenin metni olabilir).
async function guarded(
  target: Target,
  acknowledgedRaw: unknown,
  now: Date,
): Promise<AuditOutcome> {
  try {
    return await auditClaimed(target, acknowledgedRaw, now);
  } catch (error) {
    console.error(
      "[seo-geo] audit failed:",
      error instanceof Error ? error.name : "unknown",
    );
    await release(
      target.siteId,
      new Date(now.getTime() + GEO_RETRY_MS),
      "unknown",
    ).catch(() => undefined);
    return "skipped";
  }
}

type NewSite = { id: string; projectId: string; workspaceId: string };

// Henüz hiç denetlenmemiş, taranmış ve sayfa verisi olan siteler.
async function newSites(
  isMock: boolean,
  restricted: string[] | null,
  take: number,
): Promise<NewSite[]> {
  const scoped = restricted
    ? Prisma.sql`AND s."projectId" = ANY(${restricted})`
    : Prisma.empty;
  return prisma.$queryRaw<NewSite[]>`
    SELECT s."id", s."projectId", s."workspaceId"
    FROM "SeoSite" s
    WHERE s."isMock" = ${isMock}
      AND s."scopeKey" IS NOT NULL
      AND s."origin" IS NOT NULL
      AND s."lastFullCrawlAt" IS NOT NULL
      ${scoped}
      AND EXISTS (
        SELECT 1 FROM "SeoPage" p
        WHERE p."siteId" = s."id" AND p."status" = 200 AND p."goneAt" IS NULL
      )
      AND NOT EXISTS (
        SELECT 1 FROM "SeoGeoAudit" a WHERE a."siteId" = s."id"
      )
    ORDER BY s."createdAt" ASC
    LIMIT ${take}`;
}

export const SeoGeo = {
  // Tick adımı: en çok `limit` site denetler, denetlenen site sayısını döner.
  async runDue(limit = 2, now: Date = new Date()): Promise<number> {
    if (!seoGeoEnabled()) return 0;
    const restricted = seoApplyRestrictedProjects();
    if (restricted && restricted.length === 0) return 0;
    // Genel tarama sıklığı sınırı yalnız genel işe izinli süreçte; geliştirme
    // süreci izinli projelerini her turda kendisi bakar.
    if (
      seoApplyGlobalWorkAllowedHere() &&
      !(await claimPeriodic("seo.geo-scan", SCAN_EVERY_MS, now))
    ) {
      return 0;
    }
    const isMock = applyMockMode();
    let processed = 0;

    const due = await prisma.seoGeoAudit.findMany({
      where: {
        isMock,
        nextAuditAt: { not: null, lte: now },
        OR: [{ leaseUntil: null }, { leaseUntil: { lte: now } }],
        ...(restricted ? { projectId: { in: restricted } } : {}),
      },
      orderBy: { nextAuditAt: "asc" },
      take: DUE_BATCH,
    });
    for (const row of due) {
      if (processed >= limit) break;
      if (!seoGeoEnabledFor(row.projectId)) continue;
      const target = {
        siteId: row.siteId,
        projectId: row.projectId,
        workspaceId: row.workspaceId,
      };
      let claimed: { acknowledged: unknown } | null;
      try {
        claimed = await claim(target, row, now);
      } catch (error) {
        console.error(
          "[seo-geo] claim failed:",
          error instanceof Error ? error.name : "unknown",
        );
        continue;
      }
      if (!claimed) continue;
      processed += 1;
      await guarded(target, claimed.acknowledged, now);
    }

    if (processed < limit) {
      const fresh = await newSites(isMock, restricted, NEW_BATCH);
      for (const site of fresh) {
        if (processed >= limit) break;
        if (!seoGeoEnabledFor(site.projectId)) continue;
        const target = {
          siteId: site.id,
          projectId: site.projectId,
          workspaceId: site.workspaceId,
        };
        let claimed: { acknowledged: unknown } | null;
        try {
          claimed = await claim(target, null, now);
        } catch (error) {
          console.error(
            "[seo-geo] claim failed:",
            error instanceof Error ? error.name : "unknown",
          );
          continue;
        }
        if (!claimed) continue;
        processed += 1;
        await guarded(target, claimed.acknowledged, now);
      }
    }
    return processed;
  },

  // "Check again": en az 6 saat arayla, tek proje. Oturum ve rol denetimi
  // eylem katmanında yapılır.
  async auditNow(input: {
    projectId: string;
    userId: string;
    now?: Date;
  }): Promise<{ ok: true } | { ok: false; message: string }> {
    const now = input.now ?? new Date();
    if (!seoGeoEnabledFor(input.projectId)) {
      return {
        ok: false,
        message: "AI search visibility is not available for this project.",
      };
    }
    const site = await prisma.seoSite.findUnique({
      where: {
        projectId_isMock: {
          projectId: input.projectId,
          isMock: applyMockMode(),
        },
      },
      select: { id: true, workspaceId: true, scopeKey: true, origin: true },
    });
    if (!site || !site.scopeKey) {
      return { ok: false, message: "Verify your site on the Search page first." };
    }
    const row = await prisma.seoGeoAudit.findUnique({
      where: { siteId: site.id },
    });
    if (
      row &&
      parseGeoResult(row.result) !== null &&
      now.getTime() - row.auditedAt.getTime() < GEO_MANUAL_GAP_MS
    ) {
      return { ok: false, message: "You can check again in a few hours." };
    }
    const target = {
      siteId: site.id,
      projectId: input.projectId,
      workspaceId: site.workspaceId,
    };
    const claimed = await claim(target, row, now);
    if (!claimed) {
      return {
        ok: false,
        message: "A check is already running. Try again in a minute.",
      };
    }
    const outcome = await guarded(target, claimed.acknowledged, now);
    if (outcome === "saved") return { ok: true };
    if (outcome === "no_crawl") {
      return {
        ok: false,
        message: "Run the site audit first, then check again.",
      };
    }
    return {
      ok: false,
      message: "The check could not finish. Try again later.",
    };
  },
};
