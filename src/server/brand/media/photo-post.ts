import "server-only";

import { randomUUID } from "node:crypto";

import { prisma } from "@/lib/prisma";
import { defaultFormat } from "@/lib/content-channels";
import type { ChannelKey } from "@/lib/content-channels";
import { addDaysToKey } from "@/lib/content-plan-view";
import { formatKeyFor } from "@/lib/ideas/normalize";
import { utcToZonedDateTimeLocal } from "@/lib/timezone";
import { blocksOf, brandCheckOf, checkItems } from "@/lib/works/brand-rules";
import { cleanWorksTextOrNull } from "@/lib/works/clean-text";
import { slotWhenLabel } from "@/lib/works/slot-rules";
import { channelOptions } from "@/lib/works/work";
import { brandRuleLanguageOf } from "@/server/brand/rule-language";
import { getProjectTimezone } from "@/server/chat/content-plan";
import { createSlots } from "@/server/chat/schedule-slots";
import { ideaChannelsOf } from "@/server/ideas/idea-context";
import { getChannelConnections } from "@/server/integrations/channel-connections";
import { loadBrandRules } from "@/server/works/brand-rule-loader";
import { loadSuggestedSlots } from "@/server/works/free-slot-loader";
import { isModulesEnabled } from "@/server/works/flag";

// "Make a post from this photo" on the Media tab (docs/brand-media.md): the
// photo goes onto the calendar as one post, at the next good slot of the
// brand's first channel, in a Social chat of its own, with no model turn. It is
// the same write as "Make this post" on an idea (ideas/idea-post.ts), with the
// photo on the post: the piece that renders its picture cuts it from the photo
// instead of asking an image model (openai-creative.provider.ts).

export const PHOTO_POST_ACTION = "media.made_post";

export const PHOTO_POST_COPY = {
  planTitle: "Post from your photo",
  clickRow: (channel: string) => `Make a post from my photo on ${channel}`,
  added: (when: string, where: string) =>
    `Added a post from one of your photos to your calendar for ${when} on ${where}. It is planned and has no content yet.`,
  gone: "This photo is no longer here.",
  notReady: "This photo is still being looked at. Try again in a moment.",
  blocked:
    "A brand rule stops this photo's description. Edit its tags, then try again.",
  noChannel: "Connect a channel first, then make a post from this photo.",
} as const;

const DEFAULT_TIME = "10:00";
const TITLE_MAX = 80;
const CARD_TITLE_MAX = 60;
const RAW_TEXT_MAX = 80;

export type MakePhotoPostResult =
  | { ok: true; workId: string; reused: boolean }
  | {
      ok: false;
      code: "NOT_FOUND" | "INVALID" | "BRAND_RULES" | "BUSY" | "FAILED";
      message: string;
    };

// The post's working title and idea, from what the photo shows.
export function photoTopicOf(media: {
  description: string | null;
  tags: readonly string[];
}): { topic: string; captionIdea: string } {
  const description = (media.description ?? "").trim();
  const sentence = description.split(/(?<=[.!?])\s/)[0] ?? "";
  const topic =
    cleanWorksTextOrNull(sentence, TITLE_MAX) ??
    cleanWorksTextOrNull(media.tags.slice(0, 4).join(", "), TITLE_MAX) ??
    PHOTO_POST_COPY.planTitle;
  return { topic, captionIdea: description || topic };
}

