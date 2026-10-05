import type {
  CreativeContentFormat,
  CreativeType,
  SocialPlatform,
} from "@prisma/client";

import type { DeliverableKey } from "@/server/chat/deliverables";

// The one catalog of WHERE content can go and IN WHAT SHAPE. The plan wizard,
// the plan card, the agent's propose_content_plan validation and the calendar
// all read it, so a channel/format can never mean different things in
// different places. Isomorphic on purpose (no "server-only"): the client cards
// import it too. Labels live here in one place so they can be translated later.

export const CHANNEL_KEYS = [
  "instagram",
  "facebook",
  "tiktok",
  "linkedin",
  "x",
  "seo",
  "ads",
] as const;
export type ChannelKey = (typeof CHANNEL_KEYS)[number];

export type ChannelGroup = "social" | "seo" | "ads";

// How a piece of this format leaves the agency once it is ready:
//  auto     — published through the connected account's API
//  manual   — the client posts/uploads it themselves (no API path, or no CMS)
//  approval — spends money or changes a live account: always needs a decision
export type PublishMode = "auto" | "manual" | "approval";

// Small icon vocabulary the card maps to real icons (kept as a string union
// so this file stays free of React).
export type FormatGlyph =
  | "image"
  | "carousel"
  | "reel"
  | "story"
  | "video"
  | "text"
  | "thread"
  | "article"
  | "campaign";

export type ChannelFormat = {
  // Globally unique: "<channel>.<format>", e.g. "instagram.carousel".
  key: string;
  label: string;
  glyph: FormatGlyph;
  creativeType: CreativeType;
  // Pixel target for image formats (see creative-platform-format.ts).
  contentFormat?: CreativeContentFormat;
  // The agency deliverable that produces it, when one exists today.
  deliverable?: DeliverableKey;
  publish: PublishMode;
};

export type ChannelDef = {
  key: ChannelKey;
  label: string;
  // Two/three letter mark for the coloured badge (lucide has no brand icons).
  short: string;
  // Badge colour (hex): the same colour identifies the channel everywhere.
  color: string;
  group: ChannelGroup;
  // The SocialPlatform a creative of this channel is stored under.
  platform?: SocialPlatform;
  formats: readonly ChannelFormat[];
};

export const CHANNELS: Record<ChannelKey, ChannelDef> = {
  instagram: {
    key: "instagram",
    label: "Instagram",
    short: "IG",
    color: "#d6249f",
    group: "social",
    platform: "INSTAGRAM",
    formats: [
      {
        key: "instagram.post",
        label: "Post",
        glyph: "image",
        creativeType: "SOCIAL_POST",
        contentFormat: "FEED_PORTRAIT",
        deliverable: "instagram_post",
        publish: "auto",
      },
      {
        key: "instagram.carousel",
        label: "Carousel",
        glyph: "carousel",
        creativeType: "SOCIAL_POST",
        contentFormat: "FEED_PORTRAIT",
        deliverable: "instagram_post",
        publish: "manual",
      },
      {
        key: "instagram.reel",
        label: "Reel",
        glyph: "reel",
        creativeType: "SOCIAL_POST",
        contentFormat: "REEL",
        deliverable: "reel_idea",
        publish: "manual",
      },
      {
        key: "instagram.story",
        label: "Story",
        glyph: "story",
        creativeType: "SOCIAL_POST",
        contentFormat: "STORY",
        deliverable: "instagram_post",
        publish: "auto",
      },
    ],
  },
  facebook: {
    key: "facebook",
    label: "Facebook",
    short: "FB",
    color: "#0866ff",
    group: "social",
    platform: "FACEBOOK",
    formats: [
      {
        key: "facebook.post",
        label: "Post",
        glyph: "image",
        creativeType: "SOCIAL_POST",
        contentFormat: "FEED_PORTRAIT",
        // Made like an Instagram post (one picture + caption), sized for the feed.
        deliverable: "instagram_post",
        // Goes to the connected Page with one tap on the piece's card.
        publish: "auto",
      },
    ],
  },
  tiktok: {
    key: "tiktok",
    label: "TikTok",
    short: "TT",
    color: "#111827",
    group: "social",
    platform: "TIKTOK",
    formats: [
      {
        key: "tiktok.video",
        label: "Video",
        glyph: "video",
        creativeType: "SOCIAL_POST",
        contentFormat: "REEL",
        deliverable: "reel_idea",
        publish: "manual",
      },
    ],
  },
  linkedin: {
    key: "linkedin",
    label: "LinkedIn",
    short: "in",
    color: "#0a66c2",
    group: "social",
    platform: "LINKEDIN",
    formats: [
      {
        key: "linkedin.post",
        label: "Post",
        glyph: "text",
        creativeType: "SOCIAL_POST",
        publish: "auto",
      },
    ],
  },
  x: {
    key: "x",
    label: "X",
    short: "X",
    color: "#374151",
    group: "social",
    platform: "X",
    formats: [
      {
        key: "x.post",
        label: "Post",
        glyph: "text",
        creativeType: "SOCIAL_POST",
        publish: "auto",
      },
      {
        key: "x.thread",
        label: "Thread",
        glyph: "thread",
        creativeType: "SOCIAL_POST",
        publish: "manual",
      },
    ],
  },
  seo: {
    key: "seo",
    label: "Blog / SEO",
    short: "SEO",
    color: "#059669",
    group: "seo",
    formats: [
      {
        key: "seo.article",
        label: "Article",
        glyph: "article",
        creativeType: "COPY",
        deliverable: "seo_article",
        // There is no CMS integration yet, so the client publishes the draft.
        publish: "manual",
      },
    ],
  },
  ads: {
    key: "ads",
    label: "Ads",
    short: "Ads",
    color: "#d97706",
    group: "ads",
    formats: [
      {
        key: "ads.campaign",
        label: "Campaign brief",
        glyph: "campaign",
        creativeType: "CAMPAIGN_BRIEF",
        deliverable: "ad_copy",
        // Real money: never goes live without an explicit approval.
        publish: "approval",
      },
    ],
  },
};

