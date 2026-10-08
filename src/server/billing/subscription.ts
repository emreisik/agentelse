import "server-only";

import { prisma } from "@/lib/prisma";
import { TRIAL, type PlanKey } from "@/lib/billing/plans";
import { addDaysUTC } from "@/lib/billing/windows";

import { getBillingConfig } from "./config";
import { ensurePeriod } from "./ledger";

// 7 günlük sınırlı ücretsiz deneme (Faz 5 kayıt akışı bağlar). Bir workspace
// hayatında YALNIZ BİR deneme alır: trialEndsAt bir kez yazılır, hiç silinmez
// (yeniden aktivasyonda ikinci deneme yok).
export type StartTrialResult =
  | { ok: true; trialEndsAt: Date }
  | {
      ok: false;
      reason: "ALREADY_TRIALED" | "ALREADY_SUBSCRIBED" | "BILLING_OFF";
    };

export async function startTrial(
  workspaceId: string,
  options: { planKey?: PlanKey; now?: Date } = {},
): Promise<StartTrialResult> {
  const now = options.now ?? new Date();
  if (getBillingConfig().mode === "off") {
    return { ok: false, reason: "BILLING_OFF" };
  }

  const result = await prisma.$transaction(
    async (tx): Promise<StartTrialResult> => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`usage:${workspaceId}`}, 0))`;
      const existing = await tx.subscription.findUnique({
        where: { workspaceId },
      });
      if (existing?.trialEndsAt)
        return { ok: false, reason: "ALREADY_TRIALED" };
      // Ücretli (ya da ücretli süresi süren) abonelik varsa deneme verilmez.
      if (
        existing &&
        existing.status !== "LEGACY" &&
        existing.status !== "TRIALING"
      ) {
        return { ok: false, reason: "ALREADY_SUBSCRIBED" };
      }
      const trialEndsAt = addDaysUTC(now, TRIAL.days);
      const data = {
        planKey: options.planKey ?? existing?.planKey ?? null,
        status: "TRIALING",
        quotaAnchor: now,
        trialEndsAt,
      };
      await tx.subscription.upsert({
        where: { workspaceId },
        create: { workspaceId, interval: "MONTH", ...data },
        update: data,
      });
      return { ok: true, trialEndsAt };
    },
    { maxWait: 10_000, timeout: 15_000 },
  );
  if (!result.ok) return result;

  // Deneme penceresini aç (ayrı işlem: kilit çıkışta bırakıldı).
  await ensurePeriod(workspaceId, { now });
  return result;
}
