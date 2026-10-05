"use server";

import { randomUUID } from "node:crypto";
import { revalidatePath } from "next/cache";

import { prisma } from "@/lib/prisma";
import { isModuleFlowStep, type ModuleFlowStep } from "@/lib/module-flows/card";
import { cleanLine, validateSeoBrief } from "@/lib/module-flows/seo/brief";
import { formatWhen, isWallClock } from "@/lib/module-flows/seo/deliver";
import { applyPlanEdits } from "@/lib/module-flows/seo/plan";
import {
  SEO_LIMITS,
  canGoToSeoStep,
  seoRunActive,
  withoutRun,
  type SeoBrief,
  type SeoDelivery,
  type SeoRunKind,
  type SeoState,
} from "@/lib/module-flows/seo/state";
import { utcToZonedDateTimeLocal, zonedDateTimeToUtc } from "@/lib/timezone";
import { workSummaryFrom } from "@/lib/works/work";
import { markCreativePublishedAction } from "@/server/actions/plan-progress-actions";
import { getProjectTimezone } from "@/server/chat/content-plan";
import { placeSeoArticle, seoPieceStatus } from "@/server/modules/seo/calendar";
import {
  readSeoCard,
  releaseSeoRun,
  writeSeoCard,
  type SeoCardNext,
  type SeoCardRead,
} from "@/server/modules/seo/card";
import type { SeoScope } from "@/server/modules/seo/context";
import { loadSeoDefaults } from "@/server/modules/seo/defaults";
import { runSeoResearch } from "@/server/modules/seo/research";
import { runSeoWrite, type SeoDraft } from "@/server/modules/seo/write";
import { ReasoningService } from "@/server/reasoning/reasoning-service";
import { AuditLogRepository } from "@/server/repositories/audit-log.repository";
import { WorkRepository } from "@/server/repositories/work.repository";
import {
  GUARD_MESSAGE,
  assertWorkActive,
  authorizeWorks,
  guardedAction,
  idSchema,
  type WorksAuth,
} from "@/server/works/guard";

// The SEO Manager's card actions (docs/modules.md "SEO Manager"): Brief ->
// Plan (keyword research with web search + Search Console quick wins) ->
// Create (the article) -> Review (on-page checks, Rewrite) -> Publish (by
// hand: the Content Calendar and "Mark as published"). Every write goes
// through the module flow card's one writer; a model call first CLAIMS the
// card (two tabs, one paid call), runs, then writes its answer only if its
// claim still holds. The client refreshes after every write.

const AI_BUCKET = { bucket: "seo-flow-ai", limit: 20 } as const;
const WRITE_BUCKET = { bucket: "seo-flow", limit: 60 } as const;
const READ_BUCKET = { bucket: "seo-flow-read", limit: 120 } as const;

// A time a minute or two behind is the clock, not the past.
const PAST_GRACE_MS = 2 * 60_000;

const COPY = {
  mock: "Researching and writing need the live AI model, which is switched off here.",
  busy: "Already working on this card. It updates when it's done.",
  stale: "This card changed. Refreshing.",
  noBrief: "Fill in the brief first.",
  noPlan: "Research the topic first.",
  noArticle: "Write the article first.",
  rewriteLimit: `This article was rewritten ${SEO_LIMITS.rewrites} times. Edit it on your site instead.`,
  when: "Pick a day and a time.",
  past: "Pick a time that's still ahead.",
  calendarFailed: "Couldn't add it to the calendar. Try again.",
  gone: "This article is no longer on your calendar. Add it again.",
  researched: "Keywords and outline are ready.",
  written: "Your article is ready to review.",
  rewritten: "The article is rewritten.",
  published: "Marked as published.",
} as const;

export type SeoFlowResult =
  | { ok: true; message?: string }
  | { ok: false; message: string; code?: "STALE" };

export type SeoDefaultsResult =
  | { ok: true; siteUrl: string; language: string }
  | { ok: false; message: string };

function failed(message: string): SeoFlowResult {
  return message === COPY.stale
    ? { ok: false, message, code: "STALE" }
    : { ok: false, message };
}

function refresh(projectId: string, calendar = false): void {
  revalidatePath(`/projects/${projectId}`);
  if (calendar) revalidatePath(`/projects/${projectId}/takvim`);
}

function scopeOf(auth: WorksAuth, projectId: string): SeoScope {
  return {
    workspaceId: auth.workspaceId,
    projectId,
    brandId: auth.defaultBrandId,
  };
}

