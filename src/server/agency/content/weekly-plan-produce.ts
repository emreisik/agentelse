import "server-only";

import { prisma } from "@/lib/prisma";
import {
  AUTO_PRODUCE_UNTOUCHED_MS,
  WEEKLY_AUTO_PRODUCE_COPY,
  WEEKLY_WORK_PREFIX,
  weekOfWeeklyWork,
  weeklyDraftOn,
} from "@/lib/weekly-draft";
import { isIdeaEventCardData } from "@/types/idea-event-card";
import { markIdeasPlanned } from "@/server/chat/idea-pool";
import { savePlanSlotsInTx } from "@/server/chat/save-plan-core";
import { runContentPlan } from "@/server/chat/plan-run";
import { AuditLogRepository } from "@/server/repositories/audit-log.repository";
import { isProjectAgencyActive } from "@/server/repositories/agency-loop-state.repository";
import { assertPlanSaveable } from "@/server/works/plan-save-guards";
import { isWorksEnabled } from "@/server/works/flag";

// Faz 5 (docs/brand-brain-loop.md): the owner's one chosen escalation past the
// Sunday weekly draft (weekly-plan-draft.ts) — "prepare it automatically, I
// still approve the publish". A weekly draft nobody has touched for
// AUTO_PRODUCE_UNTOUCHED_MS is saved and sent into production on its own, so
// the owner opens the chat to pieces waiting for a decision instead of an
// empty draft. Gated per project by AutonomyPolicy.weeklyAutoProduce
// (Settings -> Autonomy, default OFF) — separate from autopilotMode, see the
// schema comment. Approval, scheduling and publishing are untouched: every
// produced piece still waits for the owner's own tap, exactly like a plan the
// owner produced by hand.

// What this process already decided for a Work, and until when the next tick
// can skip it without a query — the same shape as weekly-plan-draft.ts's
// `decided` map, keyed by Work id instead of project id (a project can only
// ever have one weekly draft open at a time, but keying by Work makes that an
// observation, not an assumption this file depends on).
const decided = new Map<string, number>();
const SETTLED_MS = 12 * 60 * 60_000;
const NOT_YET_MS = 15 * 60_000;
const FAILED_MS = 10 * 60_000;

export function clearWeeklyAutoProduceMemo() {
  decided.clear();
}

type DraftCard = {
  state?: unknown;
  timezone: string;
  items: readonly { date: string; topic?: string; captionIdea?: string }[];
};

function draftCardOf(parsedIntent: unknown): DraftCard | null {
  const card = (parsedIntent as { card?: unknown } | null)?.card;
  if (!isIdeaEventCardData(card) || card.kind !== "content-plan-draft") {
    return null;
  }
  if (card.state !== "draft") return null;
  return { timezone: card.timezone, items: card.items };
}

type Candidate = {
  workId: string;
  commandId: string;
  projectId: string;
  workspaceId: string;
  brandId: string;
  card: DraftCard;
};

// The owner has not touched this Work: no WEB message in it (same check as
// archiveUntouchedOlderDrafts in weekly-plan-draft.ts). A pane edit or a swap
// (plan-alternatives.ts) updates the SAME SYSTEM row in place — Command has
// no `updatedAt` to see that by, but it needs none: the auto-save below
// reads the card fresh right before it writes, so it saves exactly what such
// an edit left behind, same as if the owner had pressed Save themselves. The
// 2-hour wait this file adds is against the draft's `createdAt`, not against
// an edit's time — a plan the owner was still actively shaping when the
// window closes is the one edge this does not cover.
function untouched(commands: readonly { source: string }[]): boolean {
  return commands.every((c) => c.source === "SYSTEM");
}

async function findDue(now: Date): Promise<Candidate[]> {
  const works = await prisma.work.findMany({
    where: { id: { startsWith: WEEKLY_WORK_PREFIX }, status: "ACTIVE" },
    select: {
      id: true,
      projectId: true,
      workspaceId: true,
      commands: {
        select: {
          id: true,
          brandId: true,
          source: true,
          createdAt: true,
          parsedIntent: true,
        },
      },
    },
  });
  if (works.length === 0) return [];

  const projectIds = [...new Set(works.map((w) => w.projectId))];
  const policies = await prisma.autonomyPolicy.findMany({
    where: { projectId: { in: projectIds } },
    select: { projectId: true, weeklyAutoProduce: true, autopilotMode: true },
  });
  // Both switches, not just this one: the owner may have turned the weekly
  // draft itself off after this one was left on, and a stale undrafted Work
  // from before that should wait for the owner too, same as a brand new one.
  const onFor = new Set(
    policies
      .filter((p) => p.weeklyAutoProduce && weeklyDraftOn(p.autopilotMode))
      .map((p) => p.projectId),
  );

  const due: Candidate[] = [];
  for (const work of works) {
    if (!onFor.has(work.projectId)) continue;
    const memoUntil = decided.get(work.id);
    if (memoUntil && now.getTime() < memoUntil) continue;
    // One draft row, written by weekly-plan-draft.ts; anything else in the
    // Work means the owner has been here.
    const draftRow = work.commands.find(
      (c) => draftCardOf(c.parsedIntent) !== null,
    );
    if (!draftRow || !draftRow.brandId || !untouched(work.commands)) continue;
    if (
      now.getTime() - draftRow.createdAt.getTime() <
      AUTO_PRODUCE_UNTOUCHED_MS
    ) {
      continue;
    }
    const card = draftCardOf(draftRow.parsedIntent);
    if (!card) continue;
    due.push({
      workId: work.id,
      commandId: draftRow.id,
      projectId: work.projectId,
      workspaceId: work.workspaceId,
      brandId: draftRow.brandId,
      card,
    });
  }
  return due;
}

