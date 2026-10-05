import {
  CHANNELS,
  CHANNEL_KEYS,
  type ChannelConnections,
  type ChannelKey,
} from "@/lib/content-channels";
import type { ModuleKey } from "@/lib/modules/catalog";
import { channelOffers } from "./channel-offers";

// Pure rules of a Work (docs/works.md): a titled, channel-scoped conversation.
// Isomorphic on purpose (the sidebar and the cards import it); nothing here
// touches the database.

export const WORK_STATUSES = ["ACTIVE", "DONE", "ARCHIVED"] as const;
export type WorkStatusValue = (typeof WORK_STATUSES)[number];

export const WORK_DEFAULT_TITLE = "New Chat";
// Untitled Works made before the "New Chat" rename still carry this title. They
// count as untitled everywhere (blank reuse, first-message title) and read as
// WORK_DEFAULT_TITLE on screen, so no stored row needs rewriting.
export const LEGACY_WORK_DEFAULT_TITLES = ["New Work"] as const;
export const WORK_DEFAULT_TITLES: readonly string[] = [
  WORK_DEFAULT_TITLE,
  ...LEGACY_WORK_DEFAULT_TITLES,
];

export function isDefaultWorkTitle(title: string): boolean {
  return WORK_DEFAULT_TITLES.includes(title);
}

export const WORK_TITLE_MAX = 60;
export const WORK_SUMMARY_MAX = 90;

// What a screen needs of a Work (the row minus ids nobody renders).
export type WorkView = {
  id: string;
  title: string;
  summary: string | null;
  status: WorkStatusValue;
  channels: ChannelKey[];
  acknowledgedUnconnected: ChannelKey[];
  // The module it is for (src/lib/modules/catalog.ts); null = a general chat.
  module: ModuleKey | null;
  lastActivityAt: string;
};

// Stored JSON -> a clean, de-duplicated list of known channel keys.
export function parseChannelKeys(value: unknown): ChannelKey[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<ChannelKey>();
  for (const item of value) {
    if ((CHANNEL_KEYS as readonly unknown[]).includes(item)) {
      seen.add(item as ChannelKey);
    }
  }
  return CHANNEL_KEYS.filter((key) => seen.has(key));
}

export function isWorkStatus(value: unknown): value is WorkStatusValue {
  return (WORK_STATUSES as readonly unknown[]).includes(value);
}

// A short single-line title from the user's first message: first sentence,
// whitespace collapsed, cut on a word boundary. Never empty.
export function workTitleFrom(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  if (!flat) return WORK_DEFAULT_TITLE;
  const sentence = flat.split(/(?<=[.!?…])\s/)[0] ?? flat;
  if (sentence.length <= WORK_TITLE_MAX) return sentence;
  const cut = sentence.slice(0, WORK_TITLE_MAX - 1);
  const space = cut.lastIndexOf(" ");
  return `${(space > 20 ? cut.slice(0, space) : cut).trimEnd()}…`;
}

export function workSummaryFrom(text: string): string | null {
  const flat = text.replace(/\s+/g, " ").trim();
  if (!flat) return null;
  return flat.length <= WORK_SUMMARY_MAX
    ? flat
    : `${flat.slice(0, WORK_SUMMARY_MAX - 1).trimEnd()}…`;
}

// ---------------------------------------------------------------------------
// The channel gate: nothing is planned or produced before a channel is chosen.
// A channel that is not connected may still be chosen ("I'll connect later"):
// planning and production work, publishing stays locked until it is connected.
// ---------------------------------------------------------------------------

// Blog/SEO has nothing to connect: it is always a hand-off.
export function channelNeedsConnection(key: ChannelKey): boolean {
  return CHANNELS[key].group !== "seo";
}

// The `?integration=` value the integrations page opens a provider card with
// (META_PROVIDER / GOOGLE_PROVIDER values); SEO has nothing to connect.
export function integrationParamOf(key: ChannelKey): string | undefined {
  switch (key) {
    case "instagram":
      return "instagram";
    case "facebook":
      return "facebook";
    case "ads":
      return "meta_ads";
    case "tiktok":
      return "tiktok";
    case "linkedin":
      return "linkedin";
    case "x":
      return "x";
    case "seo":
      return undefined;
  }
}

export type WorkChannelState = {
  key: ChannelKey;
  label: string;
  connected: boolean;
  accountLabel?: string;
  needsConnection: boolean;
  // Chosen while not connected: publishing is locked until it is.
  publishLocked: boolean;
};

export function workChannelStates(
  channels: readonly ChannelKey[],
  connections: ChannelConnections,
): WorkChannelState[] {
  return channels.map((key) => {
    const needsConnection = channelNeedsConnection(key);
    const connection = connections[key];
    const connected = needsConnection ? connection?.connected === true : true;
    return {
      key,
      label: CHANNELS[key].label,
      connected,
      accountLabel: connection?.accountLabel,
      needsConnection,
      publishLocked: needsConnection && !connected,
    };
  });
}