async function touchWork(
  projectId: string,
  workId: string | null,
  summary: string,
): Promise<void> {
  if (!workId) return;
  await WorkRepository.touch(projectId, workId, {
    summary: workSummaryFrom(summary),
  }).catch(() => undefined);
}

type ActionContext = {
  auth: WorksAuth;
  commandId: string;
  current: SeoCardRead;
};

// Auth, rate limit, a bounded id and the card itself, then the step.
async function seoAction(
  label: string,
  projectId: string,
  commandId: unknown,
  bucket: { bucket: string; limit: number },
  run: (context: ActionContext) => Promise<SeoFlowResult>,
): Promise<SeoFlowResult> {
  const result = await guardedAction(
    label,
    async (): Promise<SeoFlowResult> => {
      const gate = await authorizeWorks(projectId, bucket);
      if (!gate.ok) return { ok: false, message: gate.message };
      const id = idSchema.safeParse(commandId);
      if (!id.success) return { ok: false, message: GUARD_MESSAGE.failed };
      const current = await readSeoCard(projectId, id.data);
      if (!current) return { ok: false, message: GUARD_MESSAGE.failed };
      return run({ auth: gate.auth, commandId: id.data, current });
    },
  );
  if (result.ok) return result;
  return result.code === "STALE"
    ? { ok: false, message: result.message, code: "STALE" }
    : { ok: false, message: result.message };
}

type Current = { step: ModuleFlowStep; state: SeoState };

// One model call on the card: claim (the card shows it working, a second tap
// or tab is refused), call, then write the answer only while the claim is
// still this run's. A failed call gives the claim back and returns the card to
// `fallbackStep`, everything else kept.
async function runClaimed<T>(input: {
  projectId: string;
  commandId: string;
  kind: SeoRunKind;
  fallbackStep: ModuleFlowStep;
  claim: (current: Current) => SeoCardNext;
  call: (
    claimed: Current,
  ) => Promise<{ ok: true; value: T } | { ok: false; message: string }>;
  finish: (current: Current, value: T) => Current;
  message: string;
}): Promise<SeoFlowResult> {
  const { projectId, commandId } = input;
  const runId = randomUUID();
  const startedAt = new Date();

  const claimed = await writeSeoCard({
    projectId,
    commandId,
    update: (current) => {
      if (seoRunActive(current.state.run, startedAt.getTime())) {
        return { reject: COPY.busy };
      }
      const next = input.claim(current);
      if ("reject" in next) return next;
      return {
        step: next.step,
        state: {
          ...next.state,
          run: {
            id: runId,
            kind: input.kind,
            startedAt: startedAt.toISOString(),
          },
        },
      };
    },
  });
  if (!claimed.ok) return failed(claimed.message);

  let outcome: { ok: true; value: T } | { ok: false; message: string };
  try {
    outcome = await input.call(claimed);
  } catch (error) {
    console.error(
      `[works] seo ${input.kind} failed:`,
      error instanceof Error ? error.message : error,
    );
    outcome = { ok: false, message: GUARD_MESSAGE.failed };
  }
  if (!outcome.ok) {
    await releaseSeoRun({
      projectId,
      commandId,
      runId,
      step: input.fallbackStep,
    });
    refresh(projectId);
    return { ok: false, message: outcome.message };
  }

  const value = outcome.value;
  const done = await writeSeoCard({
    projectId,
    commandId,
    update: (current) =>
      current.state.run?.id === runId
        ? input.finish(
            { step: current.step, state: withoutRun(current.state) },
            value,
          )
        : { reject: COPY.stale },
  });
  refresh(projectId);
  return done.ok ? { ok: true, message: input.message } : failed(done.message);
}

// ---- Brief ----------------------------------------------------------------------

export async function seoBriefDefaultsAction(
  projectId: string,
): Promise<SeoDefaultsResult> {
  const result = await guardedAction(
    "seo-defaults",
    async (): Promise<SeoDefaultsResult> => {
      const gate = await authorizeWorks(projectId, READ_BUCKET);
      if (!gate.ok) return { ok: false, message: gate.message };
      return { ok: true, ...(await loadSeoDefaults(projectId)) };
    },
  );
  return result.ok ? result : { ok: false, message: result.message };
}

// ---- Plan -----------------------------------------------------------------------

