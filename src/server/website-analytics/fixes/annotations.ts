import "server-only";

import { CapabilityKey, Prisma } from "@prisma/client";

import { prisma } from "@/lib/prisma";
import { dayKeyInTimezone, zonedDateTimeToUtc } from "@/lib/timezone";
import { safeTimezone } from "@/lib/website-analytics/days";
import { gaSyncAllowedFor } from "@/lib/website-analytics/flags";
import {
  gaAutoAnnotationsEnabled,
  gaPublishAnnotationsEnabled,
  gaSyncProjectAllowList,
} from "@/lib/website-analytics/fixes/flags";
import {
  ANNOTATION_MAX_LENGTH,
  ANNOTATION_PREFIX,
  sanitizeAnnotationSubject,
  validateFixParams,
} from "@/lib/website-analytics/fixes/validate";
import { resolveGaFixDeps } from "./deps";
import { ExecutionPolicy } from "@/server/execution/execution-policy";
import { isProjectAgencyActive } from "@/server/repositories/agency-loop-state.repository";

import { GaFixes } from "./fixes";

// GA-F7 otomatik not ÖNERİLERİ (docs/website-fixes.md, "Otomatik notlar"):
// `ga-annotations` tick adımı. YALNIZ önerir (Task + onay); burada Google'a
// hiçbir şey yazılmaz. İki tetikleyici: (1) son 3 günde başlatılan Meta
// kampanyası, (2) GA_FIXES_ANNOTATIONS_PUBLISH ile haftada en çok bir
// "yeni gönderiler yayınlandı" notu. Aynı konu için daha önce HERHANGİ bir
// durumda öneri varsa (reddedilmiş/süresi dolmuş dahil) yeniden önerilmez.
// Duraklatılmış projeler atlanır; açık-öneri sınırı (3) proposeGaFix'tedir.

const MAX_PER_TICK = 20;
const CANDIDATE_PROJECTS = 200;
const LAUNCH_WINDOW_MS = 3 * 24 * 60 * 60 * 1000;
const LAUNCH_TAKE = 50;
const DAY_MS = 24 * 60 * 60 * 1000;
const FALLBACK_CAMPAIGN = "ad campaign";
const LAUNCH_SUFFIX = " launched";
const PUBLISH_TITLE = "new posts published";

type Candidate = {
  linkId: string;
  projectId: string;
  timeZone: string | null;
};

