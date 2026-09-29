import "server-only";

import type { SignalCategory, SignalIntensity } from "@prisma/client";

import {
  FOCUS_SIGNAL_CATEGORIES,
  isAgencyFocusMode,
} from "@/server/agency/agency-focus";
import { prisma } from "@/lib/prisma";

export type SignalProfileInput = {
  category: SignalCategory;
  intensity: SignalIntensity;
  config?: unknown;
};

export const SignalProfileRepository = {
  upsertMany(
    scope: { workspaceId: string; projectId: string; brandId: string },
    profiles: SignalProfileInput[],
  ) {
    return prisma.$transaction(
      profiles.map((profile) =>
        prisma.projectSignalProfile.upsert({
          where: {
            projectId_category: {
              projectId: scope.projectId,
              category: profile.category,
            },
          },
          create: {
            workspaceId: scope.workspaceId,
            projectId: scope.projectId,
            brandId: scope.brandId,
            category: profile.category,
            intensity: profile.intensity,
            config: profile.config as never,
          },
          update: {
            intensity: profile.intensity,
            config: profile.config as never,
          },
        }),
      ),
    );
  },

  listForProject(projectId: string) {
    return prisma.projectSignalProfile.findMany({
      where: { projectId },
      orderBy: { category: "asc" },
    });
  },

  // Profiles due for a scan right now. Intensity OFF is excluded by having a
  // null nextScanAt (the scheduler never sets one for OFF).
  listDue(limit: number) {
    return prisma.projectSignalProfile.findMany({
      where: {
        intensity: { not: "OFF" },
        nextScanAt: { lte: new Date() },
        // Focus mode (agency-focus.ts): only social/ads categories scan.
        ...(isAgencyFocusMode()
          ? { category: { in: [...FOCUS_SIGNAL_CATEGORIES] } }
          : {}),
      },
      take: limit,
      orderBy: { nextScanAt: "asc" },
    });
  },

  updateScanTimes(id: string, lastScanAt: Date, nextScanAt: Date | null) {
    return prisma.projectSignalProfile.update({
      where: { id },
      data: { lastScanAt, nextScanAt },
    });
  },

  setNextScan(id: string, nextScanAt: Date | null) {
    return prisma.projectSignalProfile.update({
      where: { id },
      data: { nextScanAt },
    });
  },
};
