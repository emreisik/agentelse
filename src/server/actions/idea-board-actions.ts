"use server";

import type { IdeaStatus } from "@prisma/client";

import { prisma } from "@/lib/prisma";
import type { BoardIdea } from "@/lib/ideas/board";
import {
  DISMISS_REASONS,
  HEADLINE_MAX_WORDS,
  IdeaConceptSchema,
  clampHeadline,
  ideaFingerprint,
  parseIdeaConcept,
  socialChannelsOf,
  type DismissReason,
  type IdeaConcept,
} from "@/lib/ideas/concept";
import { IDEA_ACTION_COPY } from "@/lib/ideas/copy";
import { isPoolStatus } from "@/lib/idea-pool";
import { cleanWorksTextOrNull } from "@/lib/works/clean-text";
import { channelOptions } from "@/lib/works/work";
import {
  IdeaEngine,
  type GenerateIdeasResult,
} from "@/server/ideas/idea-engine";
import { toBoardIdea } from "@/server/ideas/idea-board";
import { ideaChannelsOf, readIdeaRows } from "@/server/ideas/idea-context";
import { makeIdeaPost } from "@/server/ideas/idea-post";
import { generateSeoIdeas, moduleRefillIfDue } from "@/server/ideas/idea-modules";
import { refillIfDue, type RefillResult } from "@/server/ideas/idea-refill";
import { getChannelConnections } from "@/server/integrations/channel-connections";
import { resolveBrandStyleContext } from "@/server/media/brand-style-context";
import { IdeaRepository } from "@/server/repositories/idea.repository";
import {
  authorizeWorks,
  guardedAction,
  refreshWorkPages,
  validId,
  type GuardFail,
} from "@/server/works/guard";

// The Ideas board's actions (docs/ideas.md). Every one checks the session,
// the project and a rate bucket (authorizeWorks), looks the idea up WITH the
// project id, and moves it only through the state machine.

const GENERATE = { bucket: "ideas-generate", limit: 30 } as const;
const EDIT = { bucket: "ideas-edit", limit: 200 } as const;
const MAKE = { bucket: "ideas-make", limit: 40 } as const;

type Fail = { ok: false; code: string; message: string };
export type IdeasResult =
  { ok: true; ideas: BoardIdea[]; rotated: number } | Fail | GuardFail;

function failOf(result: Exclude<RefillResult, { ok: true }>): Fail {
  switch (result.reason) {
    case "BUDGET":
      return { ok: false, code: "BUDGET", message: IDEA_ACTION_COPY.budget };
    case "FULL":
      return { ok: false, code: "FULL", message: IDEA_ACTION_COPY.full };
    case "EMPTY":
      return { ok: false, code: "EMPTY", message: IDEA_ACTION_COPY.empty };
    case "NO_BRAND":
      return { ok: false, code: "NO_BRAND", message: IDEA_ACTION_COPY.noBrand };
    case "NOT_DUE":
      return { ok: false, code: "NOT_DUE", message: IDEA_ACTION_COPY.notDue };
  }
}

async function created(
  projectId: string,
  result: GenerateIdeasResult | RefillResult,
): Promise<IdeasResult> {
  if (!result.ok) return failOf(result);
  const ids = new Set(result.created);
  const rows = (await readIdeaRows(projectId)).filter((row) => ids.has(row.id));
  refreshWorkPages(projectId);
  return {
    ok: true,
    ideas: rows.map((row) => toBoardIdea(row)),
    rotated: result.rotated,
  };
}

