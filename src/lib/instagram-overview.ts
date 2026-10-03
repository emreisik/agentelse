// The right panel's Instagram card: what the connected account looks like and
// how it is doing. Shared by the loader (server) and the card (client), so the
// shape and the few derived numbers live here, pure and testable.

import type {
  InstagramAccountInsights,
  InstagramPostStats,
  InstagramProfile,
} from "@/server/integrations/meta-client";

// How far back the account totals look. Meta allows at most 30 days per call.
export const INSIGHTS_WINDOW_DAYS = 28;

export type InstagramOverview =
  | {
      ok: true;
      profile: InstagramProfile;
      // null when the totals could not be read; `insightsMissing` says why.
      insights: InstagramAccountInsights | null;
      // "permission": the connection predates the insights permission, a
      // reconnect fixes it. "error": Meta did not answer.
      insightsMissing: "permission" | "error" | null;
      posts: InstagramPostStats[];
    }
  // "rate_limited": Meta's request limit is reached; it clears by itself.
  | { ok: false; reason: "not_connected" | "expired" | "rate_limited" | "error" };

// Likes + comments per post over the recent posts, as a share of followers.
// null when there is nothing to divide by, or no post shows its counters.
export function engagementRate(
  posts: InstagramPostStats[],
  followers: number | null,
): number | null {
  if (!followers || followers <= 0) return null;
  const counted = posts.filter(
    (post) => post.likes !== null || post.comments !== null,
  );
  if (counted.length === 0) return null;
  const total = counted.reduce(
    (sum, post) => sum + (post.likes ?? 0) + (post.comments ?? 0),
    0,
  );
  return total / counted.length / followers;
}

// Meta's permission failures: #10 (permission denied) and the 200-299 range
// (a scope the token does not carry).
export function isMetaPermissionError(
  code: number | undefined,
  message: string,
): boolean {
  if (code === 10 || (code !== undefined && code >= 200 && code < 300)) {
    return true;
  }
  return /permission/i.test(message);
}

const COMPACT = new Intl.NumberFormat("tr-TR", {
  notation: "compact",
  maximumFractionDigits: 1,
});
const GROUPED = new Intl.NumberFormat("tr-TR");
const PERCENT = new Intl.NumberFormat("tr-TR", {
  style: "percent",
  maximumFractionDigits: 1,
});

// 1.234 up to 9.999, then "12,3 B" / "1,2 Mn": the panel is narrow.
export function formatCount(value: number | null | undefined): string {
  if (value === null || value === undefined) return "—";
  return Math.abs(value) < 10_000 ? GROUPED.format(value) : COMPACT.format(value);
}

export function formatRate(rate: number | null): string {
  return rate === null ? "—" : PERCENT.format(rate);
}