// Brief -> Plan. `brief` is the form; without it the stored brief is
// researched again (a research that stopped before it answered).
export async function researchSeoAction(
  projectId: string,
  commandId: string,
  brief?: unknown,
): Promise<SeoFlowResult> {
  return seoAction(
    "seo-research",
    projectId,
    commandId,
    AI_BUCKET,
    async ({ auth, commandId: id, current }) => {
      let input: SeoBrief | undefined = current.state.brief;
      if (brief !== undefined && brief !== null) {
        const checked = validateSeoBrief(brief);
        if (!checked.ok) return { ok: false, message: checked.message };
        input = checked.brief;
      }
      if (!input) return { ok: false, message: COPY.noBrief };
      // A mock answer must never be written into a real card.
      if (ReasoningService.isMockMode()) {
        return { ok: false, message: COPY.mock };
      }
      const researched: SeoBrief = input;
      const scope = scopeOf(auth, projectId);

      const result = await runClaimed({
        projectId,
        commandId: id,
        kind: "research",
        fallbackStep: "brief",
        claim: ({ step, state }) =>
          step === "brief" || (step === "plan" && !state.plan)
            ? { step: "plan", state: { ...state, brief: researched } }
            : { reject: COPY.stale },
        call: async () => {
          const answer = await runSeoResearch({ scope, brief: researched });
          return answer.ok
            ? { ok: true, value: answer.plan }
            : { ok: false, message: answer.message };
        },
        // A new plan; an article written earlier stays until it is rewritten.
        finish: ({ state }, plan) => ({
          step: "plan",
          state: { ...state, plan },
        }),
        message: COPY.researched,
      });
      if (result.ok)
        await touchWork(projectId, current.workId, researched.topic);
      return result;
    },
  );
}

// ---- Create -------------------------------------------------------------------

// Plan -> Create -> Review. `edits` are the plan as the person left it (title,
// meta description, keywords, outline); without them the stored plan is
// written (a writing that stopped before it answered).
export async function writeSeoArticleAction(
  projectId: string,
  commandId: string,
  edits?: unknown,
): Promise<SeoFlowResult> {
  return seoAction(
    "seo-write",
    projectId,
    commandId,
    AI_BUCKET,
    async ({ auth, commandId: id, current }) => {
      const { plan, brief } = current.state;
      if (!plan || !brief) return { ok: false, message: COPY.noPlan };
      const hasEdits = edits !== undefined && edits !== null;
      if (hasEdits) {
        const checked = applyPlanEdits(plan, edits);
        if (!checked.ok) return { ok: false, message: checked.message };
      }
      if (ReasoningService.isMockMode()) {
        return { ok: false, message: COPY.mock };
      }
      const scope = scopeOf(auth, projectId);
      const writtenAt = () => new Date().toISOString();

      let title = "";
      const result = await runClaimed<SeoDraft>({
        projectId,
        commandId: id,
        kind: "write",
        fallbackStep: "plan",
        claim: ({ step, state }) => {
          if (!state.plan || !state.brief) return { reject: COPY.stale };
          if (step !== "plan" && step !== "create")
            return { reject: COPY.stale };
          if (!hasEdits) return { step: "create", state };
          const edited = applyPlanEdits(state.plan, edits);
          return edited.ok
            ? { step: "create", state: { ...state, plan: edited.plan } }
            : { reject: edited.message };
        },
        call: async ({ state }) => {
          if (!state.plan || !state.brief) {
            return { ok: false, message: COPY.noPlan };
          }
          const answer = await runSeoWrite({
            scope,
            brief: state.brief,
            plan: state.plan,
            mode: "write",
          });
          return answer.ok
            ? { ok: true, value: answer.draft }
            : { ok: false, message: answer.message };
        },
        finish: ({ state }, draft) => {
          title = draft.title;
          return {
            step: "review",
            state: {
              ...state,
              article: { ...draft, writtenAt: writtenAt(), rewrites: 0 },
            },
          };
        },
        message: COPY.written,
      });
      if (result.ok && title) await touchWork(projectId, current.workId, title);
      return result;
    },
  );
}

// ---- Review ---------------------------------------------------------------------

