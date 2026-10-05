"use server";

import { randomUUID } from "node:crypto";

import { revalidatePath } from "next/cache";
import { z } from "zod";

import { prisma } from "@/lib/prisma";
import {
  ANALYTICS_SOURCES,
  SOURCE_LABEL,
  isAnalyticsPeriod,
  orderedSources,
  type AnalyticsPeriod,
  type AnalyticsSource,
  type AnalyticsSourceStates,
} from "@/lib/module-flows/analytics/catalog";
import { ANALYTICS_COPY as COPY } from "@/lib/module-flows/analytics/copy";
import {
  periodText,
  type ReportData,
} from "@/lib/module-flows/analytics/report";
import {
  analyticsCardData,
  canBuild,
  isBuildRunning,
  openableSteps,
  readAnalyticsState,
  type AnalyticsFlowState,
  type BuildFrom,
} from "@/lib/module-flows/analytics/state";
import type {
  ModuleFlowCardData,
  ModuleFlowStep,
} from "@/lib/module-flows/card";
import { collectReport } from "@/server/modules/analytics/collect";
import { loadAnalyticsSources } from "@/server/modules/analytics/sources";
import { summarizeReport } from "@/server/modules/analytics/summary";
import { updateModuleFlowCard } from "@/server/modules/flow-card";
import { WorkRepository } from "@/server/repositories/work.repository";
import {
  GUARD_MESSAGE,
  authorizeWorks,
  guardedAction,
  idSchema,
  type GuardFail,
} from "@/server/works/guard";

// The Analytics card's actions (docs/modules.md "Analytics"): read the live
// sources, save the brief, open a step, build the report from real data (plus
// its honest AI summary) and remember that it was shared. Every card write goes
// through updateModuleFlowCard (atomic, refuses a completed Work); the card's
// stored data is read back through readAnalyticsState, never trusted.
// 'use server': only async exports.

export type AnalyticsSourcesResult =
  { ok: true; sources: AnalyticsSourceStates } | { ok: false; message: string };

export type AnalyticsFlowResult =
  | { ok: true; changed: boolean; message?: string }
  | {
      ok: false;
      // STALE: the card moved on elsewhere (refresh). SOURCES: a source of the
      // brief can't be read anymore (check the connections again).
      code: "STALE" | "SOURCES" | "FAILED";
      message: string;
    };

const SOURCES_BUCKET = { bucket: "analytics-sources", limit: 120 } as const;
const FLOW_BUCKET = { bucket: "analytics-flow", limit: 60 } as const;
// Each build reads up to four platforms and makes one AI call.
const BUILD_BUCKET = { bucket: "analytics-build", limit: 12 } as const;

const sourcesSchema = z
  .array(z.enum(ANALYTICS_SOURCES))
  .min(1)
  .max(ANALYTICS_SOURCES.length);
const briefSchema = z.object({
  period: z.number().refine(isAnalyticsPeriod),
  sources: sourcesSchema,
});
const openStepSchema = z.enum(["brief", "plan", "review", "deliver"]);

type Move =
  { step: ModuleFlowStep; state: AnalyticsFlowState } | { reject: string };

type ClaimedBuild = {
  period: AnalyticsPeriod;
  sections: AnalyticsSource[];
  from: BuildFrom;
};

function failed(message: string = GUARD_MESSAGE.failed): AnalyticsFlowResult {
  return { ok: false, code: "FAILED", message };
}

// The action's own answer as is; the guard's (a thrown error) as a failure.
function settle(result: AnalyticsFlowResult | GuardFail): AnalyticsFlowResult {
  if (result.ok) return result;
  return result.code === "STALE" || result.code === "SOURCES"
    ? { ok: false, code: result.code, message: result.message }
    : failed(result.message);
}

// One card write: decide the move from the stored card, write it, and turn a
// refusal into what the card shows (STALE refreshes it).
async function moveCard(
  projectId: string,
  commandId: string,
  decide: (card: ModuleFlowCardData, state: AnalyticsFlowState) => Move,
): Promise<{ ok: true } | Extract<AnalyticsFlowResult, { ok: false }>> {
  const result = await updateModuleFlowCard({
    commandId,
    projectId,
    module: "analytics",
    update: (card) => {
      const move = decide(card, readAnalyticsState(card.data));
      if ("reject" in move) return move;
      return { ...card, step: move.step, data: analyticsCardData(move.state) };
    },
  });
  if (result.ok) return { ok: true };
  return {
    ok: false,
    code: result.message === COPY.stale ? "STALE" : "FAILED",
    message: result.message,
  };
}

