import "server-only";

import { AdsFlags } from "@/lib/ads/flags";
import { metaWorkExcludedHere } from "@/lib/local-worker-policy";
import { prisma } from "@/lib/prisma";
import { AdsLaunches } from "@/server/ads/launch/store";
import { claimPeriodic } from "@/server/observability/periodic";

import { AdsAlerts } from "./alerts";

// Takılan lansman bekçisi (docs/meta-ads-plan.md §3.6, `meta-launch-watchdog`,
// 10 dk). CREATING / ACTIVATING / DISCARDING'de 30 dakikadan uzun kalan
// lansman: işi bitmişse (FAILED / CANCELLED) lansman da FAILED olur; iş hâlâ
// sürüyorsa CHAIN_STUCK uyarısı açılır. Onayı reddedilen ya da süresi dolan
// lansman CANCELLED / EXPIRED olur.

const EVERY_MS = 10 * 60_000;
const STUCK_MS = 30 * 60_000;

export const LaunchWatchdog = {
  async run(now: Date = new Date()): Promise<number> {
    if (!AdsFlags.launchV2()) return 0;
    if (metaWorkExcludedHere(process.env)) return 0;
    if (!(await claimPeriodic("ads.launch-watchdog", EVERY_MS, now))) return 0;
    let changed = 0;

    const moving = await prisma.adsLaunch.findMany({
      where: {
        status: { in: ["CREATING", "ACTIVATING", "DISCARDING"] },
        updatedAt: { lt: new Date(now.getTime() - STUCK_MS) },
      },
      take: 50,
    });
    for (const launch of moving) {
      const task = launch.currentTaskId
        ? await prisma.task.findUnique({
            where: { id: launch.currentTaskId },
            select: { status: true },
          })
        : null;
      const dead = !task || task.status === "FAILED" || task.status === "CANCELLED";
      if (dead) {
        await AdsLaunches.fail(launch.id, {
          step: launch.status === "ACTIVATING" ? "activate" : launch.status === "DISCARDING" ? "discard" : "create",
          class: "TRANSIENT",
          message: "The launch stopped before it finished. Try again or discard it.",
        });
        changed += 1;
        continue;
      }
      await AdsAlerts.raise(
        {
          workspaceId: launch.workspaceId,
          projectId: launch.projectId,
          adsAccountId: launch.adsAccountId,
          externalId: launch.campaignExternalId,
          kind: "CHAIN_STUCK",
          severity: "WARN",
          dedupeKey: `CHAIN_STUCK:launch:${launch.id}`,
          title: "A launch is taking longer than expected",
          detail: "Meta hasn't finished creating the ad yet. Agentelse keeps checking; nothing runs until it's done.",
        },
        now,
      );
      changed += 1;
    }

    // Onay bekleyen lansman: onay reddedildi ya da süresi doldu.
    const waiting = await prisma.adsLaunch.findMany({
      where: { status: "AWAITING_APPROVAL" },
      take: 100,
      select: { id: true, approvalId: true },
    });
    for (const launch of waiting) {
      if (!launch.approvalId) continue;
      const approval = await prisma.approval.findUnique({
        where: { id: launch.approvalId },
        select: { status: true },
      });
      if (approval?.status === "REJECTED") {
        await AdsLaunches.transition(launch.id, ["AWAITING_APPROVAL"], "CANCELLED");
        changed += 1;
      } else if (approval?.status === "EXPIRED") {
        await AdsLaunches.transition(launch.id, ["AWAITING_APPROVAL"], "EXPIRED");
        changed += 1;
      }
    }

    // Biten lansmanların takılma uyarıları kapanır.
    const settled = await prisma.adsAlert.findMany({
      where: { kind: "CHAIN_STUCK", status: { in: ["OPEN", "ACKED"] }, dedupeKey: { startsWith: "CHAIN_STUCK:launch:" } },
      select: { projectId: true, dedupeKey: true },
      take: 100,
    });
    for (const alert of settled) {
      const id = alert.dedupeKey.slice("CHAIN_STUCK:launch:".length);
      const launch = await prisma.adsLaunch.findUnique({ where: { id }, select: { status: true } });
      if (!launch || !["CREATING", "ACTIVATING", "DISCARDING"].includes(launch.status)) {
        await AdsAlerts.resolve(alert.projectId, alert.dedupeKey, now);
      }
    }
    return changed;
  },
};