export async function makePhotoPost(input: {
  projectId: string;
  assetId: string;
  userId: string;
  workspaceId: string;
  now?: Date;
}): Promise<MakePhotoPostResult> {
  const now = input.now ?? new Date();
  const media = await prisma.brandMedia.findFirst({
    where: {
      assetId: input.assetId,
      projectId: input.projectId,
      kind: "IMAGE",
      archivedAt: null,
    },
    select: {
      brandId: true,
      status: true,
      description: true,
      tags: true,
    },
  });
  if (!media) {
    return { ok: false, code: "NOT_FOUND", message: PHOTO_POST_COPY.gone };
  }
  // Fine without a description (a photo that could not be analysed still makes
  // a post), but not while its first look is still under way.
  if (media.status === "PENDING") {
    return { ok: false, code: "BUSY", message: PHOTO_POST_COPY.notReady };
  }

  const [timezone, connections] = await Promise.all([
    getProjectTimezone(input.projectId),
    getChannelConnections(input.projectId).catch(() => ({})),
  ]);
  const allowed = ideaChannelsOf(channelOptions(connections));
  const channel: ChannelKey | undefined = allowed[0];
  if (!channel) {
    return { ok: false, code: "INVALID", message: PHOTO_POST_COPY.noChannel };
  }

  const suggested = await loadSuggestedSlots(input.projectId, {
    channel,
    count: 1,
  }).catch(() => ({ slots: [] as { date: string; time: string }[] }));
  const today = utcToZonedDateTimeLocal(now, timezone).slice(0, 10);
  const slot = suggested.slots[0] ?? {
    date: addDaysToKey(today, 1),
    time: DEFAULT_TIME,
  };

  const { topic, captionIdea } = photoTopicOf(media);
  const rules = await loadBrandRules({
    projectId: input.projectId,
    brandId: media.brandId,
    language: await brandRuleLanguageOf(input.projectId),
  });
  const hits = checkItems([{ topic, captionIdea }], rules);
  if (blocksOf(hits).length > 0) {
    return { ok: false, code: "BRAND_RULES", message: PHOTO_POST_COPY.blocked };
  }

  const formatKey =
    formatKeyFor(undefined, [channel]) ?? defaultFormat(channel).key;
  // One press a day per photo: a double click opens the post it made.
  const origin = {
    kind: "brief" as const,
    ref: `photo:${input.assetId}:${today}`,
  };
  const workId = `photopost_${randomUUID()}`;
  const created = await createSlots({
    scope: {
      workspaceId: input.workspaceId,
      projectId: input.projectId,
      brandId: media.brandId,
      userId: input.userId,
    },
    workId,
    newWork: {
      title: topic.slice(0, TITLE_MAX),
      module: isModulesEnabled() ? "social" : null,
      channels: [channel],
      createdByUserId: input.userId,
      now,
    },
    timezone,
    via: "brief",
    cardTitle:
      cleanWorksTextOrNull(topic, CARD_TITLE_MAX) ?? PHOTO_POST_COPY.planTitle,
    rawText: PHOTO_POST_COPY.clickRow(channel).slice(0, RAW_TEXT_MAX),
    replyText: PHOTO_POST_COPY.added(
      slotWhenLabel(slot.date, slot.time),
      channel,
    ),
    targets: [
      {
        channel,
        formatKey,
        date: slot.date,
        time: slot.time,
        topic,
        captionIdea,
        origin,
        photoAssetIds: [input.assetId],
      },
    ],
    brandCheck: brandCheckOf(rules),
  });
  if (!created.ok) {
    return { ok: false, code: created.code, message: created.message };
  }

  let openWorkId = workId;
  if (created.alreadyScheduled) {
    const row = await prisma.command.findFirst({
      where: { id: created.commandId, projectId: input.projectId },
      select: { workId: true },
    });
    if (!row?.workId) {
      return { ok: false, code: "INVALID", message: PHOTO_POST_COPY.gone };
    }
    openWorkId = row.workId;
  } else {
    await prisma.auditLog
      .create({
        data: {
          workspaceId: input.workspaceId,
          projectId: input.projectId,
          brandId: media.brandId,
          actorType: "USER",
          actorId: input.userId,
          action: PHOTO_POST_ACTION,
          entityType: "Asset",
          entityId: input.assetId,
          metadata: { workId, commandId: created.commandId },
        },
      })
      .catch((error: unknown) => {
        console.error(
          "[brand-media] made-post audit failed:",
          error instanceof Error ? error.message : error,
        );
      });
  }
  return { ok: true, workId: openWorkId, reused: created.alreadyScheduled };
}
