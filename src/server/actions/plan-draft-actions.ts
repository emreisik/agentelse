"use server";

import { ALL_FORMAT_KEYS } from "@/lib/content-channels";
import { prisma } from "@/lib/prisma";
import {
  DATE_SHAPE,
  TIME_SHAPE,
  nextSkipFormats,
  orderedPlatforms,
  withSkipFormats,
} from "@/lib/works/plan-platforms";
import { updateCommandCard } from "@/server/chat/card-store";
import { todayInTimezone, validatePlanDates } from "@/server/chat/content-plan";
import { isAgentelseError } from "@/server/security/errors";
import { isWorksEnabled } from "@/server/works/flag";
import {
  GUARD_MESSAGE,
  authorizeWorks,
  guardedAction,
  idSchema,
  refreshWorkPages,
} from "@/server/works/guard";
import type { IdeaEventCardData } from "@/types/idea-event-card";

// Server Actions of the social media plan card while it is still a DRAFT
// (docs/works.md): choose the platforms it goes to, move a post to another day
// or time, drop a post, leave one of a post's channels out. DB only, no model
// call. Every write goes through the
// atomic card writer with requireActiveWork, so a direct POST cannot change a
// completed Work or a saved plan. The client does not refresh after success: the
// action's revalidation carries the new page.

type PlanDraft = Extract<IdeaEventCardData, { kind: "content-plan-draft" }>;

export type PlanDraftResult =
  | { ok: true }
  | {
      ok: false;
      code:
        | "DISABLED"
        | "RATE"
        | "NOT_FOUND"
        | "STALE"
        | "LOCKED"
        | "RANGE"
        | "WORK"
        | "FAILED";
      message: string;
    };

const BUCKET = { bucket: "plan-draft", limit: 120 } as const;

const MESSAGE = {
  notFound: "Plan not found.",
  stale: "This plan changed. Reload it and try again.",
  locked: "This plan is already saved. Change its posts on the calendar.",
  range: "That isn't possible for this plan.",
  lastPost: "A plan needs at least one post.",
  lastChannel: "A post keeps at least one channel.",
  day: "Pick a day from today on.",
} as const;

type Refusal = {
  code: "STALE" | "LOCKED" | "RANGE";
  message: string;
};

const fail = (code: Refusal["code"], message: string): Refusal => ({
  code,
  message,
});

// Edits the stored draft atomically; `apply` returns the new card or a refusal.
async function editDraft(
  commandId: unknown,
  label: string,
  apply: (plan: PlanDraft) => { card: PlanDraft } | Refusal,
): Promise<PlanDraftResult> {
  const result = await guardedAction(
    label,
    async (): Promise<PlanDraftResult> => {
      if (!isWorksEnabled()) {
        return { ok: false, code: "DISABLED", message: GUARD_MESSAGE.disabled };
      }
      const id = idSchema.safeParse(commandId);
      if (!id.success) {
        return { ok: false, code: "NOT_FOUND", message: MESSAGE.notFound };
      }
      const row = await prisma.command.findUnique({
        where: { id: id.data },
        select: { projectId: true },
      });
      if (!row?.projectId) {
        return { ok: false, code: "NOT_FOUND", message: MESSAGE.notFound };
      }
      const projectId = row.projectId;
      let gate: Awaited<ReturnType<typeof authorizeWorks>>;
      try {
        gate = await authorizeWorks(projectId, BUCKET);
      } catch (error) {
        // Access refusals are not told apart from a missing card.
        if (isAgentelseError(error)) {
          return { ok: false, code: "NOT_FOUND", message: MESSAGE.notFound };
        }
        throw error;
      }
      if (!gate.ok) {
        return {
          ok: false,
          code: gate.code === "INVALID" ? "FAILED" : gate.code,
          message: gate.message,
        };
      }

      let refusal = null as Refusal | null;
      const updated = await updateCommandCard({
        commandId: id.data,
        projectId,
        expectKinds: ["content-plan-draft"],
        requireActiveWork: true,
        update: (card) => {
          const plan = card as PlanDraft;
          if (plan.state !== "draft") {
            refusal = fail("LOCKED", MESSAGE.locked);
            return { reject: MESSAGE.locked };
          }
          const applied = apply(plan);
          if ("code" in applied) {
            refusal = applied;
            return { reject: applied.message };
          }
          return applied.card;
        },
      });
      if (!updated.ok) {
        const refused = refusal as Refusal | null;
        if (updated.code === "REJECTED" && refused)
          return { ok: false, ...refused };
        return {
          ok: false,
          code:
            updated.code === "NOT_FOUND" || updated.code === "WRONG_KIND"
              ? "NOT_FOUND"
              : updated.code === "WORK_INACTIVE"
                ? "WORK"
                : "FAILED",
          message: updated.message,
        };
      }
      refreshWorkPages(projectId);
      return { ok: true };
    },
  );
  return result.ok
    ? result
    : {
        ok: false,
        code: result.code === "INVALID" ? "FAILED" : result.code,
        message: result.message,
      };
}