function errorName(error: unknown): string {
  return error instanceof Error ? error.name : "unknown";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// spec.campaignName önce, sonra spec.plan.campaignName; biçim beklenmedikse
// sabit yedek ad. Metin temizlenir (URL, kontrol karakteri, < >) ve başlığa
// sığacak kadar kısaltılır.
export function launchCampaignName(spec: unknown): string {
  const candidates: unknown[] = [];
  if (isRecord(spec)) {
    candidates.push(spec.campaignName);
    if (isRecord(spec.plan)) candidates.push(spec.plan.campaignName);
  }
  const room =
    ANNOTATION_MAX_LENGTH - ANNOTATION_PREFIX.length - LAUNCH_SUFFIX.length;
  for (const candidate of candidates) {
    if (typeof candidate !== "string") continue;
    const cleaned = Array.from(sanitizeAnnotationSubject(candidate))
      .slice(0, room)
      .join("")
      .trim();
    if (cleaned) return cleaned;
  }
  return FALLBACK_CAMPAIGN;
}

export function launchAnnotationTitle(spec: unknown): string {
  return `${ANNOTATION_PREFIX}${launchCampaignName(spec)}${LAUNCH_SUFFIX}`;
}

// ISO hafta: "2026-W41" ve haftanın pazartesisi (gün anahtarı, mülk saati).
export function isoWeekOf(dayKey: string): { key: string; monday: string } {
  const [year, month, day] = dayKey.split("-").map(Number);
  const date = new Date(Date.UTC(year!, month! - 1, day!));
  const sinceMonday = (date.getUTCDay() + 6) % 7;
  const monday = new Date(date.getTime() - sinceMonday * DAY_MS);
  const thursday = new Date(monday.getTime() + 3 * DAY_MS);
  const isoYear = thursday.getUTCFullYear();
  const january4 = new Date(Date.UTC(isoYear, 0, 4));
  const firstMonday = new Date(
    january4.getTime() - ((january4.getUTCDay() + 6) % 7) * DAY_MS,
  );
  const week =
    1 + Math.round((monday.getTime() - firstMonday.getTime()) / (7 * DAY_MS));
  return {
    key: `${isoYear}-W${String(week).padStart(2, "0")}`,
    monday: monday.toISOString().slice(0, 10),
  };
}

const PUBLISH_CAPABILITIES: CapabilityKey[] = Object.values(
  CapabilityKey,
).filter((capability) => ExecutionPolicy.isPublish(capability));

// Aday projeler: birincil bağı olan, ACTIVE Analytics bağlantısında yazma izni
// (ya da mock bağ) bulunanlar. İzin listesi SQL'de uygulanır.
async function candidateProjects(mock: boolean): Promise<Candidate[]> {
  const allowList = gaSyncProjectAllowList();
  const allowSql =
    allowList === null
      ? Prisma.empty
      : Prisma.sql`AND l."projectId" = ANY(${allowList}::text[])`;
  return prisma.$queryRaw<Candidate[]>(Prisma.sql`
    SELECT l.id AS "linkId", l."projectId" AS "projectId", l."timeZone" AS "timeZone"
    FROM "GaPropertyLink" l
    JOIN "IntegrationCredential" c ON c.id = l."credentialId"
    WHERE l."isPrimary"
      AND l."isMock" = ${mock}
      AND c.provider = 'google_analytics'
      AND c.status = 'ACTIVE'
      AND (c.metadata -> 'gaEdit' IS NOT NULL OR l."isMock")
      ${allowSql}
    ORDER BY l."projectId"
    LIMIT ${CANDIDATE_PROJECTS}
  `);
}

// Bu bağların bu dedupeKey'lerinden herhangi birine sahip satırı (TÜM durumlar).
async function existingKeys(
  pairs: { linkId: string; dedupeKey: string }[],
): Promise<Set<string>> {
  if (pairs.length === 0) return new Set();
  const rows = await prisma.gaConfigChange.findMany({
    where: {
      linkId: { in: [...new Set(pairs.map((pair) => pair.linkId))] },
      dedupeKey: { in: [...new Set(pairs.map((pair) => pair.dedupeKey))] },
    },
    select: { linkId: true, dedupeKey: true },
  });
  return new Set(rows.map((row) => `${row.linkId}|${row.dedupeKey}`));
}

export const GaAnnotations = {
  // Tick adımı `ga-annotations`; döndürülen sayı oluşturulan öneri sayısıdır
  // (tick başına en çok 20). Bayrak kapalıyken sorgusuz 0.
  async runDue(limit = MAX_PER_TICK, now: Date = new Date()): Promise<number> {
    if (!gaAutoAnnotationsEnabled()) return 0;
    const cap = Math.min(Math.max(limit, 0), MAX_PER_TICK);
    if (cap === 0) return 0;
    try {
      const mock = resolveGaFixDeps().mock;
      const all = await candidateProjects(mock);
      const candidates = all.filter((row) => gaSyncAllowedFor(row.projectId));
      if (candidates.length === 0) return 0;

      // Duraklatılmış proje atlanır; sonuç tick içinde önbelleğe alınır.
      const activeCache = new Map<string, boolean>();
      const active = async (projectId: string): Promise<boolean> => {
        const cached = activeCache.get(projectId);
        if (cached !== undefined) return cached;
        const value = await isProjectAgencyActive(projectId);
        activeCache.set(projectId, value);
        return value;
      };
      const byProject = new Map(candidates.map((row) => [row.projectId, row]));

      let created = 0;

      // (1) Başlatılan kampanyalar.
      const launches = await prisma.adsLaunch.findMany({
        where: {
          projectId: { in: [...byProject.keys()] },
          status: "ACTIVE",
          activatedAt: { gte: new Date(now.getTime() - LAUNCH_WINDOW_MS) },
        },
        select: { id: true, projectId: true, activatedAt: true, spec: true },
        orderBy: { activatedAt: "desc" },
        take: LAUNCH_TAKE,
      });
      const launchPairs = launches.flatMap((launch) => {
        const candidate = byProject.get(launch.projectId);
        return candidate
          ? [
              {
                linkId: candidate.linkId,
                dedupeKey: `ANNOTATION_CREATE:launch:${launch.id}`,
              },
            ]
          : [];
      });
      const launchSeen = await existingKeys(launchPairs);
      for (const launch of launches) {
        if (created >= cap) break;
        const candidate = byProject.get(launch.projectId);
        if (!candidate || !launch.activatedAt) continue;
        const dedupeKey = `ANNOTATION_CREATE:launch:${launch.id}`;
        if (launchSeen.has(`${candidate.linkId}|${dedupeKey}`)) continue;
        try {
          if (!(await active(launch.projectId))) continue;
          const timeZone = safeTimezone(candidate.timeZone);
          const checked = validateFixParams(
            "ANNOTATION_CREATE",
            {
              title: launchAnnotationTitle(launch.spec),
              day: dayKeyInTimezone(launch.activatedAt, timeZone),
            },
            { today: dayKeyInTimezone(now, timeZone) },
          );
          if (!checked.ok || checked.params.kind !== "ANNOTATION_CREATE") {
            continue;
          }
          const result = await GaFixes.proposeAnnotation({
            projectId: launch.projectId,
            title: checked.params.title,
            day: checked.params.day,
            dedupeKey: `launch:${launch.id}`,
          });
          if (result.ok && result.created) created += 1;
        } catch (error) {
          console.error(
            `[ga-annotations] launch proposal failed: ${errorName(error)}`,
          );
        }
      }

      // (2) Haftalık "yeni gönderiler yayınlandı" notu (kendi alt bayrağı).
      if (gaPublishAnnotationsEnabled() && created < cap) {
        const weeks = candidates.map((candidate) => {
          const timeZone = safeTimezone(candidate.timeZone);
          const today = dayKeyInTimezone(now, timeZone);
          const week = isoWeekOf(today);
          return {
            candidate,
            timeZone,
            today,
            week,
            dedupeKey: `ANNOTATION_CREATE:publish:${week.key}`,
          };
        });
        const publishSeen = await existingKeys(
          weeks.map((entry) => ({
            linkId: entry.candidate.linkId,
            dedupeKey: entry.dedupeKey,
          })),
        );
        // Bu hafta notu henüz yazılmamış adaylar için tek sorgu: proje başına en son yayın görevi.
        const pending = weeks.filter(
          (entry) =>
            !publishSeen.has(`${entry.candidate.linkId}|${entry.dedupeKey}`),
        );
        const weekStarts = new Map(
          pending.map((entry) => [
            entry.candidate.projectId,
            zonedDateTimeToUtc(`${entry.week.monday}T00:00`, entry.timeZone),
          ]),
        );
        const latestPublish = new Map<string, Date>();
        if (pending.length > 0) {
          const earliest = new Date(
            Math.min(...[...weekStarts.values()].map((date) => date.getTime())),
          );
          const grouped = await prisma.task.groupBy({
            by: ["projectId"],
            where: {
              projectId: { in: [...weekStarts.keys()] },
              status: "COMPLETED",
              capability: { in: PUBLISH_CAPABILITIES },
              completedAt: { gte: earliest, lte: now },
            },
            _max: { completedAt: true },
          });
          for (const row of grouped) {
            if (row._max.completedAt) {
              latestPublish.set(row.projectId, row._max.completedAt);
            }
          }
        }
        for (const entry of pending) {
          if (created >= cap) break;
          const { candidate } = entry;
          try {
            const weekStart = weekStarts.get(candidate.projectId);
            const latest = latestPublish.get(candidate.projectId);
            if (!weekStart || !latest || latest < weekStart) continue;
            if (!(await active(candidate.projectId))) continue;
            const checked = validateFixParams(
              "ANNOTATION_CREATE",
              {
                title: `${ANNOTATION_PREFIX}${PUBLISH_TITLE}`,
                day: entry.week.monday,
              },
              { today: entry.today },
            );
            if (!checked.ok || checked.params.kind !== "ANNOTATION_CREATE") {
              continue;
            }
            const result = await GaFixes.proposeAnnotation({
              projectId: candidate.projectId,
              title: checked.params.title,
              day: checked.params.day,
              dedupeKey: `publish:${entry.week.key}`,
            });
            if (result.ok && result.created) created += 1;
          } catch (error) {
            console.error(
              `[ga-annotations] publish proposal failed: ${errorName(error)}`,
            );
          }
        }
      }
      return created;
    } catch (error) {
      console.error(`[ga-annotations] tick failed: ${errorName(error)}`);
      return 0;
    }
  },
};
