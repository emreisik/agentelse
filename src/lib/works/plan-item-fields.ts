import type { CreativeType, SocialPlatform } from "@prisma/client";

import { CHANNELS, resolvePlanItem } from "@/lib/content-channels";

// The one plan-item to Creative-fields mapping, shared by save, swap and move
// so they never diverge (extracted from saveContentPlanAction).

export type PlanItemLike = {
  date: string;
  time: string;
  platform?: string;
  format?: string;
  channel?: string;
  formatKey?: string;
  topic: string;
  captionIdea: string;
};

export function creativeFieldsOfPlanItem(item: PlanItemLike): {
  type: CreativeType;
  platform: SocialPlatform | undefined;
  channel: string | undefined;
  formatKey: string | undefined;
  title: string;
  brief: string;
} {
  const resolved = resolvePlanItem(item);
  // Catalog channels carry their own type/platform; a platform the catalog
  // does not know (Facebook, YouTube...) keeps the old shape, with its
  // free-text format folded into the brief.
  const platform = resolved
    ? CHANNELS[resolved.channel].platform
    : (item.platform as SocialPlatform | undefined);
  const brief =
    !resolved && item.format
      ? `[${item.format}] ${item.captionIdea}`
      : item.captionIdea;
  return {
    type: resolved?.format.creativeType ?? "SOCIAL_POST",
    platform,
    channel: resolved?.channel,
    formatKey: resolved?.format.key,
    title: item.topic,
    brief,
  };
}
