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

export async function loadInstagramOverview(
  projectId: string,
  now: number = Date.now(),
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
    console.error("[instagram-overview] failed:", error);
    return { ok: false, reason: "error" };
  }
}