// "Generate ideas" (optionally about something), and the board's top-up when
// it opens ("refill": only when the pool is low and a run is due).
export async function generateIdeasAction(
  projectId: string,
  input: { focus?: unknown; count?: unknown; trigger?: unknown; module?: unknown },
): Promise<IdeasResult> {
  return guardedAction("ideas-generate", async (): Promise<IdeasResult> => {
    const gate = await authorizeWorks(projectId, GENERATE);
    if (!gate.ok) return gate;
    if (input?.trigger === "refill") {
      // Post ideas when the pool runs low; ad and article ideas when theirs do.
      const social = await refillIfDue(projectId);
      const modules = await moduleRefillIfDue(projectId).catch(() => []);
      if (!social.ok && modules.length === 0) return created(projectId, social);
      return created(projectId, {
        ok: true,
        created: [...(social.ok ? social.created : []), ...modules],
        rotated: social.ok ? social.rotated : 0,
      });
    }
    const count =
      typeof input?.count === "number" && Number.isFinite(input.count)
        ? Math.min(6, Math.max(1, Math.round(input.count)))
        : 6;
    const focus = cleanWorksTextOrNull(input?.focus, 300) ?? undefined;
    if (input?.module === "seo") {
      return created(
        projectId,
        await generateSeoIdeas({ projectId, count, focus }),
      );
    }
    return created(
      projectId,
      await IdeaEngine.generate({ projectId, count, trigger: "manual", focus }),
    );
  });
}

async function findIdea(projectId: string, ideaId: unknown) {
  if (!validId(ideaId)) return null;
  const row = await prisma.idea.findFirst({
    where: { id: ideaId, projectId },
    select: {
      id: true,
      status: true,
      title: true,
      description: true,
      concept: true,
    },
  });
  return row ? { ...row, typed: parseIdeaConcept(row.concept) } : null;
}

const GONE: Fail = {
  ok: false,
  code: "NOT_FOUND",
  message: "This idea is no longer here.",
};

export type IdeaStatusResult =
  { ok: true; status: IdeaStatus } | Fail | GuardFail;

// Save (put forward: plans pick it first) or unsave. A typed idea goes
// straight between VALIDATED and APPROVED, never through SHORTLISTED.
export async function saveIdeaAction(
  projectId: string,
  ideaId: string,
  saved: boolean,
): Promise<IdeaStatusResult> {
  return guardedAction("ideas-save", async (): Promise<IdeaStatusResult> => {
    const gate = await authorizeWorks(projectId, EDIT);
    if (!gate.ok) return gate;
    const idea = await findIdea(projectId, ideaId);
    if (!idea) return GONE;
    let status: IdeaStatus = idea.status;
    if (saved && status !== "APPROVED") {
      if (!isPoolStatus(status)) return GONE;
      if (idea.typed && status === "VALIDATED") {
        await IdeaRepository.transition(idea.id, projectId, "APPROVED");
      } else {
        if (
          (await IdeaRepository.promoteToShortlist(idea.id, projectId)) ===
          "SHORTLISTED"
        ) {
          await IdeaRepository.transition(idea.id, projectId, "APPROVED");
        }
      }
      status = "APPROVED";
    } else if (!saved && status === "APPROVED") {
      status = idea.typed ? "VALIDATED" : "SHORTLISTED";
      await IdeaRepository.transition(idea.id, projectId, status);
    }
    refreshWorkPages(projectId);
    return { ok: true, status };
  });
}

// "Not for us", with the reason the next ideas steer away from.
export async function dismissIdeaAction(
  projectId: string,
  ideaId: string,
  reason: DismissReason,
): Promise<IdeaStatusResult> {
  return guardedAction("ideas-dismiss", async (): Promise<IdeaStatusResult> => {
    const gate = await authorizeWorks(projectId, EDIT);
    if (!gate.ok) return gate;
    if (!(DISMISS_REASONS as readonly string[]).includes(reason)) {
      return { ok: false, code: "INVALID", message: IDEA_ACTION_COPY.invalid };
    }
    const idea = await findIdea(projectId, ideaId);
    if (!idea || !isPoolStatus(idea.status)) return GONE;
    await IdeaRepository.transition(idea.id, projectId, "REJECTED");
    if (idea.typed) {
      const concept: IdeaConcept = {
        ...idea.typed,
        feedback: { reason, at: new Date().toISOString() },
      };
      await prisma.idea.update({
        where: { id: idea.id },
        data: { concept: concept as never },
      });
    }
    refreshWorkPages(projectId);
    return { ok: true, status: "REJECTED" };
  });
}