function revalidate(projectId: string): void {
  try {
    revalidatePath(`/projects/${projectId}`);
  } catch (error) {
    console.error(
      "[analytics] revalidate failed:",
      error instanceof Error ? error.message : error,
    );
  }
}

// The Work moves up in Recents and says what it holds. Best effort.
async function touchWork(
  projectId: string,
  commandId: string,
  summary: string,
): Promise<void> {
  try {
    const row = await prisma.command.findUnique({
      where: { id: commandId },
      select: { projectId: true, workId: true },
    });
    if (row?.projectId === projectId && row.workId) {
      await WorkRepository.touch(projectId, row.workId, { summary });
    }
  } catch (error) {
    console.error(
      "[analytics] work touch failed:",
      error instanceof Error ? error.message : error,
    );
  }
}

export async function analyticsSourcesAction(
  projectId: string,
): Promise<AnalyticsSourcesResult> {
  const result = await guardedAction(
    "analytics-sources",
    async (): Promise<AnalyticsSourcesResult> => {
      const gate = await authorizeWorks(projectId, SOURCES_BUCKET);
      if (!gate.ok) return { ok: false, message: gate.message };
      return { ok: true, sources: await loadAnalyticsSources(projectId) };
    },
  );
  return result.ok ? result : { ok: false, message: result.message };
}

// Brief -> Plan. The sources are checked live again: the brief only keeps what
// the report can read right now. Every section of the plan starts on.
export async function saveAnalyticsBriefAction(
  projectId: string,
  commandId: string,
  input: { period: number; sources: string[] },
): Promise<AnalyticsFlowResult> {
  const result = await guardedAction(
    "analytics-brief",
    async (): Promise<AnalyticsFlowResult> => {
      const gate = await authorizeWorks(projectId, FLOW_BUCKET);
      if (!gate.ok) return failed(gate.message);
      const id = idSchema.safeParse(commandId);
      const brief = briefSchema.safeParse(input);
      if (!id.success || !brief.success) return failed();
      const period = brief.data.period as AnalyticsPeriod;
      const sources = orderedSources(brief.data.sources);

      const live = await loadAnalyticsSources(projectId);
      const lost = sources.filter(
        (source) => live[source].status !== "connected",
      );
      if (lost.length > 0) {
        return {
          ok: false,
          code: "SOURCES",
          message: COPY.noLongerConnected(
            lost.map((source) => SOURCE_LABEL[source]).join(", "),
          ),
        };
      }

      const written = await moveCard(projectId, id.data, (card, state) =>
        card.step !== "brief"
          ? { reject: COPY.stale }
          : {
              step: "plan",
              state: {
                ...state,
                period,
                sources,
                sections: sources,
                error: null,
              },
            },
      );
      if (!written.ok) return written;
      revalidate(projectId);
      return { ok: true, changed: true, message: COPY.briefSaved };
    },
  );
  return settle(result);
}

// Back to the brief or the plan, forward to a report that exists ("Share"
// opens the deliver step). Never while a build runs.
export async function openAnalyticsStepAction(
  projectId: string,
  commandId: string,
  step: string,
): Promise<AnalyticsFlowResult> {
  const result = await guardedAction(
    "analytics-step",
    async (): Promise<AnalyticsFlowResult> => {
      const gate = await authorizeWorks(projectId, FLOW_BUCKET);
      if (!gate.ok) return failed(gate.message);
      const id = idSchema.safeParse(commandId);
      const target = openStepSchema.safeParse(step);
      if (!id.success || !target.success) return failed();
      const now = Date.now();

      const written = await moveCard(projectId, id.data, (card, state) =>
        openableSteps(card.step, state, now)[target.data]
          ? {
              step: target.data,
              // A build that stopped is let go of once the card moves on.
              state: { ...state, build: null, error: null },
            }
          : { reject: COPY.stale },
      );
      if (!written.ok) return written;
      revalidate(projectId);
      return { ok: true, changed: true };
    },
  );
  return settle(result);
}

