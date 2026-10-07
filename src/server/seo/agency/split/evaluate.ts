import "server-only";

import type { Prisma } from "@prisma/client";

import { prisma } from "@/lib/prisma";
import { EVAL_GIVE_UP_DAYS, EVAL_RETRY_MS } from "@/lib/seo/actions/lifecycle";
import {
  MIN_POST_WEEKS,
  MIN_PRE_WEEKS,
  dayInRange,
  evaluationWindows,
  queryBounds,
  rankingUpdatesOverlapping,
  windowReady,
  type EvaluationWindows,
} from "@/lib/seo/actions/windows";
import { evaluateSplit, splitMetric } from "@/lib/seo/agency/split/evaluate";
import {
  isSplitChangeKind,
  type SplitEvaluation,
} from "@/lib/seo/agency/split/types";
import { priorCurve, type CtrCurve } from "@/lib/seo/ctr-curve";
import { gscSyncAllowedFor } from "@/lib/seo/flags";
import { normalizePageUrl } from "@/lib/seo/normalize";
import { AuditLogRepository } from "@/server/repositories/audit-log.repository";
import { gscMockMode } from "@/server/integrations/search-console/search-analytics";
import { parseSeoCurves } from "@/server/seo/opportunities/state";

import { cmsUntreatedPageIds } from "./cms-items";
import { loadArmSeries } from "./series";

// Bölünmüş test değerlendirici (docs/search-agency.md): EVALUATING testi,
// ölçüm çapasından (GscSplitTest.measureFrom) kurulan PT haftalık
// pencerelerle sonuçlandırır. Google'a gitmez; ambarı ve kendi tablolarımızı
// okur. Sonuç metni şablondur, sayılar yalnız evaluation'da kalır.

const DAY_MS = 86_400_000;
const OTHER_ACTIONS_LIMIT = 500;
const ASSIGNMENT_LIMIT = 10_000;

export type SplitEvaluateResult = "evaluated" | "waiting" | "skipped";

function emptyEvaluation(
  now: Date,
  kind: Parameters<typeof splitMetric>[0],
  windows: EvaluationWindows | null,
  fields: { testPages: number; controlPages: number },
): SplitEvaluation {
  return {
    v: 1,
    method: "DID",
    metric: splitMetric(kind),
    anchorDay: windows?.anchorDay ?? now.toISOString().slice(0, 10),
    preWeeks: windows?.preWeeks ?? [],
    postWeeks: windows?.postWeeks ?? [],
    testPages: fields.testPages,
    controlPages: fields.controlPages,
    usedTest: 0,
    usedControl: 0,
    excluded: 0,
    effect: null,
    low: null,
    high: null,
    placebo: null,
    treated: null,
    control: null,
    updates: [],
    truncated: false,
    reason: "NO_DATA",
    outcome: "INCONCLUSIVE",
    confidence: "DIRECTIONAL",
    evaluatedAt: now.toISOString(),
  };
}

async function readCurve(linkId: string): Promise<CtrCurve> {
  try {
    const state = await prisma.seoEngineState.findUnique({
      where: { linkId },
      select: { curves: true },
    });
    if (state?.curves) return parseSeoCurves(state.curves).nonBrand;
  } catch {
    // Eğri okunamazsa kamuya açık öncül eğri kullanılır.
  }
  return priorCurve("non-brand");
}

async function overlappingUpdates(
  windows: EvaluationWindows,
  now: Date,
): Promise<SplitEvaluation["updates"]> {
  const bounds = queryBounds(windows.overlapFrom, windows.overlapTo);
  const rows = await prisma.searchUpdate.findMany({
    where: {
      startedAt: { lt: bounds.lt },
      OR: [{ endedAt: null }, { endedAt: { gte: bounds.gte } }],
    },
    select: { name: true, kind: true, startedAt: true, endedAt: true },
    orderBy: { startedAt: "asc" },
    take: 50,
  });
  return rankingUpdatesOverlapping(rows, windows, now).map((update) => ({
    name: update.name,
    kind: update.kind,
    startedAt: update.startedAt.toISOString(),
    endedAt: update.endedAt ? update.endedAt.toISOString() : null,
  }));
}

// Pencerede başka (sağlık dışı) SEO eylemine uğrayan sayfalar iki koldan da
// çıkarılır. En iyi çabayladır: okunamazsa kimse dışlanmaz.
async function otherActionPages(input: {
  projectId: string;
  linkId: string;
  isMock: boolean;
  windows: EvaluationWindows;
}): Promise<Set<string>> {
  const out = new Set<string>();
  try {
    const { windows } = input;
    const bounds = queryBounds(windows.overlapFrom, windows.overlapTo);
    const rows = (
      await prisma.seoAction.findMany({
        where: {
          projectId: input.projectId,
          isMock: input.isMock,
          source: { not: "HEALTH_ISSUE" },
          appliedAt: { gte: bounds.gte, lt: bounds.lt },
        },
        select: { pageId: true, targetUrl: true, appliedAt: true },
        take: OTHER_ACTIONS_LIMIT,
      })
    ).filter(
      (row) =>
        row.appliedAt !== null &&
        dayInRange(row.appliedAt, windows.overlapFrom, windows.overlapTo),
    );
    const hashes = new Set<string>();
    for (const row of rows) {
      if (row.pageId) out.add(row.pageId);
      const hash = row.targetUrl ? normalizePageUrl(row.targetUrl)?.hash : null;
      if (hash) hashes.add(hash);
    }
    if (hashes.size > 0) {
      const pages = await prisma.gscPage.findMany({
        where: { linkId: input.linkId, urlHash: { in: [...hashes] } },
        select: { id: true },
      });
      for (const page of pages) out.add(page.id);
    }
  } catch {
    console.warn("[gsc-split] other actions could not be read");
  }
  return out;
}

