import "server-only";

import { prisma } from "@/lib/prisma";
import { isMetaPermissionError } from "@/lib/instagram-overview";
import {
  INSTAGRAM_WINDOW_DAYS,
  type AnalyticsPeriod,
  type FailReason,
} from "@/lib/module-flows/analytics/catalog";
import {
  failedSection,
  okSection,
  type ReportMetric,
  type ReportSection,
} from "@/lib/module-flows/analytics/report";
import {
  instagramAccessFor,
  instagramLoginExpired,
  resolveInstagramTarget,
} from "@/server/integrations/instagram-target";
import {
  META_PROVIDER,
  MetaApiError,
  fetchInstagramAccountInsights,
  fetchInstagramProfile,
  isMetaRateLimit,
  type InstagramAccountInsights,
  type MetaInstagramMetadata,
} from "@/server/integrations/meta-client";
import { decryptSecret } from "@/server/security/crypto";

// The Instagram section of a report: the account's totals over the period
// (reach, views, accounts engaged, interactions) through the official API,
// either login route, plus today's follower count. Meta answers at most 30 days
// of totals per call, so a longer period reads its last 30 days and says so
// (the section's `days`). Never throws: a failure is the section's reason.

const DAY_SECONDS = 24 * 60 * 60;

const INSIGHT_KEYS: readonly [
  keyof InstagramAccountInsights,
  ReportMetric["key"],
][] = [
  ["reach", "ig.reach"],
  ["views", "ig.views"],
  ["accounts_engaged", "ig.accountsEngaged"],
  ["total_interactions", "ig.interactions"],
];

export function instagramDaysFor(period: AnalyticsPeriod): number {
  return Math.min(period, INSTAGRAM_WINDOW_DAYS);
}

// Meta's own words for what went wrong, shared by both Meta sources.
export function metaFailReason(error: unknown): FailReason {
  if (error instanceof MetaApiError) {
    if (error.metaErrorCode === 190) return "expired";
    if (isMetaRateLimit(error)) return "rate_limited";
    if (isMetaPermissionError(error.metaErrorCode, error.message)) {
      return "permission";
    }
  }
  return "error";
}

export async function collectInstagram(
  projectId: string,
  period: AnalyticsPeriod,
  now: number,
): Promise<ReportSection> {
  const credential = await prisma.integrationCredential.findUnique({
    where: {
      projectId_provider: { projectId, provider: META_PROVIDER.instagram },
    },
    select: { status: true, metadata: true, encryptedSecret: true },
  });
  if (!credential || credential.status !== "ACTIVE") {
    return failedSection(
      "instagram",
      credential?.status === "EXPIRED" ? "expired" : "not_connected",
    );
  }
  const metadata = (credential.metadata ??
    null) as Partial<MetaInstagramMetadata> | null;
  const target = resolveInstagramTarget(metadata);
  if (!target) return failedSection("instagram", "setup");
  if (instagramLoginExpired(metadata, now)) {
    return failedSection("instagram", "expired");
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
    const days = instagramDaysFor(period);
    const until = Math.floor(now / 1000);
    const [insights, profile] = await Promise.all([
      fetchInstagramAccountInsights({
        ...call,
        since: until - days * DAY_SECONDS,
        until,
      }),
      // The follower count is an extra: it never costs the section.
      fetchInstagramProfile(call).catch(() => null),
    ]);

    const metrics: ReportMetric[] = [];
    for (const [name, key] of INSIGHT_KEYS) {
      const value = insights[name];
      if (typeof value === "number" && Number.isFinite(value)) {
        metrics.push({ key, value });
      }
    }
    if (metrics.length === 0) return failedSection("instagram", "no_data");
    const followers = profile?.followers;
    if (typeof followers === "number" && Number.isFinite(followers)) {
      metrics.push({ key: "ig.followers", value: followers });
    }
    const username = profile?.username ?? target.username;
    return okSection("instagram", {
      days,
      account: username ? `@${username}` : null,
      metrics,
    });
  } catch (error) {
    const reason = metaFailReason(error);
    if (reason === "error") {
      console.error(
        "[analytics] instagram read failed:",
        error instanceof Error ? error.message : error,
      );
    }
    return failedSection("instagram", reason);
  }
}
