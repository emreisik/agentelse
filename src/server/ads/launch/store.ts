import "server-only";

import type { AdsLaunch, AdsLaunchStatus, Prisma } from "@prisma/client";

import { prisma } from "@/lib/prisma";

// AdsLaunch deposu (docs/meta-ads-plan.md §3.4, §4). Durum geçişleri CAS'tır;
// adım makinesi kilitle (leaseUntil) korunur: işçinin yoklaması ile satır içi
// sürüş aynı anda Meta'ya yazmaz.

export type LaunchProgress = {
  // Reklam sırası → Meta görsel hash'i / kreatif kimliği.
  images?: Record<string, string>;
  creatives?: Record<string, string>;
  campaign?: string;
  adSets?: Record<string, string>;
  ads?: Record<string, string>;
  // Ad set'in kurulduğu an ve bitişi (UNIX saniyesi).
  startTime?: number;
  endTime?: number;
  verified?: {
    at: string;
    ok: boolean;
    spendCapMinor: number | null;
    endTime: string | null;
    notes: string[];
  };
  // Meta AI özellik listesi reddedildi: kreatif onsuz kuruldu.
  featuresFallback?: boolean;
};

export type LaunchError = {
  step: string;
  class: string;
  code?: number | null;
  subcode?: number | null;
  message: string;
  field?: string | null;
  fbtraceId?: string | null;
};

const LEASE_MS = 2 * 60_000;

export function progressOf(launch: Pick<AdsLaunch, "progress">): LaunchProgress {
  const value = launch.progress;
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as LaunchProgress)
    : {};
}

export function errorOf(launch: Pick<AdsLaunch, "error">): LaunchError | null {
  const value = launch.error;
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as LaunchError)
    : null;
}

export const AdsLaunches = {
  get(id: string) {
    return prisma.adsLaunch.findUnique({ where: { id } });
  },

  forProject(id: string, projectId: string) {
    return prisma.adsLaunch.findFirst({ where: { id, projectId } });
  },

  // Kartın en yeni lansmanı.
  latestForCommand(commandId: string) {
    return prisma.adsLaunch.findFirst({
      where: { commandId },
      orderBy: { createdAt: "desc" },
    });
  },

  async claim(id: string, owner: string, now: Date = new Date()): Promise<boolean> {
    const result = await prisma.adsLaunch.updateMany({
      where: {
        id,
        OR: [{ leaseUntil: null }, { leaseUntil: { lt: now } }],
      },
      data: { leaseUntil: new Date(now.getTime() + LEASE_MS), leaseOwner: owner },
    });
    return result.count === 1;
  },

  async release(id: string, owner: string): Promise<void> {
    await prisma.adsLaunch.updateMany({
      where: { id, leaseOwner: owner },
      data: { leaseUntil: null, leaseOwner: null },
    });
  },

  async saveProgress(id: string, progress: LaunchProgress, extra: Prisma.AdsLaunchUpdateInput = {}) {
    return prisma.adsLaunch.update({
      where: { id },
      data: { progress: progress as Prisma.InputJsonValue, ...extra },
    });
  },

  // CAS geçiş: yalnız `from` durumlarından birindeyse.
  async transition(
    id: string,
    from: readonly AdsLaunchStatus[],
    to: AdsLaunchStatus,
    data: Prisma.AdsLaunchUpdateManyMutationInput = {},
  ): Promise<boolean> {
    const result = await prisma.adsLaunch.updateMany({
      where: { id, status: { in: [...from] } },
      data: { ...data, status: to },
    });
    return result.count === 1;
  },

  async fail(id: string, error: LaunchError): Promise<void> {
    await prisma.adsLaunch.update({
      where: { id },
      data: { status: "FAILED", error: error as unknown as Prisma.InputJsonValue },
    });
  },
};
