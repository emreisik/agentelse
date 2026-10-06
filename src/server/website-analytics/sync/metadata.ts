import "server-only";

import type { Prisma } from "@prisma/client";

import { normalizeDomain } from "@/lib/domain";
import { prisma } from "@/lib/prisma";
import { safeTimezone } from "@/lib/website-analytics/days";
import { dayKeyInTimezone } from "@/lib/timezone";
import {
  fetchGaPropertyDetails,
  type GaStream,
} from "@/server/integrations/google-analytics/admin-api";

import type { GaSyncContext } from "./context";

// Mülkün ayrıntıları günde bir (docs/google-analytics-plan.md §5,
// "metadata"): saat dilimi günlük çekimin gününü belirler, para birimi
// gelirin birimini; web akışı ve ölçüm kimliği Integrations'taki mülk
// kartında ve GA-F3 site etiketi kontrolünde kullanılır.

// Birden çok web akışı varsa projenin sitesine uyan seçilir.
export function pickStream(
  streams: GaStream[],
  projectDomain: string | null,
): GaStream | null {
  if (streams.length === 0) return null;
  const domain = projectDomain ? normalizeDomain(projectDomain) : "";
  if (domain) {
    const matching = streams.find((stream) => {
      try {
        const host = normalizeDomain(new URL(stream.uri ?? "").hostname);
        return host === domain || host.endsWith(`.${domain}`);
      } catch {
        return false;
      }
    });
    if (matching) return matching;
  }
  return streams[0] ?? null;
}

export async function syncMetadata(ctx: GaSyncContext): Promise<void> {
  const details = await fetchGaPropertyDetails(
    ctx.accessToken,
    ctx.link.propertyId,
  );
  const project = await prisma.project.findUnique({
    where: { id: ctx.link.projectId },
    select: { domain: true },
  });
  const stream = pickStream(details.streams, project?.domain ?? null);
  const updated = await prisma.gaPropertyLink.update({
    where: { id: ctx.link.id },
    data: {
      propertyName: details.propertyName ?? ctx.link.propertyName,
      accountId: details.accountId,
      timeZone: details.timeZone,
      currencyCode: details.currencyCode,
      industryCategory: details.industryCategory,
      serviceLevel: details.serviceLevel,
      propertyCreatedAt: details.createTime
        ? new Date(details.createTime)
        : null,
      streamId: stream?.streamId ?? null,
      measurementId: stream?.measurementId ?? null,
      streamUri: stream?.uri ?? null,
      ...(details.keyEvents
        ? { keyEvents: details.keyEvents as unknown as Prisma.InputJsonValue }
        : {}),
      dataRetention: details.dataRetention,
      ...(details.googleAdsLinks !== null
        ? {
            linkedProducts: {
              googleAds: details.googleAdsLinks,
            } as Prisma.InputJsonValue,
          }
        : {}),
      lastMetadataAt: ctx.now,
      health: "OK",
      healthReason: null,
    },
  });
  ctx.link = updated;
  // Saat dilimi değiştiyse günlük çekimin günü de değişir.
  ctx.timeZone = safeTimezone(updated.timeZone);
  ctx.today = dayKeyInTimezone(ctx.now, ctx.timeZone);
}
