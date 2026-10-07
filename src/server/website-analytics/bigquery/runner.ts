import "server-only";

import { prisma } from "@/lib/prisma";
import {
  gaAgencyDevProjectScope,
  gaBigQueryEnabled,
} from "@/lib/website-analytics/agency/flags";
import { gaSyncAllowedFor } from "@/lib/website-analytics/flags";
import { claimPeriodic } from "@/server/observability/periodic";

import { GaBigQuery } from "./reader";

// `ga-bigquery` tick adımı (GA-F8): vadesi gelen BigQuery kaynaklarını okur. Bayrak
// kapalıyken hiçbir sorgu yapmaz. Aday: durumu OK | PENDING | ERROR, nextRunAt'ı
// gelmiş ve bağı birincil/ek mülk + sağlıklı olan kaynaklar, en eski vadeden başlayarak.
// ERROR da adaydır: hata dönüşünde nextRunAt geri çekilme süresine (1-6 saat)
// kurulur, böylece geçici hatalar (ör. paylaşım sonradan verildi) kendiliğinden
// düzelir. Yerel geliştirmede yalnız izin listesindeki projeler okunur.

const TICK_KEY = "ga.bigquery";
const RUN_EVERY_MS = 10 * 60_000;
const DEFAULT_LIMIT = 2;
const STATUSES = ["OK", "PENDING", "ERROR"];

// Geliştirme sürecinde (paylaşılan veritabanı) tick'in süreç içi kısması.
let lastLocalRunAt = 0;

export const GaBigQueryRunner = {
  async runDue(
    limit: number = DEFAULT_LIMIT,
    now: Date = new Date(),
  ): Promise<number> {
    if (!gaBigQueryEnabled()) return 0;
    const scope = gaAgencyDevProjectScope();
    if (scope && scope.length === 0) return 0;
    if (scope === null) {
      if (!(await claimPeriodic(TICK_KEY, RUN_EVERY_MS, now))) return 0;
    } else {
      if (now.getTime() - lastLocalRunAt < RUN_EVERY_MS) return 0;
      lastLocalRunAt = now.getTime();
    }

    const candidates = await prisma.gaBigQuerySource.findMany({
      where: {
        status: { in: [...STATUSES] },
        nextRunAt: { lte: now },
        ...(scope ? { projectId: { in: scope } } : {}),
        link: {
          OR: [{ isPrimary: true }, { isSecondary: true }],
          health: "OK",
        },
      },
      orderBy: { nextRunAt: "asc" },
      take: limit * 3,
      select: { id: true, projectId: true },
    });

    let processed = 0;
    for (const candidate of candidates) {
      if (processed >= limit) break;
      if (!gaSyncAllowedFor(candidate.projectId)) continue;
      try {
        const result = await GaBigQuery.syncSource(candidate.id, now);
        if (result !== "skipped") processed += 1;
      } catch (error) {
        console.error(
          "[ga-bigquery] source failed:",
          error instanceof Error ? error.name : "unknown",
        );
      }
    }
    return processed;
  },
};
