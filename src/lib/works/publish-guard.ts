// Pure publish guard and publish-line derivation for Works (spec 3.6.1).
// No IO: the caller loads the facts, this file only decides.

import { channelOfFormatKey, resolveFormat } from "@/lib/content-channels";
import { cleanDisplayText } from "@/lib/guided-setup/sanitize";

// A piece planned up to 24 h ago is still "due"; older is stale and is held.
export const PAST_GRACE_MS = 24 * 3600 * 1000;

export type PublishBlock =
  | "NOT_APPROVED"
  | "NOT_CONNECTED"
  | "NO_ASSET"
  | "MANUAL_FORMAT"
  | "NO_TIME"
  | "PAST_TIME"
  | "WRONG_PLATFORM"
  // The channel was left out of its post (Creative.excludedAt).
  | "EXCLUDED";

export type PublishTiming = "none" | "future" | "due" | "stale";

export function publishTimingOf(
  scheduledFor: Date | null,
  now: Date = new Date(),
): PublishTiming {
  if (!scheduledFor) return "none";
  const diff = scheduledFor.getTime() - now.getTime();
  if (diff > 0) return "future";
  return -diff <= PAST_GRACE_MS ? "due" : "stale";
}

export type PublishFacts = {
  status: string;
  platform: string | null;
  formatKey: string | null;
  hasAsset: boolean;
  scheduledFor: Date | null;
  // Lowercase provider names: instagram, tiktok, linkedin...
  connectedPlatforms: ReadonlySet<string>;
  // Left out of its post: never published.
  excluded?: boolean;
};

export type PublishDecision =
  | { ok: true; format: "FEED" | "STORIES"; timing: PublishTiming }
  | { ok: false; reason: PublishBlock };

function isManualFormat(formatKey: string | null): boolean {
  if (!formatKey) return false;
  const channel = channelOfFormatKey(formatKey);
  if (!channel) return false;
  return resolveFormat(channel, formatKey)?.publish === "manual";
}

export function canPublishNow(
  facts: PublishFacts,
  mode: "auto" | "explicit",
  now: Date = new Date(),
): PublishDecision {
  if (facts.excluded) return { ok: false, reason: "EXCLUDED" };
  if (facts.status !== "APPROVED") return { ok: false, reason: "NOT_APPROVED" };
  // Only Instagram is auto-publishable.
  if (facts.platform?.toUpperCase() !== "INSTAGRAM") {
    return { ok: false, reason: "WRONG_PLATFORM" };
  }
  if (!facts.connectedPlatforms.has("instagram")) {
    return { ok: false, reason: "NOT_CONNECTED" };
  }
  if (!facts.hasAsset) return { ok: false, reason: "NO_ASSET" };
  if (isManualFormat(facts.formatKey)) {
    return { ok: false, reason: "MANUAL_FORMAT" };
  }
  const timing = publishTimingOf(facts.scheduledFor, now);
  // Auto mode holds time-less and stale pieces whatever the schedule says, so
  // turning scheduled posting on never releases old held pieces.
  if (mode === "auto") {
    if (timing === "none") return { ok: false, reason: "NO_TIME" };
    if (timing === "stale") return { ok: false, reason: "PAST_TIME" };
  }
  // A null formatKey (legacy and autopilot creatives) is a FEED post.
  const format = facts.formatKey === "instagram.story" ? "STORIES" : "FEED";
  return { ok: true, format, timing };
}

export type CreativePublishLine =
  | {
      kind: "review";
      consequence: "scheduled" | "scheduled-off" | "held" | "manual" | "locked";
      plannedFor?: string;
      channel?: string;
    }
  | { kind: "scheduled"; plannedFor?: string; released: boolean }
  | { kind: "held"; reason: "no-time" | "past-time" }
  | { kind: "manual"; plannedFor?: string }
  | { kind: "locked"; channel: string }
  | { kind: "publishing" }
  | { kind: "failed"; reason?: string }
  | { kind: "published" };

export type PublishLineInput = {
  stage: "IN_REVIEW" | "APPROVED" | "PUBLISHED" | "OTHER";
  facts: PublishFacts & { channel: string | null; scheduleEnabled: boolean };
  publishState?: "idle" | "queued" | "publishing" | "published" | "failed";
  publishError?: string;
  now?: Date;
};

export function describePublishLine(
  input: PublishLineInput,
): CreativePublishLine | null {
  const { stage, facts } = input;
  if (stage === "OTHER") return null;
  if (stage === "PUBLISHED") return { kind: "published" };

  const now = input.now ?? new Date();
  const approved = stage === "APPROVED";

  // The pipeline state wins over every time-based line: a failed or running
  // post must never read "goes out".
  if (approved) {
    if (
      input.publishState === "publishing" ||
      input.publishState === "queued"
    ) {
      return { kind: "publishing" };
    }
    if (input.publishState === "failed") {
      const reason = cleanDisplayText(input.publishError, 120) ?? undefined;
      return reason ? { kind: "failed", reason } : { kind: "failed" };
    }
  }

  const platformKey = facts.platform?.toLowerCase() ?? null;
  const locked =
    facts.channel !== null &&
    platformKey !== null &&
    !facts.connectedPlatforms.has(platformKey);
  // Only Instagram is auto-publishable, so a piece with no platform (Ads
  // campaigns) is posted by hand too, exactly as canPublishNow and
  // autoPublishCreative treat it (WRONG_PLATFORM / SKIPPED).
  const manual =
    isManualFormat(facts.formatKey) || platformKey !== "instagram";
  const timing = publishTimingOf(facts.scheduledFor, now);
  const plannedFor = facts.scheduledFor?.toISOString();
  const scheduleOn = facts.scheduleEnabled;

  if (!approved) {
    if (locked && facts.channel) {
      return { kind: "review", consequence: "locked", channel: facts.channel };
    }
    if (manual) {
      return {
        kind: "review",
        consequence: "manual",
        ...(plannedFor && timing !== "none" ? { plannedFor } : {}),
      };
    }
    if (timing === "future") {
      return {
        kind: "review",
        consequence: scheduleOn ? "scheduled" : "scheduled-off",
        plannedFor,
      };
    }
    if (timing === "due") {
      return { kind: "review", consequence: scheduleOn ? "scheduled" : "held" };
    }
    return { kind: "review", consequence: "held" };
  }

  if (locked && facts.channel)
    return { kind: "locked", channel: facts.channel };
  if (manual) {
    return { kind: "manual", ...(plannedFor ? { plannedFor } : {}) };
  }
  if (timing === "future") {
    return { kind: "scheduled", plannedFor, released: scheduleOn };
  }
  if (timing === "due") {
    return scheduleOn
      ? { kind: "scheduled", released: true }
      : { kind: "held", reason: "past-time" };
  }
  if (timing === "none") return { kind: "held", reason: "no-time" };
  return { kind: "held", reason: "past-time" };
}
