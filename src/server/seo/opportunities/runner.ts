import "server-only";

import { randomUUID } from "node:crypto";

import type { Prisma, SeoEngineState } from "@prisma/client";

import { prisma } from "@/lib/prisma";
import { addDays } from "@/lib/seo/dates";
import {
  gscGlobalWorkAllowedHere,
  gscRestrictedProjects,
} from "@/lib/seo/flags";
import {
  SeoInsightFlags,
  seoInsightsAllowedFor,
  seoInsightsMode,
} from "@/lib/seo/insight-flags";
import { evaluateSeoRules } from "@/lib/seo/rules";
import { gscMockMode } from "@/server/integrations/search-console/search-analytics";
import { Heartbeat } from "@/server/observability/heartbeat";

import { classifyQueries, scopeForProject } from "./classify";
import { readClusters, refreshClusters } from "./clusters";
import { fitAndStoreCurves } from "./curve";
import { embedPendingQueries } from "./embeddings";
import { persistFindings, type PersistResult } from "./findings-store";
import { maybeSuggestBrandTerms, publishOpportunityOutputs } from "./outputs";
import { loadRuleSnapshot } from "./snapshot";
import {
  ENGINE_CONTINUE_MS,
  ENGINE_RECHECK_MS,
  ENGINE_RUN_BUDGET_MS,
  claimEngineLease,
  deferEngineState,
  ensureEngineState,
  parseSeoCurves,
  releaseEngineLease,
  type SeoCurves,
} from "./state";

// SEO fırsat motoru (docs/search-opportunities.md "Zamanlama"):
// `seo-opportunities` tick adımı. Her koşuda sınıflama; haftalık aşama
// GscSiteLink.lastWeeklyWeek değişince ya da kip (shadow/on) değişince:
// embedding → CTR eğrisi → kümeler → anlık görüntü → SO1–SO16 → bulgular.
// Kip "on" iken (haftalık olsun olmasın) çıktılar ve marka önerileri süre
// bitmeden ≥ 20 sn kala çalışır; idempotenttir, sonraki koşularda tamamlanır.
// Bağ başına 10 dk CAS kilidi, 60 sn süre, 6 saatte bir yoklama; hata geri
// çekilmesi 30 dk'dan 24 saate. Geliştirme süreci nabız yazmaz ve yalnız
// izinli projelere dokunur. Bayrak kapalıyken hiçbir sorgu yok. Google'a ya
// da siteye çağrı yok.

const HEARTBEAT_KEY = "seo.opportunities";
const CANDIDATE_FACTOR = 3;
const BACKOFF_BASE_MS = 30 * 60_000;
const BACKOFF_MAX_MS = 24 * 3_600_000;
const ERROR_MAX_LENGTH = 300;

export type SeoEngineRunResult = {
  status:
    | "ran"
    | "not_due"
    | "busy"
    | "no_data"
    | "off"
    | "not_allowed"
    | "continue"
    | "failed";
  classified: number;
  embedded: number;
  clusters: number;
  persist: (Omit<PersistResult, "created"> & { created: number }) | null;
};

type RunStats = {
  mode: "shadow" | "on";
  lowData: boolean;
  evaluated: string[];
  skipped: { ruleKey: string; reason: string }[];
  fired: Record<string, number>;
  dropped: number;
  persist: {
    created: number;
    updated: number;
    touched: number;
    superseded: number;
    resolved: number;
    expired: number;
    suppressed: number;
  } | null;
  llmSkipped: "budget" | null;
};

function statsRecord(value: Prisma.JsonValue | null): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function json(value: unknown): Prisma.InputJsonValue {
  return value as Prisma.InputJsonValue;
}

export function engineBackoffMs(failures: number): number {
  return Math.min(
    BACKOFF_BASE_MS * 2 ** Math.max(0, failures - 1),
    BACKOFF_MAX_MS,
  );
}

// Hata özeti: sınıf adı ve mesaj (≤ 300); sorgu metni taşımaz (SQL değerleri
// parametre olarak gider, mesajlara girmez).
function errorText(error: unknown): string {
  const name = error instanceof Error ? error.name : "UnknownError";
  const message = error instanceof Error ? error.message : String(error);
  return `${name}: ${message}`.slice(0, ERROR_MAX_LENGTH);
}

function result(
  status: SeoEngineRunResult["status"],
  counts: Partial<Omit<SeoEngineRunResult, "status">> = {},
): SeoEngineRunResult {
  return {
    status,
    classified: counts.classified ?? 0,
    embedded: counts.embedded ?? 0,
    clusters: counts.clusters ?? 0,
    persist: counts.persist ?? null,
  };
}