function isIndices(value: unknown): value is number[] {
  return (
    Array.isArray(value) &&
    value.length >= 1 &&
    value.length <= 8 &&
    value.every((entry) => Number.isInteger(entry) && entry >= 0) &&
    new Set(value).size === value.length
  );
}

// The post is still the one the screen showed.
function sameTopic(plan: PlanDraft, indices: number[], topic: string): boolean {
  return indices.every((index) => {
    const item = plan.items[index];
    return !!item && !item.removed && item.topic === topic;
  });
}

// The platforms the plan goes to (at least one).
export async function setPlanPlatformsAction(
  commandId: string,
  platforms: string[],
): Promise<PlanDraftResult> {
  return editDraft(commandId, "plan-platforms", (plan) => {
    if (!Array.isArray(platforms) || platforms.length > 8) {
      return fail("RANGE", MESSAGE.range);
    }
    const chosen = orderedPlatforms(platforms);
    if (chosen.length === 0) return fail("RANGE", MESSAGE.range);
    return { card: { ...plan, platforms: chosen } };
  });
}

// "Also as a Story": each Instagram post also goes out as a Story.
export async function setPlanInstagramStoryAction(
  commandId: string,
  on: boolean,
): Promise<PlanDraftResult> {
  return editDraft(commandId, "plan-instagram-story", (plan) => {
    if (typeof on !== "boolean") return fail("RANGE", MESSAGE.range);
    return { card: { ...plan, instagramStory: on } };
  });
}

// One post (its position in the items, and its idea to be sure it is the same
// one) to another day and time.
export async function movePlanPostAction(
  commandId: string,
  indices: number[],
  expectTopic: string,
  date: string,
  time: string,
): Promise<PlanDraftResult> {
  return editDraft(commandId, "plan-move", (plan) => {
    if (
      !isIndices(indices) ||
      typeof expectTopic !== "string" ||
      typeof date !== "string" ||
      typeof time !== "string" ||
      !DATE_SHAPE.test(date) ||
      !TIME_SHAPE.test(time)
    ) {
      return fail("RANGE", MESSAGE.range);
    }
    if (validatePlanDates([{ date }], todayInTimezone(plan.timezone))) {
      return fail("RANGE", MESSAGE.day);
    }
    if (!sameTopic(plan, indices, expectTopic)) {
      return fail("STALE", MESSAGE.stale);
    }
    const moving = new Set(indices);
    // Calendar order, as a plan is always drawn.
    const items = plan.items
      .map((item, at) => ({
        item: moving.has(at) ? { ...item, date, time } : item,
        at,
      }))
      .sort(
        (a, b) =>
          `${a.item.date}T${a.item.time}`.localeCompare(
            `${b.item.date}T${b.item.time}`,
          ) || a.at - b.at,
      )
      .map((entry) => entry.item);
    return { card: { ...plan, items } };
  });
}

// One post out of the plan.
export async function removePlanPostAction(
  commandId: string,
  indices: number[],
  expectTopic: string,
): Promise<PlanDraftResult> {
  return editDraft(commandId, "plan-remove", (plan) => {
    if (!isIndices(indices) || typeof expectTopic !== "string") {
      return fail("RANGE", MESSAGE.range);
    }
    if (!sameTopic(plan, indices, expectTopic)) {
      return fail("STALE", MESSAGE.stale);
    }
    const dropping = new Set(indices);
    const items = plan.items.filter((_, at) => !dropping.has(at));
    if (items.filter((item) => !item.removed).length === 0) {
      return fail("RANGE", MESSAGE.lastPost);
    }
    return { card: { ...plan, items } };
  });
}

// One channel of a post left out (`skip`) or taken back in (docs/works.md
// "Posts"), by its format key ("instagram.story", "facebook.post"): every item
// of the post carries the list, and saving never makes those deliveries. The
// post is named by its items and its idea; it keeps at least one channel.
export async function setPlanPostSkipAction(
  commandId: string,
  indices: number[],
  expectTopic: string,
  formatKey: string,
  skip: boolean,
): Promise<PlanDraftResult> {
  return editDraft(commandId, "plan-post-skip", (plan) => {
    if (
      !isIndices(indices) ||
      typeof expectTopic !== "string" ||
      typeof formatKey !== "string" ||
      !ALL_FORMAT_KEYS.includes(formatKey) ||
      typeof skip !== "boolean"
    ) {
      return fail("RANGE", MESSAGE.range);
    }
    if (!sameTopic(plan, indices, expectTopic)) {
      return fail("STALE", MESSAGE.stale);
    }
    const next = nextSkipFormats(
      indices.map((index) => plan.items[index]!),
      plan,
      formatKey,
      skip,
    );
    if (!next.ok) {
      return fail(
        "RANGE",
        next.reason === "LAST" ? MESSAGE.lastChannel : MESSAGE.range,
      );
    }
    const post = new Set(indices);
    const items = plan.items.map((item, at) =>
      post.has(at) ? withSkipFormats(item, next.skipFormats) : item,
    );
    return { card: { ...plan, items } };
  });
}