export async function archiveIdeaBoardAction(
  projectId: string,
  ideaId: string,
): Promise<IdeaStatusResult> {
  return guardedAction("ideas-archive", async (): Promise<IdeaStatusResult> => {
    const gate = await authorizeWorks(projectId, EDIT);
    if (!gate.ok) return gate;
    const idea = await findIdea(projectId, ideaId);
    if (!idea) return GONE;
    if (idea.status !== "ARCHIVED") {
      await IdeaRepository.transition(idea.id, projectId, "ARCHIVED");
    }
    refreshWorkPages(projectId);
    return { ok: true, status: "ARCHIVED" };
  });
}

export type IdeaDraftPatch = {
  hook?: string;
  headline?: string;
  highlight?: string;
  visual?: string;
  caption?: string;
  layoutId?: string;
  // The brand's own photo the post is made from; [] = a picture is made for it.
  assetIds?: string[];
  channels?: string[];
};

export type IdeaUpdateResult = { ok: true; idea: BoardIdea } | Fail | GuardFail;

// The detail view's edits to a post idea, cleaned and bounded like the
// engine's own output.
export async function updateIdeaDraftAction(
  projectId: string,
  ideaId: string,
  patch: IdeaDraftPatch,
): Promise<IdeaUpdateResult> {
  return guardedAction("ideas-update", async (): Promise<IdeaUpdateResult> => {
    const gate = await authorizeWorks(projectId, EDIT);
    if (!gate.ok) return gate;
    const idea = await findIdea(projectId, ideaId);
    if (!idea || !isPoolStatus(idea.status)) return GONE;
    const typed = idea.typed;
    if (typed?.module !== "social" || !patch || typeof patch !== "object") {
      return { ok: false, code: "INVALID", message: IDEA_ACTION_COPY.invalid };
    }
    const draft = { ...typed.draft };
    const text = (value: unknown, max: number) =>
      value === undefined ? undefined : cleanWorksTextOrNull(value, max);
    const hook = text(patch.hook, 160);
    const headline = text(patch.headline, 80);
    const visual = text(patch.visual, 400);
    const caption = text(patch.caption, 900);
    if (
      hook === null ||
      headline === null ||
      visual === null ||
      caption === null
    ) {
      return { ok: false, code: "INVALID", message: IDEA_ACTION_COPY.invalid };
    }
    if (hook) draft.hook = hook;
    if (headline) draft.headline = clampHeadline(headline, HEADLINE_MAX_WORDS);
    if (visual) draft.visual = visual;
    if (caption) draft.caption = caption;
    if (patch.highlight !== undefined) {
      const highlight = cleanWorksTextOrNull(patch.highlight, 60);
      if (
        highlight &&
        draft.headline.toLowerCase().includes(highlight.toLowerCase())
      ) {
        draft.highlight = highlight;
      } else {
        delete draft.highlight;
      }
    } else if (
      draft.highlight &&
      !draft.headline.toLowerCase().includes(draft.highlight.toLowerCase())
    ) {
      delete draft.highlight;
    }
    if (patch.layoutId !== undefined) {
      const brand = await prisma.brand.findFirst({
        where: { projectId, isDefault: true },
        select: { id: true },
      });
      const style = brand ? await resolveBrandStyleContext(brand.id) : null;
      const ids =
        style?.visualIdentity?.layoutTemplates?.items.map((item) => item.id) ??
        [];
      if (patch.layoutId && ids.includes(patch.layoutId))
        draft.layoutId = patch.layoutId;
      else delete draft.layoutId;
    }
    if (Array.isArray(patch.assetIds)) {
      const wanted = patch.assetIds
        .filter((id): id is string => typeof id === "string" && validId(id))
        .slice(0, 1);
      // Only photos of this project: an id from anywhere else is dropped.
      const found =
        wanted.length > 0
          ? await prisma.asset.findMany({
              where: { id: { in: wanted }, projectId, type: "IMAGE" },
              select: { id: true },
            })
          : [];
      if (found.length > 0) draft.assetIds = found.map((asset) => asset.id);
      else delete draft.assetIds;
    }
    if (Array.isArray(patch.channels)) {
      const connections = await getChannelConnections(projectId).catch(
        () => ({}),
      );
      const channels = socialChannelsOf(
        patch.channels.filter(
          (value): value is string => typeof value === "string",
        ),
        ideaChannelsOf(channelOptions(connections)),
      );
      if (channels.length > 0) draft.channels = channels;
    }
    const parsed = IdeaConceptSchema.safeParse({ ...typed, draft });
    if (!parsed.success) {
      return { ok: false, code: "INVALID", message: IDEA_ACTION_COPY.invalid };
    }
    const concept = parsed.data;
    const row = await prisma.idea.update({
      where: { id: idea.id },
      data: {
        concept: concept as never,
        ...(concept.module === "social"
          ? { title: concept.draft.hook, description: concept.draft.caption }
          : {}),
        fingerprint: ideaFingerprint(concept),
      },
      select: {
        id: true,
        status: true,
        title: true,
        description: true,
        createdAt: true,
        updatedAt: true,
        concept: true,
        isMock: true,
      },
    });
    refreshWorkPages(projectId);
    return {
      ok: true,
      idea: toBoardIdea({ ...row, concept: parseIdeaConcept(row.concept) }),
    };
  });
}