async function recordEvaluation(
  row: {
    id: string;
    workspaceId: string;
    projectId: string;
    changeKind: string;
  },
  evaluation: SplitEvaluation,
): Promise<void> {
  try {
    await AuditLogRepository.record({
      workspaceId: row.workspaceId,
      projectId: row.projectId,
      actorType: "SYSTEM",
      action: "gsc_split_test.evaluated",
      entityType: "GscSplitTest",
      entityId: row.id,
      metadata: { kind: row.changeKind, outcome: evaluation.outcome },
    });
  } catch {
    console.warn(`[gsc-split] audit failed: ${row.id}`);
  }
}

export async function evaluateSplitTest(
  testId: string,
  now: Date,
): Promise<SplitEvaluateResult> {
  const row = await prisma.gscSplitTest.findUnique({ where: { id: testId } });
  if (
    !row ||
    row.status !== "EVALUATING" ||
    row.isMock !== gscMockMode() ||
    !gscSyncAllowedFor(row.projectId) ||
    !isSplitChangeKind(row.changeKind)
  ) {
    return "skipped";
  }
  if (row.evaluateAfter && now.getTime() < row.evaluateAfter.getTime()) {
    return "waiting";
  }
  const kind = row.changeKind;
  const counts = { testPages: row.testPages, controlPages: row.controlPages };

  const finish = async (
    evaluation: SplitEvaluation,
  ): Promise<SplitEvaluateResult> => {
    const written = await prisma.gscSplitTest.updateMany({
      where: { id: row.id, status: "EVALUATING" },
      data: {
        status: evaluation.outcome,
        outcome: evaluation.outcome,
        confidence: evaluation.confidence,
        evaluation: evaluation as unknown as Prisma.InputJsonValue,
        evaluatedAt: now,
        nextCheckAt: null,
      },
    });
    if (written.count !== 1) return "skipped";
    await recordEvaluation(row, evaluation);
    return "evaluated";
  };
  const retryLater = async (): Promise<SplitEvaluateResult> => {
    await prisma.gscSplitTest.updateMany({
      where: { id: row.id, status: "EVALUATING" },
      data: { nextCheckAt: new Date(now.getTime() + EVAL_RETRY_MS) },
    });
    return "waiting";
  };

  const anchor = row.measureFrom ?? row.appliedAt;
  if (!anchor) return finish(emptyEvaluation(now, kind, null, counts));
  const windows = evaluationWindows({
    measureFrom: anchor,
    windowDays: row.windowDays,
  });

  const link = await prisma.gscSiteLink.findUnique({
    where: { id: row.linkId },
    select: { lastWeeklyWeek: true },
  });
  if (!link) return finish(emptyEvaluation(now, kind, windows, counts));
  if (!windowReady(windows, link.lastWeeklyWeek)) {
    const base = row.evaluateAfter ?? now;
    const giveUpAt = base.getTime() + EVAL_GIVE_UP_DAYS * DAY_MS;
    if (now.getTime() < giveUpAt) return retryLater();
    return finish(emptyEvaluation(now, kind, windows, counts));
  }

  const assignments = await prisma.gscSplitTestPage.findMany({
    where: { testId: row.id },
    select: { pageId: true, arm: true },
    take: ASSIGNMENT_LIMIT,
  });
  const excludedIds = await otherActionPages({
    projectId: row.projectId,
    linkId: row.linkId,
    isMock: row.isMock,
    windows,
  });
  // CMS yolunda değişikliği hiç yapılmamış sayfalar da kolun dışında kalır.
  if (row.appliedVia === "CMS") {
    for (const pageId of cmsUntreatedPageIds(row.cmsChanges)) {
      excludedIds.add(pageId);
    }
  }
  let excluded = 0;
  const testIds: string[] = [];
  const controlIds: string[] = [];
  for (const { pageId, arm } of assignments) {
    if (excludedIds.has(pageId)) {
      excluded += 1;
      continue;
    }
    (arm === "TEST" ? testIds : controlIds).push(pageId);
  }

  const loaded = await loadArmSeries({
    linkId: row.linkId,
    testIds,
    controlIds,
    weeks: [...windows.preWeeks, ...windows.postWeeks],
  });
  const pre = windows.preWeeks.filter((week) => loaded.coveredWeeks.has(week));
  const post = windows.postWeeks.filter((week) =>
    loaded.coveredWeeks.has(week),
  );
  if (pre.length < MIN_PRE_WEEKS || post.length < MIN_POST_WEEKS) {
    return finish({
      ...emptyEvaluation(
        now,
        kind,
        { ...windows, preWeeks: pre, postWeeks: post },
        counts,
      ),
      excluded,
      truncated: loaded.truncated,
    });
  }

  const usable: EvaluationWindows = {
    ...windows,
    preWeeks: pre,
    postWeeks: post,
  };
  const updates = await overlappingUpdates(windows, now);
  const evaluation = evaluateSplit({
    kind,
    test: loaded.test,
    control: loaded.control,
    windows: usable,
    curve: await readCurve(row.linkId),
    seed: row.seed,
    overlap: updates.length > 0,
    truncated: loaded.truncated,
    assigned: { test: row.testPages, control: row.controlPages },
    excluded,
    updates,
    now,
  });
  return finish(evaluation);
}
