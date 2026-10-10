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
  // Görev ücretli iş ama BOYUTLANAMADI (okuma hatası, hak durumu okunamadı): "eşiğin
  // altında" demek değildir. Yeni görevde eşik uygulanmaz (eskisi gibi yürür); ama zaten
  // maliyet için işaretlenmiş bir plan düğümü bu belirsizlikle serbest bırakılmaz
  // (WorkPlanProgressor.dispatchReadyTasks).
  unknown?: boolean;
};

// Bu çalışma alanı + proje için "bundan büyük otomatik iş sorulur" eşiği (USD); plan
// yoksa ya da sınırsızsa null (eşik uygulanmaz).
async function approveAboveFor(
  workspaceId: string,
  projectId: string,
): Promise<number | null> {
  const entitlements = await getEntitlements(workspaceId);
  // Hak durumu okunamadı: "plan yok" ile karışmasın (çağıran bunu "bilinmiyor" sayar).
  if (entitlements.reason === "DEGRADED") {
    throw new Error("entitlements could not be read");
  }
  if (entitlements.unlimited || !entitlements.planKey) return null;

  const policy = await prisma.autonomyPolicy.findUnique({
    where: { projectId },
    select: { approveAboveUsd: true },
  });
  return effectiveApproveAbove(entitlements.planKey, policy?.approveAboveUsd);
}

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
  let need: ReturnType<
    typeof import("@/server/execution/usage-need").usageNeedOf
  > = null;
  try {
    // Lazy: işi ölçmek yürütme sağlayıcılarını yükler (park.ts ile aynı gerekçe).
    const { usageNeedOf } = await import("@/server/execution/usage-need");
    need = usageNeedOf(input.capability, input.payload);
    if (!need) return {};

    const approveAboveUsd = await approveAboveFor(
      input.workspaceId,
      input.projectId,
    );
    if (approveAboveUsd === null) return {};
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
    return {
      unknown: true,
      // Zaten işaretli bir düğüm sorulacaksa kartta yazılacak cümle (ilk işaretlemedeki aynı).
      ...(need ? { note: costApprovalNote(need) } : {}),
    };
  }
}

// Bekleyen onayların "neden soruluyorsun" cümleleri (karar tepsisi). Planlama anında
// karta yazılan cümle hiçbir yerde saklanmaz; görevin tipinden/yükünden ve GÜNCEL
// plandan yeniden hesaplanır (aynı girdi, aynı cümle). Eşik bir projenin tüm görevleri
// için bir kez okunur. HİÇ fırlatmaz.
export async function costApprovalNotes(input: {
  workspaceId: string;
  projectId: string;
  tasks: ReadonlyArray<{
    id: string;
    capability: CapabilityKey;
    payload: unknown;
    createdByType: ActorType;
  }>;
}): Promise<Map<string, string>> {
  const notes = new Map<string, string>();
  if (getBillingConfig().mode !== "enforce") return notes;
  try {
    const { usageNeedOf } = await import("@/server/execution/usage-need");
    const sized = input.tasks.flatMap((task) => {
      if (task.createdByType !== "SYSTEM" && task.createdByType !== "AI") {
        return [];
      }
      const need = usageNeedOf(task.capability, task.payload);
      return need ? [{ id: task.id, need }] : [];
    });
    if (sized.length === 0) return notes;

    const approveAboveUsd = await approveAboveFor(
      input.workspaceId,
      input.projectId,
    );
    if (approveAboveUsd === null) return notes;
    for (const { id, need } of sized) {
      if (estimateCostUsd(need) > approveAboveUsd) {
        notes.set(id, costApprovalNote(need));
      }
    }
  } catch (error) {
    console.error(
      "[billing] could not explain the pending approvals:",
      error instanceof Error ? error.name : error,
    );
  }
  return notes;
}
