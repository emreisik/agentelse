"use server";

import { flowHintOf } from "@/lib/module-flows/card";
import { markIdeasPlanned } from "@/server/chat/idea-pool";
import { revalidatePath } from "next/cache";

import { prisma } from "@/lib/prisma";
import { isModuleFlowStep } from "@/lib/module-flows/card";
import { cleanLine, validateSeoBrief } from "@/lib/module-flows/seo/brief";
import { formatWhen, isWallClock } from "@/lib/module-flows/seo/deliver";
import { applyPlanEdits } from "@/lib/module-flows/seo/plan";
import {
  SEO_LIMITS,
  canGoToSeoStep,
  seoModeOf,
  seoRunActive,
  type SeoBrief,
  type SeoDelivery,
} from "@/lib/module-flows/seo/state";
import { SeoActionFlags, seoActionsAllowedFor } from "@/lib/seo/action-flags";
import { hostTwin, inScope, normalizeCrawlUrl } from "@/lib/seo/crawl-url";
import { utcToZonedDateTimeLocal, zonedDateTimeToUtc } from "@/lib/timezone";
import { workSummaryFrom } from "@/lib/works/work";
import { markCreativePublishedAction } from "@/server/actions/plan-progress-actions";
import { getProjectTimezone } from "@/server/chat/content-plan";
import {
  runSeoClaimed,
  verifyActionSoon,
} from "@/server/modules/seo/background";
import { placeSeoArticle, seoPieceStatus } from "@/server/modules/seo/calendar";
import {
  readSeoCard,
  writeSeoCard,
  type SeoCardRead,
} from "@/server/modules/seo/card";
import type { SeoScope } from "@/server/modules/seo/context";
import { loadSeoDefaults } from "@/server/modules/seo/defaults";
import { runSeoResearch } from "@/server/modules/seo/research";
import { readTarget } from "@/server/modules/seo/target";
import { runSeoWrite, type SeoDraft } from "@/server/modules/seo/write";
import { ReasoningService } from "@/server/reasoning/reasoning-service";
import { AuditLogRepository } from "@/server/repositories/audit-log.repository";
import { WorkRepository } from "@/server/repositories/work.repository";
import { readSeoLearnings } from "@/server/seo/actions/learnings";
import { pageCheckSite } from "@/server/seo/actions/page-check";
import {
  actionForCard,
  attachCreative,
  createSeoAction,
  getAction,
  transitionAction,
  updateProposal,
} from "@/server/seo/actions/store";
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

// Tazeleme kipinde sayfanın metni modele en çok bu kadar karakterle gider.
const PAGE_TEXT_CHARS = 6000;

// A time a minute or two behind is the clock, not the past.
const PAST_GRACE_MS = 2 * 60_000;