// Whether a channel can actually be published to right now. Absent from the
// map = nothing to connect (Blog/SEO is always a manual hand-off).
export type ChannelConnection = { connected: boolean; accountLabel?: string };
export type ChannelConnections = Partial<Record<ChannelKey, ChannelConnection>>;

export const PLAN_GOALS = [
  "awareness",
  "leads",
  "sales",
  "engagement",
  "traffic",
] as const;
export type PlanGoal = (typeof PLAN_GOALS)[number];

export const PLAN_GOAL_LABEL: Record<
  PlanGoal,
  { label: string; hint: string }
> = {
  awareness: {
    label: "Awareness",
    hint: "Be seen by more of the right people",
  },
  leads: { label: "Leads & bookings", hint: "Turn attention into enquiries" },
  sales: { label: "Sales", hint: "Drive purchases of a product or service" },
  engagement: { label: "Engagement", hint: "Build community and interaction" },
  traffic: { label: "Traffic & SEO", hint: "Bring visitors to the website" },
};

export const ALL_FORMAT_KEYS: readonly string[] = CHANNEL_KEYS.flatMap((key) =>
  CHANNELS[key].formats.map((format) => format.key),
);

export function isChannelKey(value: unknown): value is ChannelKey {
  return (
    typeof value === "string" &&
    (CHANNEL_KEYS as readonly string[]).includes(value)
  );
}

export function isPlanGoal(value: unknown): value is PlanGoal {
  return (
    typeof value === "string" &&
    (PLAN_GOALS as readonly string[]).includes(value)
  );
}

// The channel a format key belongs to ("instagram.reel" -> "instagram").
export function channelOfFormatKey(formatKey: string): ChannelKey | undefined {
  const channel = formatKey.split(".")[0];
  return isChannelKey(channel) ? channel : undefined;
}

export function resolveFormat(
  channel: ChannelKey,
  formatKey: string,
): ChannelFormat | undefined {
  return CHANNELS[channel].formats.find((format) => format.key === formatKey);
}

export function defaultFormat(channel: ChannelKey): ChannelFormat {
  return CHANNELS[channel].formats[0]!;
}

const PLATFORM_TO_CHANNEL: Partial<Record<SocialPlatform, ChannelKey>> = {
  INSTAGRAM: "instagram",
  FACEBOOK: "facebook",
  TIKTOK: "tiktok",
  LINKEDIN: "linkedin",
  X: "x",
};

// Plans saved before channels existed only have a platform and a free-text
// format ("Carousel", "Reel", "Static post"). Map them onto the catalog so
// old cards keep rendering; a platform the catalog does not cover (YouTube,
// Pinterest) yields undefined and the card falls back to the raw
// platform name.
export function legacyToFormat(
  platform: string,
  freeTextFormat?: string,
): { channel: ChannelKey; format: ChannelFormat } | undefined {
  const channel = PLATFORM_TO_CHANNEL[platform as SocialPlatform];
  if (!channel) return undefined;
  const wanted = freeTextFormat?.trim().toLowerCase();
  const matched = wanted
    ? CHANNELS[channel].formats.find((format) => {
        const label = format.label.toLowerCase();
        return (
          wanted.includes(label) ||
          label.includes(wanted) ||
          (wanted.includes("static") && label === "post")
        );
      })
    : undefined;
  return { channel, format: matched ?? defaultFormat(channel) };
}

// Any plan item — catalog-shaped or legacy — to its channel and format, or
// undefined when it is a platform the catalog does not cover.
export function resolvePlanItem(item: {
  channel?: string;
  formatKey?: string;
  platform?: string;
  format?: string;
}): { channel: ChannelKey; format: ChannelFormat } | undefined {
  if (isChannelKey(item.channel) && item.formatKey) {
    const format = resolveFormat(item.channel, item.formatKey);
    if (format) return { channel: item.channel, format };
  }
  return item.platform ? legacyToFormat(item.platform, item.format) : undefined;
}

export const PUBLISH_MODE_LABEL: Record<PublishMode, string> = {
  auto: "Auto-publish",
  manual: "You publish",
  approval: "Needs approval",
};
