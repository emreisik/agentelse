import "server-only";

import { prisma } from "@/lib/prisma";
import {
  INSIGHTS_WINDOW_DAYS,
  isMetaPermissionError,
  type InstagramOverview,
} from "@/lib/instagram-overview";
import {
  instagramAccessFor,
  instagramLoginExpired,
  resolveInstagramTarget,
} from "@/server/integrations/instagram-target";
import {
  META_PROVIDER,
  MetaApiError,
  fetchInstagramAccountInsights,
  isMetaRateLimit,
  fetchInstagramPostStats,
  fetchInstagramProfile,
  type MetaInstagramMetadata,
} from "@/server/integrations/meta-client";
import { decryptSecret } from "@/server/security/crypto";

// Reads the project's connected Instagram account through the official API
// (either route): the profile and latest posts with the basic permission, the
// account totals with the insights permission. A connection made before the
// insights permission was asked for still gets the profile and the posts; the
// card then says a reconnect brings the totals.

const POSTS_LIMIT = 6;
const DAY_SECONDS = 24 * 60 * 60;

// The card is read on every chat page, and each read is 3-4 Graph calls that
// count against Meta's request limit for the whole app. A read that worked is
// kept for a while; while Meta says the limit is reached, nothing is asked
// for and the last good read (if any) is shown.
const FRESH_MS = 15 * 60_000;
const RATE_LIMIT_PAUSE_MS = 30 * 60_000;
const lastGood = new Map<string, { overview: InstagramOverview; at: number }>();
let pausedUntil = 0;

export function clearInstagramOverviewCache() {
  lastGood.clear();
  pausedUntil = 0;
}

export async function loadInstagramOverview(
  projectId: string,
  now: number = Date.now(),
): Promise<InstagramOverview> {
  const cached = lastGood.get(projectId);
  if (cached && now - cached.at < FRESH_MS) return cached.overview;
  if (now < pausedUntil) {
    return cached?.overview ?? { ok: false, reason: "rate_limited" };
  }
  const overview = await readInstagramOverview(projectId, now);
  if (overview.ok) {
    lastGood.set(projectId, { overview, at: now });
  } else if (overview.reason === "rate_limited") {
    pausedUntil = now + RATE_LIMIT_PAUSE_MS;
    return cached?.overview ?? overview;
  } else {
    lastGood.delete(projectId);
  }
  return overview;
}

async function readInstagramOverview(
  projectId: string,
  now: number,
): Promise<InstagramOverview> {
  const credential = await prisma.integrationCredential.findUnique({
    where: {
      projectId_provider: { projectId, provider: META_PROVIDER.instagram },
    },
  });
  const metadata = (credential?.metadata ??
    null) as Partial<MetaInstagramMetadata> | null;
  const target = resolveInstagramTarget(metadata);
  if (!credential || credential.status !== "ACTIVE" || !target) {
    return { ok: false, reason: "not_connected" };
  }
  if (instagramLoginExpired(metadata, now)) {
    return { ok: false, reason: "expired" };
  }

  try {
    const access = await instagramAccessFor(
      target,
      decryptSecret(credential.encryptedSecret),
    );
    const call = {
      igUserId: target.igUserId,
      accessToken: access.accessToken,
      api: access.api,
    };
    const until = Math.floor(now / 1000);
    const [profile, posts, insights] = await Promise.all([
      fetchInstagramProfile(call),
      fetchInstagramPostStats({ ...call, limit: POSTS_LIMIT }),
      fetchInstagramAccountInsights({
        ...call,
        since: until - INSIGHTS_WINDOW_DAYS * DAY_SECONDS,
        until,
      }).then(
        (values) => ({ values, missing: null }),
        (error: unknown) => ({
          values: null,
          missing:
            error instanceof MetaApiError &&
            isMetaPermissionError(error.metaErrorCode, error.message)
              ? ("permission" as const)
              : ("error" as const),
        }),
      ),
    ]);
    return {
      ok: true,
      profile: { ...profile, username: profile.username ?? target.username ?? null },
      insights: insights.values,
      insightsMissing: insights.missing,
      posts,
    };
  } catch (error) {
    if (error instanceof MetaApiError && error.metaErrorCode === 190) {
      return { ok: false, reason: "expired" };
    }
    if (isMetaRateLimit(error)) return { ok: false, reason: "rate_limited" };
    console.error("[instagram-overview] failed:", error);
    return { ok: false, reason: "error" };
  }
}
