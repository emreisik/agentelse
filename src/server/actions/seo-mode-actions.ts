"use server";

import { revalidatePath } from "next/cache";

import { cleanLine, isSeoLanguage } from "@/lib/module-flows/seo/brief";
import { countWords } from "@/lib/module-flows/seo/markdown";
import { SNIPPET_LIMITS } from "@/lib/module-flows/seo/snippet";
import {
  SEO_LIMITS,
  SEO_MODES,
  seoModeOf,
  seoRunActive,
  type SeoBrief,
  type SeoMode,
  type SeoState,
  type SeoTarget,
} from "@/lib/module-flows/seo/state";
import { SeoActionFlags, seoActionsAllowedFor } from "@/lib/seo/action-flags";
import type {
  PageSnapshot,
  SeoActionProposalStored,
  SeoActionView,
} from "@/lib/seo/actions/types";
import { workSummaryFrom } from "@/lib/works/work";
import {
  runSeoClaimed,
  verifyActionSoon,
} from "@/server/modules/seo/background";
import {
  readSeoCard,
  writeSeoCard,
  type SeoCardRead,
} from "@/server/modules/seo/card";
import type { SeoScope } from "@/server/modules/seo/context";
import {
  createSeoManagerCard,
  SEO_MODE_TITLE,
} from "@/server/modules/seo/new-card";
import { runSeoRefreshResearch } from "@/server/modules/seo/refresh";
import { runSeoSnippet } from "@/server/modules/seo/snippet";
import {
  listTargetPages,
  pageQueriesForPrompt,
  readTarget,
  type SeoTargetPage,
} from "@/server/modules/seo/target";
import { ReasoningService } from "@/server/reasoning/reasoning-service";
import { WorkRepository } from "@/server/repositories/work.repository";
import { readSeoLearnings } from "@/server/seo/actions/learnings";
import {
  actionForCard,
  createSeoAction,
  getAction,
  requestCheckNow,
  transitionAction,
  updateProposal,
} from "@/server/seo/actions/store";
import {
  GUARD_MESSAGE,
  authorizeWorks,
  guardedAction,
  idSchema,
  type WorksAuth,
} from "@/server/works/guard";

// SEO Manager'ın "Refresh a page" ve "Fix the snippet" kipleri ile kartın
// eylem düğmeleri (docs/search-actions.md "SEO Manager"): hedef sayfa seçimi,
// başlık/meta varyantları, tazeleme araştırması, "uygulandı", "canlı" ve "şimdi
// kontrol et". Aynı koruma deseni (authorizeWorks kovaları, idSchema,
// guardedAction); model çağrıları kartı sahiplenir ve SEO_ACTIONS açıkken
// arka planda koşar. Hepsi çağrı anında bayrağı yeniden denetler.

const AI_BUCKET = { bucket: "seo-flow-ai", limit: 20 } as const;
const WRITE_BUCKET = { bucket: "seo-flow", limit: 60 } as const;
const READ_BUCKET = { bucket: "seo-flow-read", limit: 120 } as const;

const COPY = {
  unavailable: "This isn't available for this project yet.",
  mock: "Researching and writing need the live AI model, which is switched off here.",
  busy: "Already working on this card. It updates when it's done.",
  stale: "This card changed. Refreshing.",
  completed: GUARD_MESSAGE.completed,
  badUrl: "Pick a page on your site.",
  badLanguage: "Pick the page's language.",
  badChoice: "Pick one of the suggestions.",
  noTitle: "Add a title.",
  noMeta: "Add a description.",
  titleLong: `The title can be at most ${SNIPPET_LIMITS.titleMax} characters.`,
  metaLong: `The description can be at most ${SNIPPET_LIMITS.metaMax} characters.`,
  noAction: "There is nothing to update here yet.",
  chosen: "Saved. Review it, then apply it on your site.",
  applied: "Marked as applied. We'll check your page.",
  live: "Got it. We'll measure from here.",
  undone: "Back to to-do.",
  queued: "We'll check your page shortly.",
  tooSoon: "We just checked. Try again in a few minutes.",
  moved: "This already moved on. Refreshing.",
  snippetReady: "Three new titles are ready.",
  refreshReady: "The page is researched. Review the plan.",
} as const;

