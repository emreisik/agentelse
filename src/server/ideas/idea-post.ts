import "server-only";

import { randomUUID } from "node:crypto";

import { prisma } from "@/lib/prisma";
import {
  CHANNELS,
  defaultFormat,
  resolveFormat,
  type ChannelKey,
} from "@/lib/content-channels";
import { addDaysToKey } from "@/lib/content-plan-view";
import {
  captionIdeaOf,
  parseIdeaConcept,
  socialChannelsOf,
  type SocialIdeaConcept,
} from "@/lib/ideas/concept";
import { IDEA_POST_COPY } from "@/lib/ideas/copy";
import { formatKeyFor } from "@/lib/ideas/normalize";
import { utcToZonedDateTimeLocal } from "@/lib/timezone";
import {
  blocksOf,
  brandCheckOf,
  checkItems,
  flagsForItem,
} from "@/lib/works/brand-rules";
import { cleanWorksTextOrNull } from "@/lib/works/clean-text";
import { slotWhenLabel } from "@/lib/works/slot-rules";
import { channelOptions } from "@/lib/works/work";
import { brandRuleLanguageOf } from "@/server/brand/rule-language";
import { getProjectTimezone } from "@/server/chat/content-plan";
import { markIdeasPlanned } from "@/server/chat/idea-pool";
import { createSlots, type SlotTarget } from "@/server/chat/schedule-slots";
import { ideaChannelsOf } from "@/server/ideas/idea-context";
import { getChannelConnections } from "@/server/integrations/channel-connections";
import { loadBrandRules } from "@/server/works/brand-rule-loader";
import { loadSuggestedSlots } from "@/server/works/free-slot-loader";
import { isModulesEnabled } from "@/server/works/flag";

// "Make this post" on the Ideas board (docs/ideas.md): the idea goes onto the
// calendar as one post, at the next good slot of its first channel, on every
// channel it names, in a Social chat of its own, with no model turn (the idea
// already holds the hook, the words on the picture, the scene and the
// caption). It is the same write as "Add to calendar" on an idea in the chat
// (schedule-slots.ts createSlots), so the chat opens on the card of a planned
// post: Make post (the only place an AI picture is made, with its cost shown),
// Change time, Remove. An idea already on the calendar opens the chat that
// holds it instead of a second post.

export const IDEA_MADE_POST_ACTION = "idea.made_post";

const DEFAULT_TIME = "10:00";
const TITLE_MAX = 80;
const CARD_TITLE_MAX = 60;
const RAW_TEXT_MAX = 80;
const DEAD_IDEA = new Set(["REJECTED", "ARCHIVED"]);

export type MakeIdeaPostResult =
  | { ok: true; workId: string; reused: boolean }
  | {
      ok: false;
      code: "NOT_FOUND" | "INVALID" | "BRAND_RULES" | "BUSY" | "FAILED";
      message: string;
    };

// The format of the post on a channel: the draft's own when it belongs to
// that channel, else that channel's plain post.
export function postFormatOf(
  concept: SocialIdeaConcept,
  channel: ChannelKey,
): string {
  const own = concept.draft.formatKey;
  if (own && CHANNELS[channel].formats.some((format) => format.key === own)) {
    return own;
  }
  return formatKeyFor(undefined, [channel]) ?? defaultFormat(channel).key;
}

// "Instagram Post and Facebook Post": channel and format labels only.
function whereOf(targets: readonly SlotTarget[]): string {
  return targets
    .map((target) => {
      const channel = target.channel as ChannelKey;
      const format = resolveFormat(channel, target.formatKey);
      return `${CHANNELS[channel].label} ${format?.label ?? "Post"}`;
    })
    .join(" and ");
}

