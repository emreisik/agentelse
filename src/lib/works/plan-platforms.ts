import {
  ALL_FORMAT_KEYS,
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
  // The format keys the post leaves out (a draft's "Leave out").
  skipFormats?: readonly string[];
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
  const own = CHANNELS[channel].formats.find(
    (format) => format.key === hintKey,
  );
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

export const INSTAGRAM_POST = "instagram.post";
export const INSTAGRAM_STORY = "instagram.story";

// "Also as a Story" (the plan's one Instagram switch): every Instagram post
// gets a Story of the same post (same day, time and idea) right after it. Its
// picture is the post's own, adapted to 9:16 (plan-run.ts). A post that already
// has a Story keeps just that one.
export function withInstagramStories<T extends PlanLikeItem>(
  items: readonly T[],
): T[] {
  const storied = new Set(
    items.flatMap((item) =>
      !item.removed && resolvePlanItem(item)?.format.key === INSTAGRAM_STORY
        ? [postKeyOf(item)]
        : [],
    ),
  );
  const out: T[] = [];
  for (const item of items) {
    out.push(item);
    const resolved = resolvePlanItem(item);
    if (
      item.removed ||
      resolved?.channel !== "instagram" ||
      resolved.format.key !== INSTAGRAM_POST ||
      storied.has(postKeyOf(item))
    ) {
      continue;
    }
    storied.add(postKeyOf(item));
    out.push({
      ...item,
      channel: "instagram",
      platform: CHANNELS.instagram.platform,
      formatKey: INSTAGRAM_STORY,
      format: undefined,
    });
  }
  return out;
}

type PlanShape<T extends PlanLikeItem> = {
  items: readonly T[];
  platforms?: readonly string[];
  instagramStory?: boolean;
};

// The catalog format of an item ("instagram.story"), a legacy one included.
export function formatKeyOf(item: PlanLikeItem): string | undefined {
  return resolvePlanItem(item)?.format.key ?? item.formatKey;
}

function skips(item: PlanLikeItem): boolean {
  const key = formatKeyOf(item);
  return !!key && (item.skipFormats?.includes(key) ?? false);
}

export type DraftDelivery<T extends PlanLikeItem> = {
  // The piece as saving would make it.
  item: T;
  // Its post leaves it out ("Leave out" on the draft).
  skipped: boolean;
};

// Every delivery a plan could make (docs/works.md "Posts"): one per post and
// platform, plus the Instagram Stories when the switch is on; the ones a post
// leaves out (its format is in the post's skipFormats) are marked. The skip
// list travels with the general item into each platform's copy, so a post can
// leave its Instagram post out and keep the Story. A post never leaves out all
// of its deliveries: a list that would (a platform was unticked since) is not
// in force, and every delivery of that post stays.
export function deliveriesOfPlan<T extends PlanLikeItem>(
  card: PlanShape<T>,
): DraftDelivery<T>[] {
  const expanded =
    card.platforms && card.platforms.length > 0
      ? expandForPlatforms(card.items, card.platforms)
      : [...card.items];
  const all = card.instagramStory ? withInstagramStories(expanded) : expanded;
  const marks = all.map((item) => !item.removed && skips(item));
  const byPost = new Map<string, number[]>();
  all.forEach((item, index) => {
    if (item.removed) return;
    const key = postKeyOf(item);
    byPost.set(key, [...(byPost.get(key) ?? []), index]);
  });
  for (const indices of byPost.values()) {
    if (indices.every((index) => marks[index])) {
      for (const index of indices) marks[index] = false;
    }
  }
  return all.map((item, index) => ({ item, skipped: marks[index] ?? false }));
}

// Every piece a plan makes on saving: one per post and platform, plus the
// Instagram Stories when the switch is on, less what each post leaves out.
export function piecesOfPlan<T extends PlanLikeItem>(card: PlanShape<T>): T[] {
  return deliveriesOfPlan(card).flatMap((delivery) =>
    delivery.skipped ? [] : [delivery.item],
  );
}

export type SkipChange =
  | { ok: true; skipFormats: string[] }
  // UNKNOWN: not a delivery of this post; LAST: it is the only one left.
  | { ok: false; reason: "UNKNOWN" | "LAST" };

// A draft post's skip list after one of its deliveries is left out (`skip`) or
// taken back in: the list every item of the post then carries. It holds what
// the post leaves out now (a list that is not in force counts as empty) and
// keeps the formats the post is not made in at the moment, for when their
// platform comes back. A post keeps at least one delivery.
export function nextSkipFormats(
  post: readonly PlanLikeItem[],
  plan: { platforms?: readonly string[]; instagramStory?: boolean },
  formatKey: string,
  skip: boolean,
): SkipChange {
  const deliveries = deliveriesOfPlan({ ...plan, items: post });
  const keys = new Set(
    deliveries.flatMap((delivery) => {
      const key = formatKeyOf(delivery.item);
      return key ? [key] : [];
    }),
  );
  if (!keys.has(formatKey)) return { ok: false, reason: "UNKNOWN" };
  const next = new Set(
    post
      .flatMap((item) => item.skipFormats ?? [])
      .filter((key) => !keys.has(key)),
  );
  for (const delivery of deliveries) {
    const key = formatKeyOf(delivery.item);
    if (delivery.skipped && key) next.add(key);
  }
  if (skip) next.add(formatKey);
  else next.delete(formatKey);
  if ([...keys].every((key) => next.has(key))) {
    return { ok: false, reason: "LAST" };
  }
  return {
    ok: true,
    skipFormats: ALL_FORMAT_KEYS.filter((key) => next.has(key)),
  };
}

// The item with this skip list (none: the field goes).
export function withSkipFormats<T extends PlanLikeItem>(
  item: T,
  skipFormats: readonly string[],
): T {
  if (skipFormats.length > 0) return { ...item, skipFormats: [...skipFormats] };
  if (item.skipFormats === undefined) return item;
  const next = { ...item };
  delete next.skipFormats;
  return next;
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
  // The saved Post the items deliver, when they name one.
  postId?: string;
  date: string;
  time: string;
  topic: string;
  captionIdea: string;
  // Positions in the card's items of everything this post is made of.
  indices: number[];
  items: T[];
};

// The posts of a plan, soonest first: items that share a day, a time and an
// idea are one post (a saved plan has one item per platform). `postIdOf`: the
// Post a saved item delivers (its slot's postId). Items of one Post are one
// post whatever their day says; an item without one (a plan saved before
// posts existed) falls back to its day, time and idea.
export function groupPosts<T extends PlanLikeItem>(
  items: readonly T[],
  postIdOf?: (index: number) => string | undefined,
): PlanPost<T>[] {
  const byKey = new Map<string, PlanPost<T>>();
  items.forEach((item, index) => {
    if (item.removed) return;
    const postId = postIdOf?.(index);
    const key = postId ?? postKeyOf(item);
    const post = byKey.get(key);
    if (post) {
      post.indices.push(index);
      post.items.push(item);
      return;
    }
    byKey.set(key, {
      key,
      ...(postId ? { postId } : {}),
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
