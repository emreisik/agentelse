import "server-only";

import { prisma } from "@/lib/prisma";
import {
  degradedEntitlements,
  resolveEntitlements,
  type Entitlements,
  type SubscriptionFacts,
} from "@/lib/billing/entitlements-core";

import { getBillingConfig } from "./config";

// Abonelik satırından karar için gereken alanlar (Prisma satırı → saf çekirdek).
export function toSubscriptionFacts(row: {
  planKey: string | null;
  interval: string | null;
  status: string;
  quotaAnchor: Date | null;
  paidThrough: Date | null;
  trialEndsAt: Date | null;
  graceUntil: Date | null;
  legacyUntil: Date | null;
  cancelAtPeriodEnd: boolean;
  periodIndex: number;
  introOffer: boolean;
  pendingPlanKey: string | null;
  pendingInterval: string | null;
  pendingEffectiveAt: Date | null;
  exempt: boolean;
}): SubscriptionFacts {
  return {
    planKey: row.planKey,
    interval: row.interval,
    status: row.status,
    quotaAnchor: row.quotaAnchor,
    paidThrough: row.paidThrough,
    trialEndsAt: row.trialEndsAt,
    graceUntil: row.graceUntil,
    legacyUntil: row.legacyUntil,
    cancelAtPeriodEnd: row.cancelAtPeriodEnd,
    periodIndex: row.periodIndex,
    introOffer: row.introOffer,
    pendingPlanKey: row.pendingPlanKey,
    pendingInterval: row.pendingInterval,
    pendingEffectiveAt: row.pendingEffectiveAt,
    exempt: row.exempt,
  };
}

// Bir workspace'in hakları. ASLA fırlatmaz: okuma hatasında enforce'ta kapalı,
// aksi halde açık karar döner (reason "DEGRADED"). BILLING_MODE=off iken veritabanına
// HİÇ dokunmaz (canlı yola tek sorgu eklenmez).
export async function getEntitlements(
  workspaceId: string,
  options: { now?: Date } = {},
): Promise<Entitlements> {
  const now = options.now ?? new Date();
  const config = getBillingConfig();
  if (config.mode === "off") {
    return resolveEntitlements({
      workspaceCreatedAt: null,
      subscription: null,
      config,
      now,
    });
  }
  try {
    const row = await prisma.subscription.findUnique({
      where: { workspaceId },
    });
    // Workspace açılış tarihi yalnız satırı olmayan workspace'in LEGACY sayılması
    // için gerekir.
    const createdAt =
      row || !config.legacyBefore
        ? null
        : ((
            await prisma.workspace.findUnique({
              where: { id: workspaceId },
              select: { createdAt: true },
            })
          )?.createdAt ?? null);
    const result = resolveEntitlements({
      workspaceCreatedAt: createdAt,
      subscription: row ? toSubscriptionFacts(row) : null,
      config,
      now,
    });
    if (result.reason === "INCOMPLETE_SUBSCRIPTION") {
      // Ödeyen biri hak almadan kalmasın: sessiz geçme.
      console.error(
        `[billing] incomplete subscription row for workspace ${workspaceId}: plan/anchor/paidThrough missing or status unknown`,
      );
    }
    return result;
  } catch (error) {
    console.error(
      "[billing] getEntitlements failed:",
      error instanceof Error ? error.name : error,
    );
    return degradedEntitlements(config.mode);
  }
}