export type SeoModeResult =
  | { ok: true; message?: string; runId?: string; commandId?: string }
  | { ok: false; message: string; code?: "STALE" };

export type SeoTargetPagesResult =
  { ok: true; pages: SeoTargetPage[] } | { ok: false; message: string };

function failed(message: string): SeoModeResult {
  return message === COPY.stale
    ? { ok: false, message, code: "STALE" }
    : { ok: false, message };
}

function refresh(projectId: string): void {
  revalidatePath(`/projects/${projectId}`);
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

type Need = "manager" | "loop";

function flagOpen(projectId: string, need: Need): boolean {
  if (!SeoActionFlags.manager()) return false;
  return need === "manager"
    ? true
    : SeoActionFlags.loop() && seoActionsAllowedFor(projectId);
}

type ActionContext = {
  auth: WorksAuth;
  commandId: string;
  current: SeoCardRead;
};

// Bayrak, yetki, hız sınırı, sınırlı kimlik ve kartın kendisi; sonra adım.
async function modeAction(
  label: string,
  projectId: string,
  commandId: unknown,
  bucket: { bucket: string; limit: number },
  need: Need,
  run: (context: ActionContext) => Promise<SeoModeResult>,
): Promise<SeoModeResult> {
  if (!flagOpen(projectId, need)) {
    return { ok: false, message: COPY.unavailable };
  }
  const result = await guardedAction(
    label,
    async (): Promise<SeoModeResult> => {
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

function isMode(value: unknown): value is SeoMode {
  return (SEO_MODES as readonly unknown[]).includes(value);
}

// ---- yeni kart ve kip -----------------------------------------------------------------

// "Write another" / kip seçimi: aynı Work'te HER ZAMAN yeni bir kart açar
// (eski kartlar olduğu gibi kalır).
export async function startSeoCardAction(
  projectId: string,
  workId: string,
  mode: string,
): Promise<SeoModeResult> {
  if (!isMode(mode)) return { ok: false, message: GUARD_MESSAGE.failed };
  if (!flagOpen(projectId, mode === "article" ? "manager" : "loop")) {
    return { ok: false, message: COPY.unavailable };
  }
  const result = await guardedAction(
    "seo-card-start",
    async (): Promise<SeoModeResult> => {
      const gate = await authorizeWorks(projectId, WRITE_BUCKET);
      if (!gate.ok) return { ok: false, message: gate.message };
      const id = idSchema.safeParse(workId);
      if (!id.success) return { ok: false, message: GUARD_MESSAGE.failed };
      const work = await WorkRepository.get(projectId, id.data);
      if (!work) return { ok: false, message: GUARD_MESSAGE.failed };
      if (work.status !== "ACTIVE") {
        return { ok: false, message: COPY.completed };
      }
      const created = await createSeoManagerCard({
        scope: scopeOf(gate.auth, projectId),
        userId: gate.auth.userId,
        mode,
        work: { existingId: work.id },
      });
      await WorkRepository.touch(projectId, work.id, {
        summary: workSummaryFrom(SEO_MODE_TITLE[mode]),
      }).catch(() => undefined);
      refresh(projectId);
      return { ok: true, commandId: created.commandId };
    },
  );
  return result.ok ? result : { ok: false, message: result.message };
}

// Taze kartın kipini değiştirir (kip seçici): ilerlemiş karta dokunulmaz.
export async function setSeoModeAction(
  projectId: string,
  commandId: string,
  mode: string,
): Promise<SeoModeResult> {
  if (!isMode(mode)) return { ok: false, message: GUARD_MESSAGE.failed };
  return modeAction(
    "seo-mode",
    projectId,
    commandId,
    WRITE_BUCKET,
    mode === "article" ? "manager" : "loop",
    async ({ commandId: id }) => {
      const written = await writeSeoCard({
        projectId,
        commandId: id,
        update: ({ step, state }) => {
          if (seoModeOf(state) === mode) return { step, state };
          const fresh =
            step === "brief" &&
            !state.plan &&
            !state.article &&
            !state.delivery &&
            !state.snippet &&
            !state.actionId &&
            !seoRunActive(state.run);
          if (!fresh) return { reject: COPY.stale };
          const next: SeoState = { ...state, mode };
          delete next.target;
          delete next.pendingUrl;
          delete next.lastError;
          return { step, state: next };
        },
      });
      refresh(projectId);
      return written.ok ? { ok: true } : failed(written.message);
    },
  );
}

// Seçilebilir sayfalar (ambar ya da kendi tarayıcımızın sayfaları).
export async function seoTargetPagesAction(
  projectId: string,
): Promise<SeoTargetPagesResult> {
  if (!flagOpen(projectId, "loop")) {
    return { ok: false, message: COPY.unavailable };
  }
  const result = await guardedAction(
    "seo-target-pages",
    async (): Promise<SeoTargetPagesResult> => {
      const gate = await authorizeWorks(projectId, READ_BUCKET);
      if (!gate.ok) return { ok: false, message: gate.message };
      return { ok: true, pages: await listTargetPages(projectId) };
    },
  );
  return result.ok ? result : { ok: false, message: result.message };
}

// ---- hedef sayfa girişi ------------------------------------------------------------------

type TargetInput =
  { ok: true; url: string; language: string } | { ok: false; message: string };

function parseTargetInput(input: unknown): TargetInput {
  const raw =
    input && typeof input === "object" && !Array.isArray(input)
      ? (input as Record<string, unknown>)
      : {};
  const url = cleanLine(raw.url, 2048);
  let valid = false;
  try {
    const parsed = new URL(url);
    valid = parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    valid = false;
  }
  if (!valid) return { ok: false, message: COPY.badUrl };
  if (!isSeoLanguage(raw.language)) {
    return { ok: false, message: COPY.badLanguage };
  }
  return { ok: true, url, language: raw.language };
}

// Sayfanın başlığı konu olur (en az 3 karakter); başlık yoksa yol.
function briefFor(target: SeoTarget, language: string): SeoBrief {
  const named = cleanLine(target.title ?? target.path, SEO_LIMITS.topic);
  const topic =
    Array.from(named).length >= SEO_LIMITS.topicMin ? named : "Home page";
  let siteUrl = "";
  try {
    siteUrl = new URL(target.url).origin.slice(0, SEO_LIMITS.siteUrl);
  } catch {
    siteUrl = "";
  }
  return { topic, siteUrl, language, audience: "" };
}

function withoutPending(state: SeoState): SeoState {
  const next = { ...state };
  delete next.pendingUrl;
  return next;
}

// Kartın eylemi: kartın actionId'si, yoksa kart kimliğiyle bağlı olan.
async function actionOfCard(
  projectId: string,
  commandId: string,
  state: SeoState,
): Promise<SeoActionView | null> {
  return state.actionId
    ? getAction(projectId, state.actionId)
    : actionForCard(projectId, commandId);
}

function isOpen(action: SeoActionView): boolean {
  return action.status === "PROPOSED" || action.status === "ACCEPTED";
}

// Kartın eylemi yoksa açar, açık ve aynı türdeyse önerisini yeniler. Eylem
// kaydı hata verirse model sonucu yine de kartta kalır (null döner).
async function upsertCardAction(input: {
  projectId: string;
  commandId: string;
  workId: string | null;
  auth: WorksAuth;
  state: SeoState;
  kind: "TITLE_META" | "CONTENT_REFRESH";
  proposal: SeoActionProposalStored;
  target: SeoTarget;
  baseline: PageSnapshot;
}): Promise<string | null> {
  const { projectId, commandId } = input;
  try {
    const existing = await actionOfCard(projectId, commandId, input.state);
    if (existing) {
      if (existing.kind === input.kind && isOpen(existing)) {
        await updateProposal({
          projectId,
          actionId: existing.id,
          proposal: { ...input.proposal, note: existing.proposal.note },
          targetUrl: input.target.url,
          baseline: input.baseline,
        });
      }
      return existing.id;
    }
    const created = await createSeoAction({
      workspaceId: input.auth.workspaceId,
      projectId,
      kind: input.kind,
      source: "SEO_MANAGER",
      status: "PROPOSED",
      openKey: `card:${commandId}`,
      targetUrl: input.target.url,
      pageId: null,
      targetQueries: [],
      proposal: input.proposal,
      baseline: input.baseline,
      commandId,
      workId: input.workId,
      userId: input.auth.userId,
    });
    return created.action.id;
  } catch (error) {
    console.error(
      "[works] seo card action failed:",
      error instanceof Error ? error.message : error,
    );
    return null;
  }
}

// ---- Fix the snippet ------------------------------------------------------------------------

type SnippetValue = {
  brief: SeoBrief;
  target: SeoTarget;
  snippet: NonNullable<SeoState["snippet"]>;
  actionId: string | null;
};

// Sayfayı okur, üç başlık/meta varyantı üretir; kart Plan'a geçer ve TITLE_META
// eylemi PROPOSED olarak açılır (önerisinde yalnız varyantlar; sorgu metni yok).
export async function suggestSnippetAction(
  projectId: string,
  commandId: string,
  input: unknown,
): Promise<SeoModeResult> {
  return modeAction(
    "seo-snippet",
    projectId,
    commandId,
    AI_BUCKET,
    "loop",
    async ({ auth, commandId: id, current }) => {
      const checked = parseTargetInput(input);
      if (!checked.ok) return { ok: false, message: checked.message };
      if (seoModeOf(current.state) !== "snippet") return failed(COPY.stale);
      // A mock answer must never be written into a real card.
      if (ReasoningService.isMockMode()) {
        return { ok: false, message: COPY.mock };
      }
      const { url, language } = checked;
      const scope = scopeOf(auth, projectId);

      return runSeoClaimed<SnippetValue>({
        projectId,
        commandId: id,
        kind: "snippet",
        fallbackStep: "brief",
        phase: "reading_page",
        copy: { busy: COPY.busy, stale: COPY.stale },
        claim: ({ step, state }) =>
          (step === "brief" || step === "plan") &&
          !state.applied &&
          !state.delivery
            ? { step: "brief", state: { ...state, pendingUrl: url } }
            : { reject: COPY.stale },
        call: async (_claimed, setPhase) => {
          const read = await readTarget(projectId, url);
          if (!read.ok) return { ok: false, message: read.message };
          await setPhase("writing");
          const brief = briefFor(read.target, language);
          const [queries, learnings] = await Promise.all([
            pageQueriesForPrompt(projectId, url),
            readSeoLearnings(projectId, 5),
          ]);
          const answer = await runSeoSnippet({
            scope,
            brief,
            target: read.target,
            queries,
            learnings,
          });
          if (!answer.ok) return { ok: false, message: answer.message };

          const before = read.baseline;
          const actionId = await upsertCardAction({
            projectId,
            commandId: id,
            workId: current.workId,
            auth,
            state: current.state,
            kind: "TITLE_META",
            target: read.target,
            baseline: read.baseline,
            proposal: {
              v: 1,
              kind: "TITLE_META",
              before:
                before.title || before.metaDescription
                  ? {
                      title: before.title ?? "",
                      metaDescription: before.metaDescription ?? "",
                    }
                  : null,
              after: null,
              variants: answer.snippet.variants.map((variant) => ({
                title: variant.title,
                metaDescription: variant.metaDescription,
                angle: variant.angle,
              })),
              note: null,
              alert: null,
            },
          });
          return {
            ok: true,
            value: {
              brief,
              target: read.target,
              snippet: answer.snippet,
              actionId,
            },
          };
        },
        finish: ({ state }, value) => ({
          step: "plan",
          state: {
            ...withoutPending(state),
            brief: value.brief,
            target: value.target,
            snippet: value.snippet,
            ...(value.actionId ? { actionId: value.actionId } : {}),
          },
        }),
        afterDone: (value) =>
          touchWork(
            projectId,
            current.workId,
            value.target.title ?? value.target.path,
          ),
        message: COPY.snippetReady,
      });
    },
  );
}

type SnippetChoice =
  | {
      ok: true;
      index: number;
      edited: { title: string; metaDescription: string } | null;
    }
  | { ok: false; message: string };

function tooLong(raw: unknown, max: number): boolean {
  return typeof raw === "string" && Array.from(raw.trim()).length > max;
}

// {index, edited?}: varyantın sırası ve (isteğe bağlı) kullanıcının düzelttiği
// metin. Üst sınırlar SNIPPET_LIMITS'ten; sunucu otoritedir.
function parseChoice(
  input: unknown,
  variants: NonNullable<SeoState["snippet"]>["variants"],
): SnippetChoice {
  const raw =
    input && typeof input === "object" && !Array.isArray(input)
      ? (input as Record<string, unknown>)
      : {};
  const index = raw.index;
  if (
    typeof index !== "number" ||
    !Number.isInteger(index) ||
    index < 0 ||
    index >= variants.length
  ) {
    return { ok: false, message: COPY.badChoice };
  }
  const variant = variants[index];
  if (!variant) return { ok: false, message: COPY.badChoice };
  const editedRaw =
    raw.edited && typeof raw.edited === "object" && !Array.isArray(raw.edited)
      ? (raw.edited as Record<string, unknown>)
      : null;
  if (!editedRaw) return { ok: true, index, edited: null };

  if (tooLong(editedRaw.title, SNIPPET_LIMITS.titleMax)) {
    return { ok: false, message: COPY.titleLong };
  }
  if (tooLong(editedRaw.metaDescription, SNIPPET_LIMITS.metaMax)) {
    return { ok: false, message: COPY.metaLong };
  }
  const title = cleanLine(editedRaw.title, SNIPPET_LIMITS.titleMax);
  const metaDescription = cleanLine(
    editedRaw.metaDescription,
    SNIPPET_LIMITS.metaMax,
  );
  if (!title) return { ok: false, message: COPY.noTitle };
  if (!metaDescription) return { ok: false, message: COPY.noMeta };
  const same =
    title === variant.title && metaDescription === variant.metaDescription;
  return { ok: true, index, edited: same ? null : { title, metaDescription } };
}

// Bir varyantı (ya da düzeltilmiş hâlini) seçer: kart Deliver'a geçer, eylem
// ACCEPTED olur ve önerisine seçilen metin (after) yazılır.
export async function chooseSnippetAction(
  projectId: string,
  commandId: string,
  choice: unknown,
): Promise<SeoModeResult> {
  return modeAction(
    "seo-snippet-choose",
    projectId,
    commandId,
    WRITE_BUCKET,
    "loop",
    async ({ auth, commandId: id, current }) => {
      const { state } = current;
      if (
        seoModeOf(state) !== "snippet" ||
        current.step !== "plan" ||
        !state.snippet ||
        state.applied ||
        seoRunActive(state.run)
      ) {
        return failed(COPY.stale);
      }
      const checked = parseChoice(choice, state.snippet.variants);
      if (!checked.ok) return { ok: false, message: checked.message };
      const variant = state.snippet.variants[checked.index];
      if (!variant) return { ok: false, message: COPY.badChoice };
      const picked = checked.edited ?? {
        title: variant.title,
        metaDescription: variant.metaDescription,
      };

      const written = await writeSeoCard({
        projectId,
        commandId: id,
        update: ({ step, state: latest }) =>
          step === "plan" &&
          latest.snippet &&
          !latest.applied &&
          !seoRunActive(latest.run)
            ? {
                step: "deliver",
                state: {
                  ...latest,
                  snippet: {
                    ...latest.snippet,
                    chosen: checked.index,
                    edited: checked.edited,
                  },
                },
              }
            : { reject: COPY.stale },
      });
      if (!written.ok) {
        refresh(projectId);
        return failed(written.message);
      }

      // Eylem: seçilen metinle ACCEPTED (yoksa açılır).
      try {
        const action = await actionOfCard(projectId, id, state);
        if (action && action.kind === "TITLE_META" && isOpen(action)) {
          if (action.proposal.kind === "TITLE_META") {
            await transitionAction({
              projectId,
              actionId: action.id,
              event: "ACCEPT",
              userId: auth.userId,
              patch: { proposal: { ...action.proposal, after: picked } },
            });
          }
        } else if (!action) {
          const target = state.target;
          const created = await createSeoAction({
            workspaceId: auth.workspaceId,
            projectId,
            kind: "TITLE_META",
            source: "SEO_MANAGER",
            status: "ACCEPTED",
            openKey: `card:${id}`,
            targetUrl: target?.url ?? null,
            pageId: null,
            targetQueries: [],
            proposal: {
              v: 1,
              kind: "TITLE_META",
              before: target
                ? {
                    title: target.title ?? "",
                    metaDescription: target.metaDescription ?? "",
                  }
                : null,
              after: picked,
              variants: [],
              note: null,
              alert: null,
            },
            commandId: id,
            workId: current.workId,
            userId: auth.userId,
          });
          await writeSeoCard({
            projectId,
            commandId: id,
            update: ({ step, state: latest }) =>
              latest.actionId
                ? { step, state: latest }
                : { step, state: { ...latest, actionId: created.action.id } },
          });
        }
      } catch (error) {
        console.error(
          "[works] seo snippet action failed:",
          error instanceof Error ? error.message : error,
        );
      }
      refresh(projectId);
      return { ok: true, message: COPY.chosen };
    },
  );
}

// ---- Refresh a page -----------------------------------------------------------------------------

type RefreshValue = {
  brief: SeoBrief;
  target: SeoTarget;
  plan: NonNullable<SeoState["plan"]>;
  refresh: NonNullable<SeoState["refresh"]>;
  actionId: string | null;
};

// Sayfayı okur, tazeleme araştırmasını yapar; kart Plan'a geçer ve
// CONTENT_REFRESH eylemi PROPOSED olarak açılır.
export async function researchRefreshAction(
  projectId: string,
  commandId: string,
  input: unknown,
): Promise<SeoModeResult> {
  return modeAction(
    "seo-refresh-research",
    projectId,
    commandId,
    AI_BUCKET,
    "loop",
    async ({ auth, commandId: id, current }) => {
      const checked = parseTargetInput(input);
      if (!checked.ok) return { ok: false, message: checked.message };
      if (seoModeOf(current.state) !== "refresh") return failed(COPY.stale);
      if (ReasoningService.isMockMode()) {
        return { ok: false, message: COPY.mock };
      }
      const { url, language } = checked;
      const scope = scopeOf(auth, projectId);

      return runSeoClaimed<RefreshValue>({
        projectId,
        commandId: id,
        kind: "research",
        fallbackStep: "brief",
        phase: "reading_page",
        copy: { busy: COPY.busy, stale: COPY.stale },
        claim: ({ step, state }) =>
          (step === "brief" || step === "plan") &&
          !state.applied &&
          !state.delivery
            ? { step: "brief", state: { ...state, pendingUrl: url } }
            : { reject: COPY.stale },
        call: async (_claimed, setPhase) => {
          const read = await readTarget(projectId, url, { textChars: 6000 });
          if (!read.ok) return { ok: false, message: read.message };
          await setPhase("researching");
          const brief = briefFor(read.target, language);
          const [queries, learnings] = await Promise.all([
            pageQueriesForPrompt(projectId, url),
            readSeoLearnings(projectId, 5),
          ]);
          const answer = await runSeoRefreshResearch({
            scope,
            brief,
            target: read.target,
            pageText: read.text,
            queries,
            learnings,
          });
          if (!answer.ok) return { ok: false, message: answer.message };

          const actionId = await upsertCardAction({
            projectId,
            commandId: id,
            workId: current.workId,
            auth,
            state: current.state,
            kind: "CONTENT_REFRESH",
            target: read.target,
            baseline: read.baseline,
            proposal: {
              v: 1,
              kind: "CONTENT_REFRESH",
              primaryKeyword: answer.plan.primaryKeyword || null,
              missing: answer.refresh.missing.slice(0, 8),
              after: null,
              note: null,
              alert: null,
            },
          });
          return {
            ok: true,
            value: {
              brief,
              target: read.target,
              plan: answer.plan,
              refresh: answer.refresh,
              actionId,
            },
          };
        },
        finish: ({ state }, value) => ({
          step: "plan",
          state: {
            ...withoutPending(state),
            brief: value.brief,
            target: value.target,
            plan: value.plan,
            refresh: value.refresh,
            ...(value.actionId ? { actionId: value.actionId } : {}),
          },
        }),
        afterDone: (value) =>
          touchWork(
            projectId,
            current.workId,
            value.target.title ?? value.target.path,
          ),
        message: COPY.refreshReady,
      });
    },
  );
}

// ---- Uygulandı, canlı, şimdi kontrol et, geri al ---------------------------------------------------

// Uygulandıktan sonra eylemin önerisinde kalacak metin: başlık kartında seçilen
// varyant, tazeleme kartında yazılan makalenin başlığı ve uzunluğu.
function appliedProposal(
  proposal: SeoActionProposalStored,
  state: SeoState,
): SeoActionProposalStored | null {
  if (proposal.kind === "TITLE_META") {
    const snippet = state.snippet;
    const variant =
      snippet && snippet.chosen !== null
        ? snippet.variants[snippet.chosen]
        : undefined;
    const after =
      snippet?.edited ??
      (variant
        ? { title: variant.title, metaDescription: variant.metaDescription }
        : proposal.after);
    return after ? { ...proposal, after } : null;
  }
  if (proposal.kind === "CONTENT_REFRESH" && state.article) {
    return {
      ...proposal,
      after: {
        title: state.article.title,
        metaDescription: state.article.metaDescription,
        wordCount: countWords(state.article.markdown),
      },
    };
  }
  return null;
}

// Başlık/tazeleme kartı Deliver'da: "Applied it on my site". Eylem APPLIED olur
// (gerekirse önce ACCEPTED), kart kilitlenir, doğrulayıcı cevaptan sonra bakar.
export async function markSeoAppliedAction(
  projectId: string,
  commandId: string,
): Promise<SeoModeResult> {
  return modeAction(
    "seo-applied",
    projectId,
    commandId,
    WRITE_BUCKET,
    "loop",
    async ({ auth, commandId: id, current }) => {
      const { state } = current;
      const mode = seoModeOf(state);
      if (mode === "article" || current.step !== "deliver") {
        return failed(COPY.stale);
      }
      if (seoRunActive(state.run)) return { ok: false, message: COPY.busy };
      if (state.applied) return { ok: true, message: COPY.applied };

      let verifyId: string | null = null;
      const action = await actionOfCard(projectId, id, state);
      if (action) {
        if (isOpen(action)) {
          const proposal = appliedProposal(action.proposal, state);
          if (action.status === "PROPOSED") {
            const accepted = await transitionAction({
              projectId,
              actionId: action.id,
              event: "ACCEPT",
              userId: auth.userId,
              ...(proposal ? { patch: { proposal } } : {}),
            });
            if (!accepted.ok) return failed(COPY.moved);
          }
          const applied = await transitionAction({
            projectId,
            actionId: action.id,
            event: "APPLY",
            userId: auth.userId,
            ...(proposal ? { patch: { proposal } } : {}),
          });
          if (!applied.ok) return failed(COPY.moved);
          verifyId = action.id;
        }
      } else {
        const target = state.target;
        const kind = mode === "snippet" ? "TITLE_META" : "CONTENT_REFRESH";
        const base: SeoActionProposalStored | null =
          kind === "TITLE_META"
            ? {
                v: 1,
                kind: "TITLE_META",
                before: target
                  ? {
                      title: target.title ?? "",
                      metaDescription: target.metaDescription ?? "",
                    }
                  : null,
                after: null,
                variants: [],
                note: null,
                alert: null,
              }
            : {
                v: 1,
                kind: "CONTENT_REFRESH",
                primaryKeyword: state.plan?.primaryKeyword ?? null,
                missing: state.refresh?.missing.slice(0, 8) ?? [],
                after: null,
                note: null,
                alert: null,
              };
        const proposal = appliedProposal(base, state);
        const created = await createSeoAction({
          workspaceId: auth.workspaceId,
          projectId,
          kind,
          source: "SEO_MANAGER",
          status: "APPLIED",
          openKey: `card:${id}`,
          targetUrl: target?.url ?? null,
          pageId: null,
          targetQueries: [],
          proposal: proposal ?? base,
          commandId: id,
          workId: current.workId,
          userId: auth.userId,
        });
        verifyId = created.created ? created.action.id : null;
        await writeSeoCard({
          projectId,
          commandId: id,
          update: ({ step, state: latest }) =>
            latest.actionId
              ? { step, state: latest }
              : { step, state: { ...latest, actionId: created.action.id } },
        });
      }

      const written = await writeSeoCard({
        projectId,
        commandId: id,
        update: ({ step, state: latest }) =>
          step === "deliver" && !latest.applied
            ? {
                step,
                state: {
                  ...latest,
                  applied: { at: new Date().toISOString() },
                },
              }
            : { step, state: latest },
      });
      refresh(projectId);
      if (!written.ok) return failed(written.message);
      if (verifyId) verifyActionSoon(verifyId);
      return { ok: true, message: COPY.applied };
    },
  );
}

type CardActionTarget =
  { ok: true; action: SeoActionView } | { ok: false; message: string };

async function cardActionOf(
  projectId: string,
  commandId: string,
  state: SeoState,
): Promise<CardActionTarget> {
  const action = await actionOfCard(projectId, commandId, state);
  return action ? { ok: true, action } : { ok: false, message: COPY.noAction };
}

// "It's live": kullanıcı değişikliğin canlı olduğunu söyler; ölçüm onayladığı
// andan başlar.
export async function confirmSeoLiveAction(
  projectId: string,
  commandId: string,
): Promise<SeoModeResult> {
  return modeAction(
    "seo-confirm-live",
    projectId,
    commandId,
    WRITE_BUCKET,
    "loop",
    async ({ auth, commandId: id, current }) => {
      const target = await cardActionOf(projectId, id, current.state);
      if (!target.ok) return { ok: false, message: target.message };
      const result = await transitionAction({
        projectId,
        actionId: target.action.id,
        event: "CONFIRM_LIVE",
        userId: auth.userId,
      });
      refresh(projectId);
      return result.ok ? { ok: true, message: COPY.live } : failed(COPY.moved);
    },
  );
}

// "Check now": doğrulayıcı sıradakini hemen alır (aralık kısıtı store'dadır).
export async function checkSeoNowAction(
  projectId: string,
  commandId: string,
): Promise<SeoModeResult> {
  return modeAction(
    "seo-check-now",
    projectId,
    commandId,
    WRITE_BUCKET,
    "loop",
    async ({ commandId: id, current }) => {
      const target = await cardActionOf(projectId, id, current.state);
      if (!target.ok) return { ok: false, message: target.message };
      const queued = await requestCheckNow(projectId, target.action.id);
      if (queued === "not_found") return { ok: false, message: COPY.noAction };
      if (queued === "too_soon") return { ok: true, message: COPY.tooSoon };
      verifyActionSoon(target.action.id);
      refresh(projectId);
      return { ok: true, message: COPY.queued };
    },
  );
}

// "Not done yet": eylem yapılacaklara döner; kart yeniden düzenlenebilir.
export async function undoSeoAppliedAction(
  projectId: string,
  commandId: string,
): Promise<SeoModeResult> {
  return modeAction(
    "seo-undo-applied",
    projectId,
    commandId,
    WRITE_BUCKET,
    "loop",
    async ({ auth, commandId: id, current }) => {
      const target = await cardActionOf(projectId, id, current.state);
      if (!target.ok) return { ok: false, message: target.message };
      const result = await transitionAction({
        projectId,
        actionId: target.action.id,
        event: "UNDO_APPLY",
        userId: auth.userId,
      });
      if (!result.ok) {
        refresh(projectId);
        return failed(COPY.moved);
      }
      if (current.state.applied) {
        await writeSeoCard({
          projectId,
          commandId: id,
          update: ({ step, state }) => {
            const next = { ...state };
            delete next.applied;
            return { step, state: next };
          },
        });
      }
      refresh(projectId);
      return { ok: true, message: COPY.undone };
    },
  );
}