type SaveOutcome =
  | { ok: true; count: number; ideaIds: string[] }
  | { ok: false; reason: string };

async function autoSaveWeeklyPlan(candidate: Candidate): Promise<SaveOutcome> {
  const guard = await assertPlanSaveable({
    projectId: candidate.projectId,
    brandId: candidate.brandId,
    workId: candidate.workId,
    card: candidate.card,
    failClosedOnRulesUnavailable: true,
  });
  if (!guard.ok) return { ok: false, reason: guard.code };

  const saved = await prisma.$transaction(
    (tx) =>
      savePlanSlotsInTx(
        tx,
        {
          workspaceId: candidate.workspaceId,
          projectId: candidate.projectId,
          brandId: candidate.brandId,
        },
        candidate.commandId,
      ),
    { isolationLevel: "Serializable" },
  );
  if (!saved.ok) return { ok: false, reason: saved.error };

  await markIdeasPlanned(candidate.projectId, saved.ideaIds);
  return { ok: true, count: saved.count, ideaIds: saved.ideaIds };
}

// Drains the exact same generator a "Prepare content" click runs
// (plan-run.ts), as a SYSTEM actor (userId: null) — one claim, the plan's
// producible slots (at most MAX_PRODUCTION_BATCH, capped again by the
// project's own daily budget inside runPlan), driven inline exactly like the
// owner's own click, never through a second code path. Fire-and-forget: the
// caller does not await this, so a multi-minute render never holds up the
// agency tick (see the module comment on why that is safe here).
async function runWeeklyProduction(candidate: Candidate): Promise<void> {
  try {
    // eslint-disable-next-line @typescript-eslint/no-unused-vars -- draining only
    for await (const _event of runContentPlan({
      workspaceId: candidate.workspaceId,
      projectId: candidate.projectId,
      brandId: candidate.brandId,
      userId: null,
      commandId: candidate.commandId,
    })) {
      // Nothing to do with the events themselves: runContentPlan already
      // writes the card, the chat rows and the audit trail as it goes.
    }
  } catch (error) {
    console.error(
      `[weekly-plan-produce] production failed for plan ${candidate.commandId}:`,
      error instanceof Error ? error.message : error,
    );
  }
}

export const WeeklyPlanProduce = {
  // At most `limit` plans auto-saved per tick (production for each then runs
  // in the background). Returns how many were saved.
  // The legacy-loop gate (Council/Director must not also be turning the same
  // pool ideas into their own creatives) lives in the caller, same convention
  // as idea-generation (agency-wiring.ts).
  async runDue(limit = 2, now: Date = new Date()): Promise<number> {
    if (!isWorksEnabled()) return 0;
    const due = await findDue(now);
    if (due.length === 0) return 0;

    let saved = 0;
    for (const candidate of due) {
      if (saved >= limit) break;
      const remember = (ms: number) =>
        decided.set(candidate.workId, now.getTime() + ms);
      if (!(await isProjectAgencyActive(candidate.projectId))) {
        remember(FAILED_MS);
        continue;
      }
      try {
        const outcome = await autoSaveWeeklyPlan(candidate);
        if (!outcome.ok) {
          // A brand block, a stale date or a can't-check rule set: leave it
          // exactly as the owner left it — the manual Save path still shows
          // them the reason and the "Save anyway" option.
          remember(
            outcome.reason === "WORK_INACTIVE" ? SETTLED_MS : NOT_YET_MS,
          );
          continue;
        }
        remember(SETTLED_MS);
        saved += 1;

        await AuditLogRepository.record({
          workspaceId: candidate.workspaceId,
          projectId: candidate.projectId,
          brandId: candidate.brandId,
          actorType: "SYSTEM",
          action: "weekly_plan.auto_saved",
          entityType: "Command",
          entityId: candidate.commandId,
          metadata: { items: outcome.count },
        }).catch(() => undefined);

        const monday =
          weekOfWeeklyWork(candidate.projectId, candidate.workId) ??
          candidate.card.items[0]?.date ??
          "";
        await prisma.command
          .update({
            where: { id: candidate.commandId },
            data: {
              replyText: WEEKLY_AUTO_PRODUCE_COPY.autoSavedReply(
                outcome.count,
                monday,
              ),
            },
          })
          .catch((error) => {
            console.error(
              "[weekly-plan-produce] reply update failed:",
              error instanceof Error ? error.message : error,
            );
          });

        void runWeeklyProduction(candidate);
      } catch (error) {
        remember(FAILED_MS);
        console.error(
          `[weekly-plan-produce] auto-save failed for work ${candidate.workId}:`,
          error instanceof Error ? error.message : error,
        );
      }
    }
    return saved;
  },
};
