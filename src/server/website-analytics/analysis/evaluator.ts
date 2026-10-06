import "server-only";

import type { GaFinding, Prisma } from "@prisma/client";

import { prisma } from "@/lib/prisma";
import { dayKeyInTimezone } from "@/lib/timezone";
import {
  gaInsightsDevProjectScope,
  gaInsightsMode,
} from "@/lib/website-analytics/analysis/flags";
import { evaluateGaOutcome } from "@/lib/website-analytics/analysis/outcomes";
import { isGaRuleKey } from "@/lib/website-analytics/analysis/registry";
import {
  GA_EVAL_GRACE_DAYS,
  GA_EVALUATE_AFTER_DAYS,
  evaluationWindows,
} from "@/lib/website-analytics/analysis/schedule";
import { parseGaFindingEvidence } from "@/lib/website-analytics/analysis/stored";
import type {
  GaFindingOutcome,
  GaOutcomeEvidence,
  GaRange,
  GaWindowReport,
} from "@/lib/website-analytics/analysis/types";
import { safeTimezone } from "@/lib/website-analytics/days";
import { gaGlobalWorkAllowedHere } from "@/lib/website-analytics/flags";
import { completeThroughOf } from "@/lib/website-analytics/health/schedule";
import { Heartbeat } from "@/server/observability/heartbeat";
import { claimPeriodic } from "@/server/observability/periodic";

import { loadExcludedDays } from "./inputs";
import { writeFindingLearning } from "./learnings";
import { GaFindingRetention } from "./retention";
import { sweepIdleLinks } from "./sweep";
import { loadGaWindowTables } from "./windows";

// GA-F4 sonuç değerlendirmesi (docs/website-insights.md "Değerlendirme",
// plan §6.3): `ga-finding-evaluate` tick adımı. "Mark done" denmiş bulgu
// doneAt + 36 günden sonra, after penceresinin verisi gelince önce [d−28,
// d−1] / sonra [d+7, d+34] pencereleriyle (şüpheli günler dışarıda)
// değerlendirilir; veri yetmezse doneAt + 50 güne kadar bekler, sonra
// INCONCLUSIVE. Yalnız canlı ve mock olmayan WORKED öğrenme yazar. Canlıda
// paylaşılan 30 dakikalık kilit; geliştirme süreci süreç içi kısma kullanır,
// paylaşılan kilide ve nabza hiç dokunmaz, yalnız GA_SYNC_DEV_PROJECTS'i
// okur. Turun sonunda analizi duran bağların süpürmesi (sweep.ts
// sweepIdleLinks) ve saklama (yalnız canlıda); bayrak kapalıyken de satır
// kaldığı sürece saklama sürer.

const EVALUATE_KEY = "ga.findings.evaluate";
const EVERY_MS = 30 * 60_000;
const CLAIM_MS = 3_600_000;
const RETRY_MS = 86_400_000;
const DAY_MS = 86_400_000;
const OUTCOME_REPORTS: readonly GaWindowReport[] = [
  "landing",
  "channel",
  "device",
  "campaign",
  "pages",
  "events",
];

// Geliştirme süreci için süreç içi kısma (paylaşılan kilit yerine).
let devLastRunAt = 0;

function trackingIssue(windows: {
  before: GaRange;
  after: GaRange;
}): GaOutcomeEvidence {
  return {
    v: 1,
    before: { ...windows.before, sessions: 0, hits: 0, rate: null },
    after: { ...windows.after, sessions: 0, hits: 0, rate: null },
    siteBefore: null,
    siteAfter: null,
    p: null,
    upliftPct: null,
    siteUpliftPct: null,
    reason: "tracking_issue",
  };
}

async function finish(
  row: GaFinding,
  outcome: GaFindingOutcome,
  evidence: GaOutcomeEvidence,
  now: Date,
): Promise<boolean> {
  const updated = await prisma.gaFinding.updateMany({
    where: { id: row.id, status: "DONE" },
    data: {
      status: "EVALUATED",
      outcome,
      outcomeEvidence: evidence as unknown as Prisma.InputJsonValue,
      evaluatedAt: now,
      closedAt: now,
      closedReason: "evaluated",
    },
  });
  return updated.count === 1;
}

async function retry(row: GaFinding, now: Date): Promise<void> {
  await prisma.gaFinding.updateMany({
    where: { id: row.id, status: "DONE" },
    data: { evaluateAfter: new Date(now.getTime() + RETRY_MS) },
  });
}