// One rewrite of the article on Review, with the person's notes (optional) and
// the on-page warnings; the card stays on Review.
export async function rewriteSeoArticleAction(
  projectId: string,
  commandId: string,
  notes?: unknown,
): Promise<SeoFlowResult> {
  return seoAction(
    "seo-rewrite",
    projectId,
    commandId,
    AI_BUCKET,
    async ({ auth, commandId: id, current }) => {
      const { article } = current.state;
      if (!article || !current.state.plan || !current.state.brief) {
        return { ok: false, message: COPY.noArticle };
      }
      if (article.rewrites >= SEO_LIMITS.rewrites) {
        return { ok: false, message: COPY.rewriteLimit };
      }
      if (ReasoningService.isMockMode()) {
        return { ok: false, message: COPY.mock };
      }
      const cleanNotes = cleanLine(notes, SEO_LIMITS.notes);
      const scope = scopeOf(auth, projectId);

      return runClaimed<SeoDraft>({
        projectId,
        commandId: id,
        kind: "rewrite",
        fallbackStep: "review",
        claim: ({ step, state }) => {
          if (step !== "review" || !state.article)
            return { reject: COPY.stale };
          if (state.article.rewrites >= SEO_LIMITS.rewrites) {
            return { reject: COPY.rewriteLimit };
          }
          return { step: "review", state };
        },
        call: async ({ state }) => {
          if (!state.article || !state.plan || !state.brief) {
            return { ok: false, message: COPY.noArticle };
          }
          const answer = await runSeoWrite({
            scope,
            brief: state.brief,
            plan: state.plan,
            mode: "rewrite",
            article: state.article,
            notes: cleanNotes,
          });
          return answer.ok
            ? { ok: true, value: answer.draft }
            : { ok: false, message: answer.message };
        },
        finish: ({ state }, draft) => ({
          step: "review",
          state: {
            ...state,
            article: {
              ...draft,
              writtenAt: new Date().toISOString(),
              rewrites: (state.article?.rewrites ?? 0) + 1,
            },
          },
        }),
        message: COPY.rewritten,
      });
    },
  );
}

// Back, the stepper, and Review -> Publish: a move the card allows right now
// (lib/module-flows/seo/state.ts canGoToSeoStep).
export async function goToSeoStepAction(
  projectId: string,
  commandId: string,
  to: string,
): Promise<SeoFlowResult> {
  return seoAction(
    "seo-step",
    projectId,
    commandId,
    WRITE_BUCKET,
    async ({ commandId: id }) => {
      if (!isModuleFlowStep(to)) {
        return { ok: false, message: GUARD_MESSAGE.failed };
      }
      const written = await writeSeoCard({
        projectId,
        commandId: id,
        update: ({ step, state }) =>
          canGoToSeoStep({ step, state, to })
            ? { step: to, state }
            : { reject: COPY.stale },
      });
      refresh(projectId);
      return written.ok ? { ok: true } : failed(written.message);
    },
  );
}

// ---- Publish ----------------------------------------------------------------------

type Placed =
  | { ok: true; delivery: SeoDelivery }
  | { ok: false; message: string; code?: "STALE" };

// The article onto the Content Calendar at `when` (wall clock in the project's
// timezone), once per card: a card that already has its piece keeps it.
async function placeOnCalendar(input: {
  projectId: string;
  commandId: string;
  current: SeoCardRead;
  auth: WorksAuth;
  timezone: string;
  when: string;
}): Promise<Placed> {
  const { projectId, commandId, current, auth } = input;
  const { article, plan, brief } = current.state;
  if (current.step !== "deliver" || !article) {
    return { ok: false, message: COPY.stale, code: "STALE" };
  }
  if (current.state.delivery)
    return { ok: true, delivery: current.state.delivery };
  if (seoRunActive(current.state.run)) return { ok: false, message: COPY.busy };
  // The piece is created before the card is written: a completed Work must
  // refuse first, not after.
  const active = await assertWorkActive(prisma, {
    workId: current.workId,
    projectId,
  });
  if (!active.ok) return { ok: false, message: active.message };

  let delivery: SeoDelivery;
  try {
    const placed = await placeSeoArticle({
      scope: scopeOf(auth, projectId),
      userId: auth.userId,
      commandId,
      workId: current.workId,
      timezone: input.timezone,
      when: input.when,
      article,
      plan,
      brief,
    });
    delivery = {
      postId: placed.postId,
      creativeId: placed.creativeId,
      scheduledFor: placed.scheduledFor.toISOString(),
      timezone: input.timezone,
    };
  } catch (error) {
    console.error(
      "[works] seo calendar failed:",
      error instanceof Error ? error.message : error,
    );
    return { ok: false, message: COPY.calendarFailed };
  }

  const written = await writeSeoCard({
    projectId,
    commandId,
    update: ({ step, state }) => {
      if (state.delivery) {
        return state.delivery.creativeId === delivery.creativeId
          ? { step, state }
          : { reject: COPY.stale };
      }
      if (step !== "deliver" || !state.article) return { reject: COPY.stale };
      return { step, state: { ...state, delivery } };
    },
  });
  if (!written.ok) {
    return written.message === COPY.stale
      ? { ok: false, message: written.message, code: "STALE" }
      : { ok: false, message: written.message };
  }
  await AuditLogRepository.record({
    workspaceId: auth.workspaceId,
    projectId,
    brandId: auth.defaultBrandId,
    actorType: "USER",
    actorId: auth.userId,
    action: "seo.article_scheduled",
    entityType: "Creative",
    entityId: delivery.creativeId,
  }).catch(() => undefined);
  return { ok: true, delivery: written.state.delivery ?? delivery };
}

