import "server-only";

import { prisma } from "@/lib/prisma";
import { parseSettings } from "@/lib/seo/content-plan/cap";
import {
  SeoContentPlanFlags,
  seoContentPlanActiveFor,
} from "@/lib/seo/content-plan/flags";
import { planWindow } from "@/lib/seo/content-plan/schedule";
import {
  gscGlobalWorkAllowedHere,
  gscRestrictedProjects,
} from "@/lib/seo/flags";
import { dayKeyInTimezone, utcToZonedDateTimeLocal } from "@/lib/timezone";
import { gscMockMode } from "@/server/integrations/search-console/search-analytics";
import { isModulesEnabled } from "@/server/works/flag";

import { safeTimezone } from "./cap-status";
import { createMonthlyPlan } from "./planner";
import { sweepStaleSlots } from "./sweep";

// Aylık SEO içerik planı tick adımı `seo-content-plan` (docs/search-content-
// plan.md "Plan nasıl kurulur" 1). Proje başına yerel ayda bir kez, ayın 2'si
// 09:00'dan ayın son 7 gününe kadar ("open" pencere; roadmap raporu 4'ünde
// çıkar, plan ondan önce hazır olur). Yeni aya girerken önce önceki ayların
// dokunulmamış slotları süpürülür. Bayrak ya da modüller kapalıyken hemen 0
// (hiç sorgu yok); izin listesi boşsa 0; geliştirme süreci canlı veritabanını
// paylaşırken yalnız izinli projelere dokunur ve mock bağlara hiç bakmaz.
// Google'a ya da siteye çağrı yok.

const LINK_BATCH = 50;
const HOUR_MS = 3_600_000;
// Süreç içi karar önbelleği (sorgusuz atlama): çözülmüş ay 12 saat, "henüz
// yok" 1 saat, hata 10 dakika.
const SETTLED_MS = 12 * HOUR_MS;
const NOTHING_YET_MS = HOUR_MS;
const FAILED_MS = 10 * 60_000;
// Boş satırların yeniden bakma gecikmesi (veri/küme/boşluk yoksa).
const EMPTY_RECHECK_MS = 24 * HOUR_MS;
const RECHECK_REASONS = ["NO_DATA", "NO_CLUSTERS", "NO_GAPS"];

const UNHEALTHY = ["AUTH", "NEEDS_PERMISSION", "ACCESS_LOST", "GONE"];

const decided = new Map<string, { month: string; until: number }>();
const swept = new Map<string, string>();

export function __clearContentPlanMemo(): void {
  decided.clear();
  swept.clear();
}

function reasonOf(data: unknown): string | null {
  if (!data || typeof data !== "object" || Array.isArray(data)) return null;
  const reason = (data as { reason?: unknown }).reason;
  return typeof reason === "string" ? reason : null;
}

// Boş satırın yeniden değerlendirilme zamanı geldi mi: veri/küme/boşluk yoksa
// 24 saat sonra; yapay zekâ sınırı (AI_LIMIT) bir sonraki yerel günden; diğer
// nedenler (CAP_FULL, NO_ROOM, ALL_FILTERED) ay boyunca çözülmüştür.
function emptyRowDue(
  row: { data: unknown; updatedAt: Date },
  now: Date,
  timezone: string,
): "due" | "wait" | "settled" {
  const reason = reasonOf(row.data);
  if (reason !== null && RECHECK_REASONS.includes(reason)) {
    return now.getTime() - row.updatedAt.getTime() >= EMPTY_RECHECK_MS
      ? "due"
      : "wait";
  }
  if (reason === "AI_LIMIT") {
    return dayKeyInTimezone(row.updatedAt, timezone) <
      dayKeyInTimezone(now, timezone)
      ? "due"
      : "wait";
  }
  return "settled";
}