async function evaluateRow(row: GaFinding, now: Date): Promise<boolean> {
  const link = await prisma.gaPropertyLink.findUnique({
    where: { id: row.linkId },
  });
  const timeZone = safeTimezone(link?.timeZone);
  const doneAt =
    row.doneAt ??
    new Date(
      (row.evaluateAfter ?? now).getTime() - GA_EVALUATE_AFTER_DAYS * DAY_MS,
    );
  const windows = evaluationWindows(dayKeyInTimezone(doneAt, timeZone));
  const evidence = parseGaFindingEvidence(row.evidence);
  if (!link || !evidence || !isGaRuleKey(row.ruleKey)) {
    return finish(row, "INCONCLUSIVE", trackingIssue(windows), now);
  }

  const graceOver =
    now.getTime() >
    doneAt.getTime() + (GA_EVALUATE_AFTER_DAYS + GA_EVAL_GRACE_DAYS) * DAY_MS;
  const completeThrough = completeThroughOf(link.lastDailyDate);
  if ((!completeThrough || completeThrough < windows.after.to) && !graceOver) {
    await retry(row, now);
    return false;
  }

  const { suspect } = await loadExcludedDays(link.id, null, {
    from: windows.before.from,
    to: windows.after.to,
  });
  const options = { exclude: suspect, reports: OUTCOME_REPORTS };
  const [before, after] = await Promise.all([
    loadGaWindowTables(link.id, windows.before, options),
    loadGaWindowTables(link.id, windows.after, options),
  ]);
  const result = evaluateGaOutcome({
    ruleKey: row.ruleKey,
    evidence,
    before,
    after,
    graceOver,
  });
  if (result.wait) {
    await retry(row, now);
    return false;
  }
  const finished = await finish(row, result.outcome, result.evidence, now);
  if (
    finished &&
    result.outcome === "WORKED" &&
    row.mode === "live" &&
    !row.isMock
  ) {
    await writeFindingLearning(row.id, now).catch((error: unknown) => {
      console.error(
        "[ga-finding-evaluate] learning could not be written:",
        error instanceof Error ? error.name : "unknown",
      );
    });
  }
  return finished;
}

export const GaFindingEvaluator = {
  // Tick adımı.
  async runDue(limit = 20, now: Date = new Date()): Promise<number> {
    if (gaInsightsMode() === "off") {
      await GaFindingRetention.runWhileOff(now);
      return 0;
    }
    const scope = gaInsightsDevProjectScope();
    if (scope && scope.length === 0) return 0;
    const global = gaGlobalWorkAllowedHere();
    if (global) {
      if (!(await claimPeriodic(EVALUATE_KEY, EVERY_MS, now))) {
        await GaFindingRetention.runDue(now);
        return 0;
      }
    } else {
      if (now.getTime() - devLastRunAt < EVERY_MS) return 0;
      devLastRunAt = now.getTime();
    }

    const rows = await prisma.gaFinding.findMany({
      where: {
        status: "DONE",
        evaluateAfter: { lte: now },
        ...(scope ? { projectId: { in: scope } } : {}),
      },
      orderBy: { evaluateAfter: "asc" },
      take: limit,
    });
    let evaluated = 0;
    for (const row of rows) {
      // Satır başına kilit: evaluateAfter bir saat ileri alınır.
      const claimed = await prisma.gaFinding.updateMany({
        where: { id: row.id, status: "DONE", evaluateAfter: row.evaluateAfter },
        data: { evaluateAfter: new Date(now.getTime() + CLAIM_MS) },
      });
      if (claimed.count !== 1) continue;
      try {
        if (await evaluateRow(row, now)) evaluated += 1;
      } catch (error) {
        console.error(
          "[ga-finding-evaluate] finding could not be evaluated:",
          error instanceof Error ? error.name : "unknown",
        );
      }
    }
    await sweepIdleLinks({ now, projectIds: scope }).catch((error: unknown) => {
      console.error(
        "[ga-finding-evaluate] idle links could not be swept:",
        error instanceof Error ? error.name : "unknown",
      );
    });
    await GaFindingRetention.runDue(now);
    if (global) await Heartbeat.ok(EVALUATE_KEY, now);
    return evaluated;
  },
};

// Testler için süreç içi kısmayı sıfırlar.
export function resetGaFindingEvaluatorThrottle(): void {
  devLastRunAt = 0;
}