// "Add to calendar": the day and time the article goes live on the site.
export async function scheduleSeoArticleAction(
  projectId: string,
  commandId: string,
  when: string,
): Promise<SeoFlowResult> {
  return seoAction(
    "seo-schedule",
    projectId,
    commandId,
    WRITE_BUCKET,
    async ({ auth, commandId: id, current }) => {
      if (!isWallClock(when)) return { ok: false, message: COPY.when };
      const timezone = await getProjectTimezone(projectId);
      const scheduledFor = zonedDateTimeToUtc(when, timezone);
      if (scheduledFor.getTime() < Date.now() - PAST_GRACE_MS) {
        return { ok: false, message: COPY.past };
      }
      const placed = await placeOnCalendar({
        projectId,
        commandId: id,
        current,
        auth,
        timezone,
        when,
      });
      refresh(projectId, true);
      if (!placed.ok) return placed;
      const at = formatWhen(
        placed.delivery.scheduledFor,
        placed.delivery.timezone,
      );
      return { ok: true, message: `On your calendar for ${at}.` };
    },
  );
}

// "Mark as published": the article is live on the site. Without a calendar
// piece yet, it is placed now first; the piece then goes through the existing
// manual-publish path (markCreativePublishedAction).
export async function markSeoPublishedAction(
  projectId: string,
  commandId: string,
): Promise<SeoFlowResult> {
  return seoAction(
    "seo-published",
    projectId,
    commandId,
    WRITE_BUCKET,
    async ({ auth, commandId: id, current }) => {
      if (current.step !== "deliver" || !current.state.article) {
        return failed(COPY.stale);
      }
      if (current.state.delivery?.publishedAt) {
        return { ok: true, message: COPY.published };
      }

      let delivery = current.state.delivery;
      if (!delivery) {
        const timezone = await getProjectTimezone(projectId);
        const placed = await placeOnCalendar({
          projectId,
          commandId: id,
          current,
          auth,
          timezone,
          when: utcToZonedDateTimeLocal(new Date(), timezone),
        });
        if (!placed.ok) {
          refresh(projectId, true);
          return placed;
        }
        delivery = placed.delivery;
      }

      const creativeId = delivery.creativeId;
      const status = await seoPieceStatus(projectId, creativeId);
      if (!status) {
        // Removed from the calendar meanwhile: the card offers it again.
        await writeSeoCard({
          projectId,
          commandId: id,
          update: ({ step, state }) => {
            if (state.delivery?.creativeId !== creativeId) {
              return { reject: COPY.stale };
            }
            const next = { ...state };
            delete next.delivery;
            return { step, state: next };
          },
        });
        refresh(projectId, true);
        return { ok: false, message: COPY.gone };
      }
      if (status !== "PUBLISHED") {
        const marked = await markCreativePublishedAction(creativeId);
        if (!marked.ok) {
          refresh(projectId, true);
          return { ok: false, message: marked.message };
        }
      }

      const publishedAt = new Date().toISOString();
      const written = await writeSeoCard({
        projectId,
        commandId: id,
        update: ({ step, state }) =>
          state.delivery?.creativeId === creativeId
            ? {
                step,
                state: {
                  ...state,
                  delivery: {
                    ...state.delivery,
                    publishedAt: state.delivery.publishedAt ?? publishedAt,
                  },
                },
              }
            : { reject: COPY.stale },
      });
      refresh(projectId, true);
      return written.ok
        ? { ok: true, message: COPY.published }
        : failed(written.message);
    },
  );
}