export const SeoContentPlans = {
  // En çok `limit` plan işler; kurulan ya da boş yazılan plan sayısını döner.
  async runDue(limit = 2, now: Date = new Date()): Promise<number> {
    if (!SeoContentPlanFlags.on() || !isModulesEnabled()) return 0;
    const restricted = gscRestrictedProjects();
    if (restricted && restricted.length === 0) return 0;

    const links = await prisma.gscSiteLink.findMany({
      where: {
        isPrimary: true,
        isMock: gscMockMode(),
        lastWeeklyWeek: { not: null },
        health: { notIn: UNHEALTHY },
        ...(restricted ? { projectId: { in: restricted } } : {}),
      },
      orderBy: { updatedAt: "asc" },
      take: LINK_BATCH,
    });
    if (links.length === 0) return 0;

    const projectIds = links.map((link) => link.projectId);
    const [projects, schedules] = await Promise.all([
      prisma.project.findMany({
        where: { id: { in: projectIds }, status: "ACTIVE" },
        select: { id: true },
      }),
      prisma.projectSchedule.findMany({
        where: {
          capability: "INSTAGRAM_PUBLISH",
          projectId: { in: projectIds },
        },
        select: { projectId: true, timezone: true },
      }),
    ]);
    const active = new Set(projects.map((project) => project.id));
    const timezoneOf = new Map(
      schedules.map((row) => [row.projectId, row.timezone] as const),
    );
    const globalWork = gscGlobalWorkAllowedHere();

    let processed = 0;
    for (const link of links) {
      if (processed >= limit) break;
      const projectId = link.projectId;
      if (!active.has(projectId) || !seoContentPlanActiveFor(projectId)) {
        continue;
      }
      // Canlı veritabanını paylaşan geliştirme süreci mock bağlara dokunmaz.
      if (link.isMock && !globalWork) continue;

      const timezone = safeTimezone(
        timezoneOf.get(projectId) ?? "Europe/Istanbul",
      );
      const local = utcToZonedDateTimeLocal(now, timezone);
      const window = planWindow(local);
      const month = window.month;
      if (!month) continue;
      const memo = decided.get(projectId);
      if (memo && memo.month === month && now.getTime() < memo.until) continue;
      const remember = (ms: number) =>
        decided.set(projectId, { month, until: now.getTime() + ms });

      try {
        // Yeni ayın ilk bakışında önce eski ayların dokunulmamış slotları.
        if (swept.get(projectId) !== month) {
          await sweepStaleSlots({
            linkId: link.id,
            projectId,
            currentMonth: month,
            timezone,
            now,
          });
          swept.set(projectId, month);
        }
        // Yalnız "open" pencere kendiliğinden planlar (erken/geç: sorgusuz).
        if (window.state !== "open") continue;

        const setting = await prisma.seoContentSetting.findUnique({
          where: { projectId },
        });
        if (!parseSettings(setting).autoPlan) {
          // Sahip bu akşam açabilir: kısa süre sonra yeniden bakılır.
          remember(NOTHING_YET_MS);
          continue;
        }

        const row = await prisma.seoContentPlan.findUnique({
          where: { linkId_month: { linkId: link.id, month } },
          select: { status: true, data: true, updatedAt: true },
        });
        if (row?.status === "ACTIVE") {
          remember(SETTLED_MS);
          continue;
        }
        if (row) {
          const due = emptyRowDue(row, now, timezone);
          if (due !== "due") {
            remember(due === "settled" ? SETTLED_MS : NOTHING_YET_MS);
            continue;
          }
        }

        const outcome = await createMonthlyPlan({
          link,
          month,
          timezone,
          now,
          trigger: "auto",
        });
        switch (outcome.status) {
          case "created":
            processed += 1;
            remember(SETTLED_MS);
            break;
          case "empty":
            processed += 1;
            remember(
              RECHECK_REASONS.includes(outcome.reason) ||
                outcome.reason === "AI_LIMIT"
                ? NOTHING_YET_MS
                : SETTLED_MS,
            );
            break;
          case "exists":
            remember(SETTLED_MS);
            break;
          case "retry":
            remember(outcome.reason === "BUSY" ? FAILED_MS : NOTHING_YET_MS);
            break;
          case "off":
            remember(NOTHING_YET_MS);
            break;
        }
      } catch (error) {
        remember(FAILED_MS);
        // Hata metni Google verisi taşıyabilir: yalnız tür adı loglanır.
        console.error(
          `[seo-content-plan] plan failed for project ${projectId}:`,
          error instanceof Error ? error.name : "UnknownError",
        );
      }
    }
    return processed;
  },
};