const COPY = {
  mock: "Researching and writing need the live AI model, which is switched off here.",
  busy: "Already working on this card. It updates when it's done.",
  stale: "This card changed. Refreshing.",
  noBrief: "Fill in the brief first.",
  noPlan: "Research the topic first.",
  noArticle: "Write the article first.",
  noTarget: "Pick the page to refresh first.",
  liveUrlIgnored:
    "That address isn't on your verified site, so we'll look for the page ourselves.",
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
  // runId: model çağrısı arka planda koşuyor (kart canlı güncellenir).
  | { ok: true; message?: string; runId?: string }
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

// Model çağrısı sürücüsü background.ts'te (runSeoClaimed): sahiplen, çağır,
// cevabı yalnız sahiplik sürüyorsa yaz; kart canlı damgalıysa arka planda koşar.
const CLAIM_COPY = { busy: COPY.busy, stale: COPY.stale } as const;

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

      return runSeoClaimed({
        projectId,
        commandId: id,
        kind: "research",
        fallbackStep: "brief",
        phase: "researching",
        copy: CLAIM_COPY,
        claim: ({ step, state }) =>
          step === "brief" || (step === "plan" && !state.plan)
            ? { step: "plan", state: { ...state, brief: researched } }
            : { reject: COPY.stale },
        call: async () => {
          const learnings = await readSeoLearnings(projectId, 5);
          const answer = await runSeoResearch({
            scope,
            brief: researched,
            language: researched.language,
            learnings,
          });
          return answer.ok
            ? { ok: true, value: answer.plan }
            : { ok: false, message: answer.message };
        },
        // A new plan; an article written earlier stays until it is rewritten.
        finish: ({ state }, plan) => ({
          step: "plan",
          state: { ...state, plan },
        }),
        afterDone: () =>
          touchWork(projectId, current.workId, researched.topic),
        message: COPY.researched,
      });
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

      const refreshMode = seoModeOf(current.state) === "refresh";

      return runSeoClaimed<SeoDraft>({
        projectId,
        commandId: id,
        kind: "write",
        fallbackStep: "plan",
        phase: refreshMode ? "reading_page" : "writing",
        copy: CLAIM_COPY,
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
        call: async ({ state }, setPhase) => {
          if (!state.plan || !state.brief) {
            return { ok: false, message: COPY.noPlan };
          }
          const learnings = await readSeoLearnings(projectId, 5);
          if (refreshMode) {
            // Tazeleme: sayfa şimdiki hâliyle okunur (kendi sitemiz, en çok
            // 6.000 karakter), sonra yazılır.
            if (!state.target) return { ok: false, message: COPY.noTarget };
            await setPhase("reading_page");
            const read = await readTarget(projectId, state.target.url, {
              textChars: PAGE_TEXT_CHARS,
            });
            if (!read.ok) return { ok: false, message: read.message };
            await setPhase("writing");
            const answer = await runSeoWrite({
              scope,
              brief: state.brief,
              plan: state.plan,
              mode: "refresh",
              language: state.brief.language,
              learnings,
              current: {
                text: read.text,
                title: read.target.title,
                h2: read.target.h2,
                ...(state.refresh
                  ? {
                      missing: state.refresh.missing,
                      keep: state.refresh.keep,
                    }
                  : {}),
              },
            });
            return answer.ok
              ? { ok: true, value: answer.draft }
              : { ok: false, message: answer.message };
          }
          const answer = await runSeoWrite({
            scope,
            brief: state.brief,
            plan: state.plan,
            mode: "write",
            language: state.brief.language,
            learnings,
          });
          return answer.ok
            ? { ok: true, value: answer.draft }
            : { ok: false, message: answer.message };
        },
        finish: ({ state }, draft) => ({
          step: "review",
          state: {
            ...state,
            article: { ...draft, writtenAt: writtenAt(), rewrites: 0 },
          },
        }),
        afterDone: (draft) =>
          touchWork(projectId, current.workId, draft.title),
        message: COPY.written,
      });
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

      return runSeoClaimed<SeoDraft>({
        projectId,
        commandId: id,
        kind: "rewrite",
        fallbackStep: "review",
        phase: "writing",
        copy: CLAIM_COPY,
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
            language: state.brief.language,
            learnings: await readSeoLearnings(projectId, 5),
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
      ...(flowHintOf(current.card.data).ideaId
        ? { ideaId: flowHintOf(current.card.data).ideaId }
        : {}),
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

  // The idea the article came from leaves the pool ("Planned").
  const ideaId = flowHintOf(current.card.data).ideaId;
  if (ideaId) await markIdeasPlanned(projectId, [ideaId]);

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

// ---- Ölçüm: makalenin eylemi (SC-F6) ----------------------------------------------

function actionLoopOpen(projectId: string): boolean {
  return SeoActionFlags.loop() && seoActionsAllowedFor(projectId);
}

function isArticleAction(
  kind: string,
): kind is "NEW_CONTENT" | "LOCALIZE" {
  return kind === "NEW_CONTENT" || kind === "LOCALIZE";
}

// Kartın eylemini kartın actionId'sine bağlar (zaten bağlıysa dokunmaz).
async function storeActionId(
  projectId: string,
  commandId: string,
  actionId: string,
): Promise<void> {
  await writeSeoCard({
    projectId,
    commandId,
    update: ({ step, state }) =>
      state.actionId ? { step, state } : { step, state: { ...state, actionId } },
  });
}

// Takvime konan makale ölçülür: Fix this'ten gelen eylem varsa AYNI eyleme
// yaratıcı bağlanır (ikinci satır açılmaz, türü korunur); yoksa ve kart makale
// kipindeyse NEW_CONTENT ACCEPTED açılır. Tazeleme ve başlık kartları burada
// eylem açmaz. Hiçbir koşulda zamanlamayı bozmaz.
async function trackScheduledArticle(input: {
  projectId: string;
  commandId: string;
  auth: WorksAuth;
  current: SeoCardRead;
  delivery: SeoDelivery;
}): Promise<void> {
  const { projectId, commandId, auth, current, delivery } = input;
  if (!actionLoopOpen(projectId)) return;
  try {
    const { state } = current;
    const { article, plan, brief } = state;
    if (!article) return;
    const nextCheckAt = new Date(
      Math.max(Date.now(), Date.parse(delivery.scheduledFor)),
    );

    if (state.actionId) {
      const action = await getAction(projectId, state.actionId);
      if (
        !action ||
        !isArticleAction(action.kind) ||
        (action.status !== "PROPOSED" && action.status !== "ACCEPTED")
      ) {
        return;
      }
      const attached = await attachCreative({
        projectId,
        actionId: action.id,
        creativeId: delivery.creativeId,
        nextCheckAt,
      });
      if (
        attached &&
        (action.proposal.kind === "NEW_CONTENT" ||
          action.proposal.kind === "LOCALIZE")
      ) {
        await updateProposal({
          projectId,
          actionId: action.id,
          proposal: {
            ...action.proposal,
            title: article.title,
            language: brief?.language ?? action.proposal.language,
          },
        });
      }
      return;
    }
    if (seoModeOf(state) !== "article") return;

    const created = await createSeoAction({
      workspaceId: auth.workspaceId,
      projectId,
      kind: "NEW_CONTENT",
      source: "SEO_MANAGER",
      status: "ACCEPTED",
      openKey: `card:${commandId}`,
      targetUrl: null,
      pageId: null,
      targetQueries: [],
      proposal: {
        v: 1,
        kind: "NEW_CONTENT",
        title: article.title,
        primaryKeyword: plan?.primaryKeyword ?? null,
        language: brief?.language ?? null,
        liveUrl: null,
        note: null,
        alert: null,
      },
      creativeId: delivery.creativeId,
      commandId,
      workId: current.workId,
      nextCheckAt,
      userId: auth.userId,
    });
    await storeActionId(projectId, commandId, created.action.id);
  } catch (error) {
    console.error(
      "[works] seo action tracking failed:",
      error instanceof Error ? error.message : error,
    );
  }
}

// Kullanıcının yazdığı canlı adres: kendi doğrulanmış sitemizdeyse normalleşmiş
// hâli (eş alan adı köken alan adına çevrilir), değilse null.
async function verifiedLiveUrl(
  projectId: string,
  raw: string,
): Promise<string | null> {
  const site = await pageCheckSite(projectId);
  if (!site) return null;
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(raw)
    ? raw
    : `https://${raw}`;
  let url = normalizeCrawlUrl(withScheme);
  if (!url) return null;
  const parsed = new URL(url);
  if (parsed.hostname.toLowerCase() === hostTwin(site.originHost)) {
    parsed.hostname = site.originHost;
    url = normalizeCrawlUrl(parsed.toString());
    if (!url) return null;
  }
  return inScope(url, site.scope) ? url : null;
}

// "Mark as published" sonrası: eylem uygulandı sayılır ve doğrulayıcı hemen
// bakar. Eylem yoksa (bayraktan önce zamanlanmış) makale kipindeki kart için
// APPLIED açılır. Not: kullanıcıya gösterilecek ek cümle (geçersiz adres).
async function trackPublishedArticle(input: {
  projectId: string;
  commandId: string;
  auth: WorksAuth;
  current: SeoCardRead;
  delivery: SeoDelivery;
  liveUrl: unknown;
}): Promise<string | null> {
  const { projectId, commandId, auth, current, delivery } = input;
  if (!actionLoopOpen(projectId)) return null;
  let note: string | null = null;
  try {
    const raw = typeof input.liveUrl === "string" ? input.liveUrl.trim() : "";
    let url: string | null = null;
    if (raw) {
      url = await verifiedLiveUrl(projectId, raw);
      if (!url) note = COPY.liveUrlIgnored;
    }

    const { state } = current;
    const action = state.actionId
      ? await getAction(projectId, state.actionId)
      : await actionForCard(projectId, commandId);

    let actionId: string | null = null;
    if (action) {
      if (
        isArticleAction(action.kind) &&
        (action.status === "PROPOSED" || action.status === "ACCEPTED")
      ) {
        if (action.status === "PROPOSED") {
          await transitionAction({
            projectId,
            actionId: action.id,
            event: "ACCEPT",
            userId: auth.userId,
          });
        }
        const proposal =
          url &&
          (action.proposal.kind === "NEW_CONTENT" ||
            action.proposal.kind === "LOCALIZE")
            ? { ...action.proposal, liveUrl: url }
            : undefined;
        const applied = await transitionAction({
          projectId,
          actionId: action.id,
          event: "APPLY",
          userId: auth.userId,
          ...(url ? { patch: { targetUrl: url, ...(proposal ? { proposal } : {}) } } : {}),
        });
        if (applied.ok) actionId = action.id;
      }
      if (!state.actionId) await storeActionId(projectId, commandId, action.id);
    } else if (seoModeOf(state) === "article" && state.article) {
      const created = await createSeoAction({
        workspaceId: auth.workspaceId,
        projectId,
        kind: "NEW_CONTENT",
        source: "SEO_MANAGER",
        status: "APPLIED",
        openKey: `card:${commandId}`,
        targetUrl: url,
        pageId: null,
        targetQueries: [],
        proposal: {
          v: 1,
          kind: "NEW_CONTENT",
          title: state.article.title,
          primaryKeyword: state.plan?.primaryKeyword ?? null,
          language: state.brief?.language ?? null,
          liveUrl: url,
          note: null,
          alert: null,
        },
        creativeId: delivery.creativeId,
        commandId,
        workId: current.workId,
        userId: auth.userId,
      });
      await storeActionId(projectId, commandId, created.action.id);
      if (created.created) actionId = created.action.id;
    }

    if (actionId) verifyActionSoon(actionId);
  } catch (error) {
    console.error(
      "[works] seo action tracking failed:",
      error instanceof Error ? error.message : error,
    );
  }
  return note;
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
      await trackScheduledArticle({
        projectId,
        commandId: id,
        auth,
        current,
        delivery: placed.delivery,
      });
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
  liveUrl?: unknown,
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
      if (!written.ok) return failed(written.message);
      const note = await trackPublishedArticle({
        projectId,
        commandId: id,
        auth,
        current,
        delivery,
        liveUrl,
      });
      return {
        ok: true,
        message: note ? `${COPY.published} ${note}` : COPY.published,
      };
    },
  );
}
