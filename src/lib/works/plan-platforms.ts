import {
  CHANNELS,
  CHANNEL_KEYS,
  defaultFormat,
  isChannelKey,
  resolvePlanItem,
  type ChannelKey,
} from "@/lib/content-channels";

// A social media plan is general (docs/works.md): its items are POSTS (a day, a
// time and an idea), and the platforms they go to are chosen once on the card.
// Saving makes one piece per post and platform, each in that platform's own
// format. Pure: the card, the save and the actions share these rules.

export type PlanLikeItem = {
  date: string;
  time: string;
  platform?: string;
  format?: string;
  channel?: string;
  formatKey?: string;
  topic: string;
  captionIdea: string;
  removed?: boolean;
};

// Instagram, TikTok, LinkedIn and X: the platforms a post can go to.
export const SOCIAL_PLATFORMS: readonly ChannelKey[] = CHANNEL_KEYS.filter(
  (key) => CHANNELS[key].group === "social",
);

export function isSocialPlatform(value: unknown): value is ChannelKey {
  return isChannelKey(value) && CHANNELS[value].group === "social";
}

// Unique, in catalog order.
export function orderedPlatforms(values: readonly unknown[]): ChannelKey[] {
  const wanted = new Set(values.filter(isSocialPlatform));
  return SOCIAL_PLATFORMS.filter((key) => wanted.has(key));
}

// The channel an item names (its catalog channel, or the one a legacy platform
// maps to).
function channelOf(item: PlanLikeItem): ChannelKey | undefined {
  const resolved = resolvePlanItem(item);
  if (resolved) return resolved.channel;
  return isChannelKey(item.channel) ? item.channel : undefined;
}

function socialChannelOf(item: PlanLikeItem): ChannelKey | undefined {
  const channel = channelOf(item);
  return channel && CHANNELS[channel].group === "social" ? channel : undefined;
}

// The platforms a plan goes to: the card's own choice; else the social channels
// its items already name; else Instagram (the standard everything is made for
// until the person chooses).
export function activePlatformsOf(card: {
  platforms?: readonly string[];
  items: readonly PlanLikeItem[];
}): ChannelKey[] {
  const chosen = orderedPlatforms(card.platforms ?? []);
  if (chosen.length > 0) return chosen;
  const named = orderedPlatforms(
    card.items.flatMap((item) => {
      const channel = socialChannelOf(item);
      return channel ? [channel] : [];
    }),
  );
  return named.length > 0 ? named : ["instagram"];
}

// A post's format on another platform: the same family where there is one (a
// Reel stays a video), else the platform's first format.
export function formatFor(channel: ChannelKey, hintKey?: string): string {
  const own = CHANNELS[channel].formats.find((format) => format.key === hintKey);
  if (own) return own.key;
  const hint = hintKey
    ? Object.values(CHANNELS)
        .flatMap((def) => def.formats)
        .find((format) => format.key === hintKey)
    : undefined;
  const video = hint?.glyph === "reel" || hint?.glyph === "video";
  const sameFamily = video
    ? CHANNELS[channel].formats.find(
        (format) => format.glyph === "reel" || format.glyph === "video",
      )
    : undefined;
  return (sameFamily ?? defaultFormat(channel)).key;
}

function retarget<T extends PlanLikeItem>(item: T, channel: ChannelKey): T {
  return {
    ...item,
    channel,
    platform: CHANNELS[channel].platform,
    formatKey: formatFor(channel, item.formatKey),
    format: undefined,
  };
}

// One item per post and platform. A post that names a social channel keeps its
// own item there; the other platforms get a copy in their own format. Items on
// Blog/SEO or Ads are not social posts and stay as they are.
export function expandForPlatforms<T extends PlanLikeItem>(
  items: readonly T[],
  platforms: readonly string[],
): T[] {
  const targets = orderedPlatforms(platforms);
  if (targets.length === 0) return [...items];
  const out: T[] = [];
  for (const item of items) {
    const own = socialChannelOf(item);
    if (item.removed || (channelOf(item) && !own)) {
      out.push(item);
      continue;
    }
    for (const channel of targets) {
      out.push(channel === own ? item : retarget(item, channel));
    }
  }
  return out;
}

// What names a post among the others: its day, its time and its idea.
export function postKeyOf(item: {
  date: string;
  time: string;
  topic: string;
}): string {
  return `${item.date}|${item.time}|${item.topic}`;
}

export type PlanPost<T extends PlanLikeItem> = {
  key: string;
  date: string;
  time: string;
  topic: string;
  captionIdea: string;
  // Positions in the card's items of everything this post is made of.
  indices: number[];
  items: T[];
};

// The posts of a plan, soonest first: items that share a day, a time and an
// idea are one post (a saved plan has one item per platform).
export function groupPosts<T extends PlanLikeItem>(
  items: readonly T[],
): PlanPost<T>[] {
  const byKey = new Map<string, PlanPost<T>>();
  items.forEach((item, index) => {
    if (item.removed) return;
    const key = postKeyOf(item);
    const post = byKey.get(key);
    if (post) {
      post.indices.push(index);
      post.items.push(item);
      return;
    }
    byKey.set(key, {
      key,
      date: item.date,
      time: item.time,
      topic: item.topic,
      captionIdea: item.captionIdea,
      indices: [index],
      items: [item],
    });
  });
  return [...byKey.values()].sort((a, b) =>
    `${a.date}T${a.time}`.localeCompare(`${b.date}T${b.time}`),
  );
}

const DAY_MS = 86_400_000;

function dayNumber(date: string): number {
  return Date.parse(`${date}T00:00:00Z`) / DAY_MS;
}

export function addDays(date: string, days: number): string {
  return new Date((dayNumber(date) + days) * DAY_MS).toISOString().slice(0, 10);
}

// The Monday of the week a day is in.
export function weekStartOf(date: string): string {
  const weekday = new Date(`${date}T00:00:00Z`).getUTCDay();
  return addDays(date, -((weekday + 6) % 7));
}

export const DATE_SHAPE = /^\d{4}-\d{2}-\d{2}$/;
export const TIME_SHAPE = /^([01]\d|2[0-3]):[0-5]\d$/;
