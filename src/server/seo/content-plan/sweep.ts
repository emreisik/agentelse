import "server-only";

import type { Prisma } from "@prisma/client";

import { prisma } from "@/lib/prisma";

import { ideaStatusOf, rawSlotsOf } from "./forget";
import { archiveSlotPiecesInTx, monthRangeUtc } from "./pieces";

// Önceki ayların dokunulmamış slotları (docs/search-content-plan.md "Plan
// nasıl kurulur" 1): runner yeni ay için plan kurmadan önce bunları süpürür.
// Dokunulmamış = DRAFT, sürümsüz, planId'siz ve planlı günü içinde bulunulan
// ayın başından önce. Creative + Post arşivlenir, havuzdan alınmış fikir
// önceki durumuna döner, plana ait fikir ARCHIVED olur, slot REMOVED işaretlenir.
// Anahtar kelime plan.rejected'a EKLENMEZ (yeniden planlanabilir; inputs.ts
// yalnız Creative'i hâlâ arşivlenmemiş eski slotları "var" sayar). Yazılmış ya
// da kartla bağlanmış parçaya dokunulmaz. Süpürme idempotenttir.

export type SweepInput = {
  linkId: string;
  projectId: string;
  // Projenin yerel ayı: "2026-10"
  currentMonth: string;
  timezone: string;
  now: Date;
};

const GONE_STATUSES = ["ARCHIVED", "REJECTED"];

function json(value: unknown): Prisma.InputJsonValue {
  return value as Prisma.InputJsonValue;
}

export async function sweepStaleSlots(
  input: SweepInput,
): Promise<{ swept: number }> {
  const plans = await prisma.seoContentPlan.findMany({
    where: {
      linkId: input.linkId,
      projectId: input.projectId,
      status: "ACTIVE",
      month: { lt: input.currentMonth },
    },
    select: { id: true, data: true },
  });
  if (plans.length === 0) return { swept: 0 };
  const monthStart = monthRangeUtc(input.currentMonth, input.timezone).from;

  let swept = 0;
  for (const plan of plans) {
    const slots = rawSlotsOf(plan.data);
    const open = slots.filter(
      (slot) => slot.status === "PLANNED" && slot.creativeId,
    );
    if (open.length === 0) continue;

    const creatives = await prisma.creative.findMany({
      where: {
        projectId: input.projectId,
        id: { in: open.map((slot) => slot.creativeId as string) },
      },
      select: {
        id: true,
        status: true,
        planId: true,
        scheduledFor: true,
        versions: { select: { id: true }, take: 1 },
      },
    });
    const byId = new Map(creatives.map((row) => [row.id, row] as const));

    // Süpürülecekler: parçası artık yok ya da zaten arşivde/reddedilmiş (fikir
    // PLANNING'de kalmasın) ya da dokunulmamış ve geçmiş ayda.
    const stale = open.filter((slot) => {
      const creative = byId.get(slot.creativeId as string);
      if (!creative || GONE_STATUSES.includes(creative.status)) return true;
      return (
        creative.status === "DRAFT" &&
        creative.planId === null &&
        creative.versions.length === 0 &&
        creative.scheduledFor !== null &&
        creative.scheduledFor < monthStart
      );
    });
    if (stale.length === 0) continue;

    swept += await prisma.$transaction(async (tx) => {
      const live = stale.filter((slot) => {
        const creative = byId.get(slot.creativeId as string);
        return creative?.status === "DRAFT";
      });
      const { archived } = await archiveSlotPiecesInTx(
        tx,
        input.projectId,
        live.map((slot) => ({
          creativeId: slot.creativeId as string,
          postId: slot.postId ?? "",
        })),
        input.now,
      );
      const archivedIds = new Set(archived);
      // Arşivlenemeyen (bu arada dokunulan) parça süpürülmez.
      const removed = stale.filter((slot) => {
        const creative = byId.get(slot.creativeId as string);
        return (
          !creative ||
          creative.status !== "DRAFT" ||
          archivedIds.has(slot.creativeId as string)
        );
      });
      if (removed.length === 0) return 0;

      for (const slot of removed) {
        if (!slot.ideaId) continue;
        const previous = ideaStatusOf(slot.prevIdeaStatus);
        // Önceki durumu bilinmeyen havuz fikri arşivlenmez (kullanıcının fikri).
        if (slot.reusedIdea && !previous) continue;
        // IDEA_TRANSITIONS'ı bilerek atlar (PLANNING'den geri dönüş ya da
        // arşiv); yalnız hâlâ PLANNING olan fikre dokunur.
        await tx.idea.updateMany({
          where: {
            id: slot.ideaId,
            projectId: input.projectId,
            status: "PLANNING",
          },
          data: {
            status: slot.reusedIdea && previous ? previous : "ARCHIVED",
          },
        });
      }

      const removedIds = new Set(removed.map((slot) => slot.creativeId));
      const data = plan.data as Record<string, unknown>;
      const nextSlots = (Array.isArray(data.slots) ? data.slots : []).map(
        (item: unknown) => {
          const slot = item as Record<string, unknown> | null;
          return slot &&
            typeof slot.creativeId === "string" &&
            removedIds.has(slot.creativeId) &&
            slot.status === "PLANNED"
            ? { ...slot, status: "REMOVED" }
            : item;
        },
      );
      await tx.seoContentPlan.update({
        where: { id: plan.id },
        data: { data: json({ ...data, slots: nextSlots }) },
      });
      return removed.length;
    });
  }
  return { swept };
}