export async function makeIdeaPost(input: {
  projectId: string;
  ideaId: string;
  userId: string;
  workspaceId: string;
  now?: Date;
}): Promise<MakeIdeaPostResult> {
  const now = input.now ?? new Date();
  const idea = await prisma.idea.findFirst({
    where: { id: input.ideaId, projectId: input.projectId },
    select: { id: true, status: true, concept: true, brandId: true },
  });
  if (!idea || DEAD_IDEA.has(idea.status)) {
    return { ok: false, code: "NOT_FOUND", message: IDEA_POST_COPY.gone };
  }
  const concept = parseIdeaConcept(idea.concept);
  if (concept?.module !== "social") {
    return { ok: false, code: "INVALID", message: IDEA_POST_COPY.notPost };
  }

  const [timezone, connections] = await Promise.all([
    getProjectTimezone(input.projectId),
    getChannelConnections(input.projectId).catch(() => ({})),
  ]);
  const allowed = ideaChannelsOf(channelOptions(connections));
  const named = socialChannelsOf(concept.draft.channels, allowed);
  const first: ChannelKey = named[0] ?? allowed[0] ?? "instagram";
  const channels = named.length > 0 ? named : [first];

  const suggested = await loadSuggestedSlots(input.projectId, {
    channel: first,
    count: 1,
  }).catch(() => ({ slots: [] as { date: string; time: string }[] }));
  const today = utcToZonedDateTimeLocal(now, timezone).slice(0, 10);
  const slot = suggested.slots[0] ?? {
    date: addDaysToKey(today, 1),
    time: DEFAULT_TIME,
  };

  // The idea's own words, as the post will carry them.
  const topic = concept.draft.hook;
  const captionIdea = captionIdeaOf(concept.draft);
  const rules = await loadBrandRules({
    projectId: input.projectId,
    brandId: idea.brandId,
    language: await brandRuleLanguageOf(input.projectId),
  });
  const hits = checkItems(
    channels.map(() => ({ topic, captionIdea })),
    rules,
  );
  if (blocksOf(hits).length > 0) {
    return { ok: false, code: "BRAND_RULES", message: IDEA_POST_COPY.blocked };
  }

  const origin = { kind: "idea" as const, ref: idea.id };
  const targets: SlotTarget[] = channels.map((channel, index) => {
    const flags = flagsForItem(hits, index);
    return {
      channel,
      formatKey: postFormatOf(concept, channel),
      date: slot.date,
      time: slot.time,
      topic,
      captionIdea,
      origin,
      ideaId: idea.id,
      ...(flags.length > 0 ? { brandFlags: flags } : {}),
    };
  });
  const labels = [...new Set(channels.map((key) => CHANNELS[key].label))];

  const workId = `ideapost_${randomUUID()}`;
  const created = await createSlots({
    scope: {
      workspaceId: input.workspaceId,
      projectId: input.projectId,
      brandId: idea.brandId,
      userId: input.userId,
    },
    workId,
    newWork: {
      title: topic.slice(0, TITLE_MAX),
      module: isModulesEnabled() ? "social" : null,
      channels,
      createdByUserId: input.userId,
      now,
    },
    timezone,
    via: "idea",
    cardTitle:
      cleanWorksTextOrNull(topic, CARD_TITLE_MAX) ?? IDEA_POST_COPY.planTitle,
    rawText: IDEA_POST_COPY.clickRow(labels.join(" and ")).slice(
      0,
      RAW_TEXT_MAX,
    ),
    replyText: IDEA_POST_COPY.added(
      slotWhenLabel(slot.date, slot.time),
      whereOf(targets),
    ),
    targets,
    brandCheck: brandCheckOf(rules),
  });
  if (!created.ok) {
    return { ok: false, code: created.code, message: created.message };
  }

  // Already on the calendar: the chat that holds that post.
  let openWorkId = workId;
  if (created.alreadyScheduled) {
    const row = await prisma.command.findFirst({
      where: { id: created.commandId, projectId: input.projectId },
      select: { workId: true },
    });
    if (!row?.workId) {
      return { ok: false, code: "INVALID", message: IDEA_POST_COPY.noChat };
    }
    openWorkId = row.workId;
  }

  // The idea leaves the pool ("Planned"); also on a second press, so an
  // earlier failed move heals. Best effort, as after a saved plan.
  await markIdeasPlanned(input.projectId, [idea.id]);
  if (!created.alreadyScheduled) {
    await prisma.auditLog
      .create({
        data: {
          workspaceId: input.workspaceId,
          projectId: input.projectId,
          brandId: idea.brandId,
          actorType: "USER",
          actorId: input.userId,
          action: IDEA_MADE_POST_ACTION,
          entityType: "Idea",
          entityId: idea.id,
          metadata: { workId, commandId: created.commandId },
        },
      })
      .catch((error: unknown) => {
        console.error(
          "[ideas] made-post audit failed:",
          error instanceof Error ? error.message : error,
        );
      });
  }
  return {
    ok: true,
    workId: openWorkId,
    reused: created.alreadyScheduled,
  };
}