export type ChannelGate =
  | { ok: true; channels: WorkChannelState[]; locked: ChannelKey[] }
  | { ok: false; reason: "NO_CHANNEL" };

export function gateWorkChannels(
  channels: readonly ChannelKey[],
  connections: ChannelConnections,
): ChannelGate {
  if (channels.length === 0) return { ok: false, reason: "NO_CHANNEL" };
  const states = workChannelStates(channels, connections);
  return {
    ok: true,
    channels: states,
    locked: states.filter((s) => s.publishLocked).map((s) => s.key),
  };
}

// The options of the channel-select card: every channel, with its live state.
export type ChannelOption = {
  key: ChannelKey;
  label: string;
  short: string;
  color: string;
  needsConnection: boolean;
  connected: boolean;
  accountLabel?: string;
};

export function channelOptions(
  connections: ChannelConnections,
): ChannelOption[] {
  return CHANNEL_KEYS.map((key) => {
    const def = CHANNELS[key];
    const needsConnection = channelNeedsConnection(key);
    const connection = connections[key];
    return {
      key,
      label: def.label,
      short: def.short,
      color: def.color,
      needsConnection,
      connected: needsConnection ? connection?.connected === true : true,
      accountLabel: connection?.accountLabel,
    };
  });
}

// "Instagram and LinkedIn" / "Instagram, TikTok and X".
export function channelListText(channels: readonly ChannelKey[]): string {
  const names = channels.map((key) => CHANNELS[key].label);
  if (names.length <= 1) return names[0] ?? "";
  return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

// The platform a creative of this Work is stored under: the first chosen
// channel that has one (seo/ads have none).
export function primaryPlatformOf(channels: readonly ChannelKey[]) {
  for (const key of channels) {
    const platform = CHANNELS[key].platform;
    if (platform) return platform;
  }
  return undefined;
}

// The status line under a Work's title: "Instagram · LinkedIn (not connected)".
// Empty when no channel is chosen yet.
export function workChannelsSummary(
  states: readonly WorkChannelState[],
): string {
  return states
    .map((state) =>
      state.publishLocked ? `${state.label} (not connected)` : state.label,
    )
    .join(" · ");
}

// ---------------------------------------------------------------------------
// Today Work: one deterministic Work per project and day. All parsing of its
// id lives here.
// ---------------------------------------------------------------------------

export const TODAY_WORK_PREFIX = "today_";

export function todayWorkId(projectId: string, dayKey: string): string {
  return `${TODAY_WORK_PREFIX}${projectId}_${dayKey}`;
}

// The YYYY-MM-DD of a Today Work id, or null for any other id (a cuid, a bad date).
export function todayDayKeyOf(workId: string): string | null {
  const match = /^today_.+_(\d{4}-\d{2}-\d{2})$/.exec(workId);
  if (!match) return null;
  const key = match[1];
  const date = new Date(`${key}T00:00:00Z`);
  // Round trip rejects 2026-02-30 and friends.
  return !Number.isNaN(date.getTime()) &&
    date.toISOString().slice(0, 10) === key
    ? key
    : null;
}

export function isTodayWork(work: { id: string }): boolean {
  return todayDayKeyOf(work.id) !== null;
}

export function todayWorkTitle(): string {
  return "Today";
}

// An address that keeps the chat the person is in: panels opened from a chat and
// their "Back to chat" carry `?work=`, because the bare project URL starts a new
// chat (docs/works.md).
export function withWorkParam(
  href: string,
  workId: string | null | undefined,
): string {
  const id = workId?.trim();
  if (!id) return href;
  return `${href}${href.includes("?") ? "&" : "?"}work=${encodeURIComponent(id)}`;
}

export type WorkParam =
  { kind: "none" } | { kind: "today" } | { kind: "id"; id: string };

// The `?work=` value: "today" is an alias, any other non-empty string is an id.
export function resolveWorkParam(
  requested: string | undefined,
  // Kept so callers pass the same day they will create the Today Work for.
  todayKey: string,
): WorkParam {
  void todayKey;
  const value = requested?.trim();
  if (!value) return { kind: "none" };
  if (value === "today") return { kind: "today" };
  return { kind: "id", id: value };
}

// Connected channels no active, non-Today Work covers: the same rule as the
// channel offer (one implementation).
export function channelsWithoutWork(
  connections: ChannelConnections,
  works: readonly {
    id: string;
    channels: readonly ChannelKey[];
    status: WorkStatusValue;
  }[],
): ChannelKey[] {
  return channelOffers(
    connections,
    works.map((w) => ({
      id: w.id,
      title: "",
      channels: w.channels,
      status: w.status,
    })),
  ).open;
}