function storedCurves(state: SeoEngineState): SeoCurves | null {
  return state.curves ? parseSeoCurves(state.curves) : null;
}

export const SeoOpportunities = {
  // Tick adımı.
  async runDue(limit = 2, now: Date = new Date()): Promise<number> {
    if (!SeoInsightFlags.active()) return 0;
    const global = gscGlobalWorkAllowedHere();
    if (global) await Heartbeat.beat(HEARTBEAT_KEY, now);
    const restricted = gscRestrictedProjects();
    if (restricted && restricted.length === 0) {
      if (global) await Heartbeat.ok(HEARTBEAT_KEY, now);
      return 0;
    }

    const candidates = await prisma.gscSiteLink.findMany({
      where: {
        isPrimary: true,
        isMock: gscMockMode(),
        lastWeeklyWeek: { not: null },
        health: { notIn: ["GONE", "ACCESS_LOST"] },
        ...(restricted ? { projectId: { in: restricted } } : {}),
        OR: [
          { seoEngineState: { is: null } },
          { seoEngineState: { is: { nextRunAt: null } } },
          { seoEngineState: { is: { nextRunAt: { lte: now } } } },
        ],
      },
      orderBy: { updatedAt: "asc" },
      take: limit * CANDIDATE_FACTOR,
      select: { id: true, projectId: true, workspaceId: true, isMock: true },
    });
    const projects =
      candidates.length > 0
        ? await prisma.project.findMany({
            where: { id: { in: candidates.map((link) => link.projectId) } },
            select: { id: true, status: true },
          })
        : [];
    const active = new Set(
      projects
        .filter((project) => project.status === "ACTIVE")
        .map((project) => project.id),
    );

    let processed = 0;
    for (const candidate of candidates) {
      if (processed >= limit) break;
      if (
        !active.has(candidate.projectId) ||
        !seoInsightsAllowedFor(candidate.projectId)
      ) {
        // Atlanan aday sıradan çıkar (6 saat sonra yeniden bakılır).
        await deferEngineState(
          candidate,
          new Date(now.getTime() + ENGINE_RECHECK_MS),
        );
        continue;
      }
      const outcome = await this.runLink(candidate.id, { now });
      if (
        outcome.status !== "busy" &&
        outcome.status !== "off" &&
        outcome.status !== "not_allowed"
      ) {
        processed += 1;
      }
    }
    if (global) await Heartbeat.ok(HEARTBEAT_KEY, now);
    return processed;
  },

  async runLink(
    linkId: string,
    options: { now?: Date; force?: boolean } = {},
  ): Promise<SeoEngineRunResult> {
    const now = options.now ?? new Date();
    if (!SeoInsightFlags.active()) return result("off");
    const link = await prisma.gscSiteLink.findUnique({ where: { id: linkId } });
    if (
      !link ||
      !link.isPrimary ||
      link.isMock !== gscMockMode() ||
      !seoInsightsAllowedFor(link.projectId)
    ) {
      return result("not_allowed");
    }

    const state = await ensureEngineState(link);
    const owner = randomUUID();
    if (!(await claimEngineLease(state.id, owner, now))) return result("busy");
    const deadline = Date.now() + ENGINE_RUN_BUDGET_MS;
    const recheckAt = new Date(now.getTime() + ENGINE_RECHECK_MS);
    const mode: "shadow" | "on" = seoInsightsMode() === "on" ? "on" : "shadow";

    try {
      const scope = await scopeForProject(link.projectId);
      const classify = await classifyQueries({
        link,
        stateId: state.id,
        intentBrandHash: state.intentBrandHash,
        scope,
        deadline,
        now,
      });
      const week = link.lastWeeklyWeek;
      if (!week) {
        await releaseEngineLease(state.id, owner, {
          nextRunAt: recheckAt,
          consecutiveFailures: 0,
          lastError: null,
        });
        return result("no_data", { classified: classify.classified });
      }

      const previousStats = statsRecord(state.lastRunStats);
      const previousMode = previousStats.mode;
      const weekly =
        options.force === true ||
        state.lastWeek !== week ||
        previousMode !== mode;

      let budgetHit = classify.budgetHit;
      let embedded = 0;
      let clusterCount = 0;
      let persisted: PersistResult | null = null;
      let stats: RunStats | null = null;

      if (weekly) {
        const embeddings = await embedPendingQueries({
          link,
          scope,
          week,
          deadline,
          now,
        });
        embedded = embeddings.embedded;
        budgetHit ||= embeddings.budgetHit;

        const curves =
          (state.curvesWeek === week ? storedCurves(state) : null) ??
          (await fitAndStoreCurves({ link, stateId: state.id, week, now }));

        if (state.clustersWeek !== week) {
          const refreshed = await refreshClusters({ link, scope, week, now });
          clusterCount = refreshed.clusters;
          budgetHit ||= refreshed.budgetHit;
        }
        const clusters = await readClusters(link.id);
        if (clusterCount === 0) clusterCount = clusters.length;

        const snapshot = await loadRuleSnapshot({
          link,
          week,
          curves,
          clusters,
          now,
        });
        if (!snapshot) {
          // Şimdiki 4 haftanın özetlerinden biri eksik: lastWeek ilerlemez.
          await releaseEngineLease(state.id, owner, {
            nextRunAt: recheckAt,
            consecutiveFailures: 0,
            lastError: null,
          });
          return result("no_data", {
            classified: classify.classified,
            embedded,
            clusters: clusterCount,
          });
        }
        if (Date.now() > deadline) {
          // Kurallara süre kalmadı: eğri ve kümeler yazıldı, kısa süre sonra
          // devam edilir.
          await releaseEngineLease(state.id, owner, {
            nextRunAt: new Date(now.getTime() + ENGINE_CONTINUE_MS),
            consecutiveFailures: 0,
            lastError: null,
          });
          return result("continue", {
            classified: classify.classified,
            embedded,
            clusters: clusterCount,
          });
        }

        const run = evaluateSeoRules(snapshot);
        persisted = await persistFindings({ link, run, mode, now });
        stats = {
          mode,
          lowData: run.lowData,
          evaluated: [...run.evaluated],
          skipped: run.skipped.map((item) => ({
            ruleKey: item.ruleKey,
            reason: item.reason,
          })),
          fired: { ...run.fired },
          dropped: run.dropped,
          persist: {
            created: persisted.created.length,
            updated: persisted.updated,
            touched: persisted.touched,
            superseded: persisted.superseded,
            resolved: persisted.resolved,
            expired: persisted.expired,
            suppressed: persisted.suppressed,
          },
          llmSkipped: null,
        };
      }

      // Çıktılar: yalnız "on" ve bu haftanın bulguları yazılmışsa; haftalık
      // olmayan koşular da yarım kalanı tamamlar.
      const lastWeek = weekly ? week : state.lastWeek;
      let explained = 0;
      if (SeoInsightFlags.userFacing() && lastWeek === week) {
        const outputs = await publishOpportunityOutputs({
          link,
          week,
          periodKey: `W:${addDays(week, 6)}`,
          now,
          deadline,
        }).catch(() => ({ explained: 0, signals: 0, budgetHit: false }));
        explained = outputs.explained;
        budgetHit ||= outputs.budgetHit;
        const suggestions = await maybeSuggestBrandTerms({
          link,
          now,
          deadline,
        }).catch(() => ({ ran: false, budgetHit: false }));
        budgetHit ||= suggestions.budgetHit;
      }
      const llmSkipped: "budget" | null = budgetHit ? "budget" : null;

      if (stats) {
        stats.llmSkipped = llmSkipped;
        await releaseEngineLease(state.id, owner, {
          lastWeek: week,
          lastRunAt: now,
          lastRunStats: json(stats),
          nextRunAt: recheckAt,
          consecutiveFailures: 0,
          lastError: null,
        });
      } else {
        await releaseEngineLease(state.id, owner, {
          lastRunAt: now,
          ...(state.lastRunStats
            ? { lastRunStats: json({ ...previousStats, llmSkipped }) }
            : {}),
          nextRunAt: recheckAt,
          consecutiveFailures: 0,
          lastError: null,
        });
      }

      const persist = persisted
        ? {
            created: persisted.created.length,
            updated: persisted.updated,
            touched: persisted.touched,
            superseded: persisted.superseded,
            resolved: persisted.resolved,
            expired: persisted.expired,
            suppressed: persisted.suppressed,
          }
        : null;
      const status: SeoEngineRunResult["status"] = weekly
        ? "ran"
        : classify.classified > 0 || explained > 0
          ? "ran"
          : "not_due";
      return result(status, {
        classified: classify.classified,
        embedded,
        clusters: clusterCount,
        persist,
      });
    } catch (error) {
      const failures = state.consecutiveFailures + 1;
      await releaseEngineLease(state.id, owner, {
        consecutiveFailures: { increment: 1 },
        lastError: errorText(error),
        nextRunAt: new Date(now.getTime() + engineBackoffMs(failures)),
      }).catch(() => undefined);
      console.error(
        `[seo-opportunities] link ${link.id} failed (attempt ${failures}):`,
        error instanceof Error ? error.name : "UnknownError",
      );
      return result("failed");
    }
  },
};