// Plan -> Create -> Review, run inline: the card is claimed (step "create" with
// a build id, so a second tap or tab is refused), every source is read on its
// own, the summary is written from the numbers alone, and the report lands in
// the card. A build that fails puts the card back where it came from.
export async function buildAnalyticsReportAction(
  projectId: string,
  commandId: string,
  sections: string[],
): Promise<AnalyticsFlowResult> {
  const result = await guardedAction(
    "analytics-build",
    async (): Promise<AnalyticsFlowResult> => {
      const gate = await authorizeWorks(projectId, BUILD_BUCKET);
      if (!gate.ok) return failed(gate.message);
      const id = idSchema.safeParse(commandId);
      const asked = sourcesSchema.safeParse(sections);
      if (!id.success || !asked.success) return failed();

      const buildId = randomUUID();
      const startedAt = new Date();
      // Filled by the claim below: what this build reads.
      const claimed: { value: ClaimedBuild | null } = { value: null };

      const claim = await moveCard(projectId, id.data, (card, state) => {
        if (!canBuild(card.step, state, startedAt.getTime())) {
          return {
            reject:
              card.step === "create" &&
              isBuildRunning(state.build, startedAt.getTime())
                ? COPY.alreadyBuilding
                : COPY.stale,
          };
        }
        const wanted = orderedSources(asked.data).filter((source) =>
          state.sources.includes(source),
        );
        if (wanted.length === 0) return { reject: COPY.stale };
        const from: BuildFrom =
          card.step === "create"
            ? (state.build?.from ?? "plan")
            : card.step === "review" || card.step === "deliver"
              ? card.step
              : "plan";
        claimed.value = { period: state.period, sections: wanted, from };
        return {
          step: "create",
          state: {
            ...state,
            sections: wanted,
            build: { id: buildId, startedAt: startedAt.toISOString(), from },
            error: null,
          },
        };
      });
      if (!claim.ok) return claim;
      const build = claimed.value;
      if (!build) return failed();

      let report: ReportData | null = null;
      try {
        const collected = await collectReport(
          projectId,
          build.period,
          build.sections,
          startedAt.getTime(),
        );
        const outcome = await summarizeReport(
          {
            workspaceId: gate.auth.workspaceId,
            projectId,
            brandId: gate.auth.defaultBrandId,
          },
          collected,
        );
        report = {
          ...collected,
          summary: outcome.summary,
          summaryNote: outcome.note,
        };
      } catch (error) {
        console.error(
          "[analytics] report build failed:",
          error instanceof Error ? error.message : error,
        );
      }

      const finished = await moveCard(projectId, id.data, (card, state) => {
        // Another build took over (this one went stale) or the card moved.
        if (card.step !== "create" || state.build?.id !== buildId) {
          return { reject: COPY.stale };
        }
        return report
          ? {
              step: "review",
              state: {
                ...state,
                build: null,
                report,
                error: null,
                sharedAt: null,
              },
            }
          : {
              step: build.from,
              state: { ...state, build: null, error: COPY.buildFailed },
            };
      });
      if (!finished.ok) return finished;
      if (report) {
        // Before the revalidation, so the same render shows it in Recents.
        await touchWork(
          projectId,
          id.data,
          COPY.workSummary(periodText(build.period)),
        );
      }
      revalidate(projectId);
      if (!report) return failed(COPY.buildFailed);
      return { ok: true, changed: true, message: COPY.reportReady };
    },
  );
  return settle(result);
}

// The first Copy, Download or Print marks the flow delivered. Idempotent.
export async function markAnalyticsSharedAction(
  projectId: string,
  commandId: string,
): Promise<AnalyticsFlowResult> {
  const result = await guardedAction(
    "analytics-shared",
    async (): Promise<AnalyticsFlowResult> => {
      const gate = await authorizeWorks(projectId, FLOW_BUCKET);
      if (!gate.ok) return failed(gate.message);
      const id = idSchema.safeParse(commandId);
      if (!id.success) return failed();
      const sharedAt = new Date().toISOString();

      const written = await moveCard(projectId, id.data, (card, state) =>
        card.step === "deliver" && state.report && !state.sharedAt
          ? { step: "deliver", state: { ...state, sharedAt } }
          : { reject: COPY.stale },
      );
      // Nothing to mark (already shared, or the card moved on): not an error.
      if (!written.ok) {
        return written.code === "STALE"
          ? { ok: true, changed: false }
          : written;
      }
      revalidate(projectId);
      return { ok: true, changed: true };
    },
  );
  return settle(result);
}
