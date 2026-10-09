import "server-only";

import { prisma } from "@/lib/prisma";

import { initiatorOfActor } from "./usage-context";

// Bir görevin faturalama etiketi (Faz 3C): görevi kim yarattıysa o başlatmıştır
// (usage-context.ts initiatorOfActor). Tek istisna: sistemin yarattığı bir görevi bir
// insan açıkça ONAYLADIYSA o artık kullanıcının isteğidir. Kullanıcı "çalışsın" dediği
// işi kendi payından ödemiş olur ve sistemin arka plan payına takılıp "hakkın bitti"
// görünüp park edilmez. Kayıt zaten vardır (Approval, karar veren kişi dolu), şemaya
// yeni alan eklenmez.
//
// Yalnız görevin KENDİSİ hakkındaki onay sayılır (entityType "Task"): bir üretimi
// onaylamak (Creative onayı, çıktının onayı) işin kimin sayıldığını değiştirmez.

export async function approvedByPerson(
  taskIds: readonly string[],
): Promise<Set<string>> {
  if (taskIds.length === 0) return new Set();
  const rows = await prisma.approval.findMany({
    where: {
      taskId: { in: [...taskIds] },
      entityType: "Task",
      status: "APPROVED",
      reviewedByUserId: { not: null },
    },
    select: { taskId: true },
  });
  return new Set(
    rows.flatMap((row) => (row.taskId === null ? [] : [row.taskId])),
  );
}

export async function initiatorOfTask(task: {
  id: string;
  createdByType: string;
}): Promise<"user" | "system"> {
  if (initiatorOfActor(task.createdByType) === "user") return "user";
  return (await approvedByPerson([task.id])).has(task.id) ? "user" : "system";
}
