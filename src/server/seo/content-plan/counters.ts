import "server-only";

import { prisma } from "@/lib/prisma";
import { SeoContentPlanFlags } from "@/lib/seo/content-plan/flags";
import {
  parseContentPlanData,
  PLAN_EMPTY_REASONS,
  type PlanEmptyReason,
} from "@/lib/seo/content-plan/types";
import { gscMockMode } from "@/server/integrations/search-console/search-analytics";

// /health "SEO content plan" operatör sayaçları (SC-F7, docs/search-content-plan.md):
// yalnız sayılar. Plan satırları bellekte okunur ama dışarı yalnız toplamlar
// çıkar; anahtar kelime, başlık, yol, proje kimliği ya da kullanıcı metni
// sonuca girmez (Limited Use). SEO_CONTENT_PLAN kapalıyken veritabanına
// gidilmez. Her sayaç kendi hatasında 0 olur. Yalnız geçerli kipin
// (gerçek/mock) plan satırları sayılır. capBlocked ve yenileme sayısı
// denetim kaydından gelir (metadata okunmaz).

export type SeoContentPlanCounters = {
  plans30d: number;
  empty30d: number;
  byEmptyReason: Partial<Record<PlanEmptyReason, number>>;
  slotsPlanned: number;
  slotsWritten: number;
  slotsPublished: number;
  slotsSkipped: number;
  wordingBasic30d: number;
  regenerations30d: number;
  capBlocked30d: number;
  projectsWithPlan: number;
};

const DAY_MS = 86_400_000;
const WINDOW_DAYS = 30;
// Bir ayda proje başına bir plan; 30 günlük pencere bunun çok altında kalır.
const ROWS_MAX = 2000;

type PlanRow = {
  projectId: string;
  status: string;
  wording: string;
  data: unknown;
};

function isEmptyReason(value: string | null): value is PlanEmptyReason {
  return (
    value !== null && (PLAN_EMPTY_REASONS as readonly string[]).includes(value)
  );
}

export async function loadSeoContentPlanCounters(
  now: Date = new Date(),
): Promise<SeoContentPlanCounters | null> {
  if (!SeoContentPlanFlags.on()) return null;
  const isMock = gscMockMode();
  const since = new Date(now.getTime() - WINDOW_DAYS * DAY_MS);
  const zero = () => 0;
  const [rows, regenerations30d, capBlocked30d] = await Promise.all([
    prisma.seoContentPlan
      .findMany({
        where: { isMock, createdAt: { gte: since } },
        select: { projectId: true, status: true, wording: true, data: true },
        orderBy: { createdAt: "desc" },
        take: ROWS_MAX,
      })
      .then((found): PlanRow[] => found)
      .catch((): PlanRow[] => []),
    prisma.auditLog
      .count({
        where: {
          action: "seo_content_plan.regenerated",
          createdAt: { gte: since },
        },
      })
      .catch(zero),
    prisma.auditLog
      .count({
        where: {
          action: "seo_content_plan.cap_blocked",
          createdAt: { gte: since },
        },
      })
      .catch(zero),
  ]);

  const byEmptyReason: Partial<Record<PlanEmptyReason, number>> = {};
  const projects = new Set<string>();
  const plannedCreativeIds: string[] = [];
  let empty30d = 0;
  let wordingBasic30d = 0;
  let slotsPlanned = 0;
  let slotsSkipped = 0;
  for (const row of rows) {
    const data = parseContentPlanData(row.data);
    if (row.status === "EMPTY") {
      empty30d += 1;
      if (isEmptyReason(data.reason)) {
        byEmptyReason[data.reason] = (byEmptyReason[data.reason] ?? 0) + 1;
      }
      continue;
    }
    // Boş satırın wording'i şema varsayılanıdır (BASIC); yalnız yazılmış
    // planlar sayılır.
    if (row.wording === "BASIC") wordingBasic30d += 1;
    projects.add(row.projectId);
    for (const slot of data.slots) {
      // Yalnız geçerli (PLANNED) yuvalar planlı sayılır: REMOVED yenisiyle birlikte, SKIPPED ayrı sayıyla iki kez görünmesin.
      if (slot.status === "PLANNED") slotsPlanned += 1;
      if (slot.status === "SKIPPED") slotsSkipped += 1;
      if (slot.status === "PLANNED" && slot.creativeId) {
        plannedCreativeIds.push(slot.creativeId);
      }
    }
  }

  // Yazılan ve yayınlanan makaleler: yalnız Creative durumuna göre sayı
  // (canlı durum plan JSON'undan değil Creative'dan okunur).
  const statusCounts =
    plannedCreativeIds.length > 0
      ? await prisma.creative
          .groupBy({
            by: ["status"],
            where: { id: { in: plannedCreativeIds } },
            _count: { _all: true },
          })
          .catch(() => [] as { status: string; _count: { _all: number } }[])
      : [];
  const statusCount = (status: string) =>
    statusCounts.find((entry) => entry.status === status)?._count._all ?? 0;
  const slotsPublished = statusCount("PUBLISHED");

  return {
    // Yazılmış planlar: boş satırlar empty30d'de ayrı sayılır.
    plans30d: rows.length - empty30d,
    empty30d,
    byEmptyReason,
    slotsPlanned,
    slotsWritten: statusCount("APPROVED") + slotsPublished,
    slotsPublished,
    slotsSkipped,
    wordingBasic30d,
    regenerations30d,
    capBlocked30d,
    projectsWithPlan: projects.size,
  };
}
