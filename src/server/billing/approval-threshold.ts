import "server-only";

import type { ActorType, CapabilityKey } from "@prisma/client";

import { prisma } from "@/lib/prisma";
import {
  costApprovalNote,
  effectiveApproveAbove,
  estimateCostUsd,
} from "@/lib/billing/approval-threshold";

import { getBillingConfig } from "./config";
import { getEntitlements } from "./entitlements";

// Onay eşiğinin sunucu tarafı (Faz 3C): bir görev planlanırken, SİSTEMİN başlattığı ve
// ücretli işin tahmini maliyetini eşikle birlikte approval-policy'ye verir. Hiçbir
// koşulda fırlatmaz: tahmin edilemezse eşik uygulanmaz (görev eskisi gibi yürür).
//
// Yalnız `enforce` modunda: gölge/kapalıyken görevlerin onay davranışı DEĞİŞMEZ.

export type CostApprovalContext = {
  estimatedCostUsd?: number;
  approveAboveUsd?: number;
  // Eşik aşıldıysa onay kartında gösterilecek cümle.
  note?: string;
};

export async function costApprovalContext(input: {
  workspaceId: string;
  projectId: string;
  capability: CapabilityKey;
  payload: unknown;
  createdByType: ActorType;
}): Promise<CostApprovalContext> {
  if (input.createdByType !== "SYSTEM" && input.createdByType !== "AI") {
    return {};
  }
  if (getBillingConfig().mode !== "enforce") return {};
  try {
    // Lazy: işi ölçmek yürütme sağlayıcılarını yükler (park.ts ile aynı gerekçe).
    const { usageNeedOf } = await import("@/server/execution/usage-need");
    const need = usageNeedOf(input.capability, input.payload);
    if (!need) return {};

    const entitlements = await getEntitlements(input.workspaceId);
    if (entitlements.unlimited || !entitlements.planKey) return {};

    const policy = await prisma.autonomyPolicy.findUnique({
      where: { projectId: input.projectId },
      select: { approveAboveUsd: true },
    });
    const approveAboveUsd = effectiveApproveAbove(
      entitlements.planKey,
      policy?.approveAboveUsd,
    );
    const estimatedCostUsd = estimateCostUsd(need);
    return {
      estimatedCostUsd,
      approveAboveUsd,
      note:
        estimatedCostUsd > approveAboveUsd ? costApprovalNote(need) : undefined,
    };
  } catch (error) {
    console.error(
      "[billing] could not size a task for the approval threshold:",
      error instanceof Error ? error.name : error,
    );
    return {};
  }
}