// Two fresh takes on an idea: same goal, a new hook and scene.
export async function anotherAngleAction(
  projectId: string,
  ideaId: string,
): Promise<IdeasResult> {
  return guardedAction("ideas-angle", async (): Promise<IdeasResult> => {
    const gate = await authorizeWorks(projectId, GENERATE);
    if (!gate.ok) return gate;
    const idea = await findIdea(projectId, ideaId);
    if (!idea) return GONE;
    const about =
      idea.typed?.module === "social"
        ? `${idea.typed.draft.hook} (${idea.typed.draft.caption})`
        : `${idea.title}. ${idea.description}`;
    return created(
      projectId,
      await IdeaEngine.generate({
        projectId,
        count: 2,
        trigger: "angle",
        focus: `A different angle on this idea: the same goal, a new hook and a new scene. ${about}`,
        relatedIdeaId: idea.id,
      }),
    );
  });
}

// An older, untyped idea becomes a ready-to-make post idea; the old one is
// archived so the board does not show the same idea twice.
export async function turnIntoPostIdeaAction(
  projectId: string,
  ideaId: string,
): Promise<IdeasResult> {
  return guardedAction("ideas-convert", async (): Promise<IdeasResult> => {
    const gate = await authorizeWorks(projectId, GENERATE);
    if (!gate.ok) return gate;
    const idea = await findIdea(projectId, ideaId);
    if (!idea || idea.typed || !isPoolStatus(idea.status)) return GONE;
    const result = await IdeaEngine.generate({
      projectId,
      count: 1,
      trigger: "manual",
      focus: `Turn this idea into one post: ${idea.title}. ${idea.description}`,
    });
    if (result.ok && result.created.length > 0) {
      await IdeaRepository.transition(idea.id, projectId, "ARCHIVED").catch(
        () => undefined,
      );
    }
    return created(projectId, result);
  });
}

export type MakePostResult = { ok: true; workId: string } | Fail | GuardFail;

// "Make this post": a Social chat with the idea's post ready to make.
export async function makeIdeaPostAction(
  projectId: string,
  ideaId: string,
): Promise<MakePostResult> {
  return guardedAction("ideas-make", async (): Promise<MakePostResult> => {
    const gate = await authorizeWorks(projectId, MAKE);
    if (!gate.ok) return gate;
    if (!validId(ideaId)) return GONE;
    const result = await makeIdeaPost({
      projectId,
      ideaId,
      userId: gate.auth.userId,
      workspaceId: gate.auth.workspaceId,
    });
    if (!result.ok) return result;
    // The post is on the calendar now.
    refreshWorkPages(projectId, [`/projects/${projectId}/takvim`]);
    return { ok: true, workId: result.workId };
  });
}
