import "server-only";

import type { UsageUnit } from "@/lib/billing/plans";
import { prisma } from "@/lib/prisma";

import { getBillingConfig } from "./config";
import { settleUsage } from "./ledger";

// Çökme uzlaştırıcısı. Operasyonun mahsup niyeti süreç belleğindedir; teslim
// edilmiş bir işin sürecinin `finish`'ten önce ölmesi (deploy, OOM) rezervasyonu
// açık bırakır. Süpürücü süresi dolanı körlemesine iade ederdi; bu adım ÖNCE
// bakar: iş COMPLETED/VERIFYING ise teslim edilmiştir, mahsup edilir (görsel:
// rezerve edilen adet, AI: o işe ait ölçülen maliyet, en çok rezervasyon kadar).
// Başarısız ya da hiç bitmemiş iş süpürücünün iadesine kalır.
//
// Yalnız yürütme işlerinin (`exec:<jobId>`) rezervasyonlarını görür: onların
// teslim durumu veritabanında yazılıdır.

const DELIVERED = ["COMPLETED", "VERIFYING"] as const;

export async function settleDeliveredOrphans(
  options: { now?: Date; limit?: number } = {},
): Promise<number> {
  if (getBillingConfig().mode === "off") return 0;
  const now = options.now ?? new Date();

  const expired = await prisma.usageReservation.findMany({
    where: {
      status: "RESERVED",
      expiresAt: { lte: now },
      operationId: { startsWith: "exec:" },
    },
    orderBy: { expiresAt: "asc" },
    take: options.limit ?? 100,
    select: {
      workspaceId: true,
      unit: true,
      reservationKey: true,
      operationId: true,
      amount: true,
    },
  });
  if (expired.length === 0) return 0;

  const jobs = await prisma.executionJob.findMany({
    where: {
      id: { in: [...new Set(expired.map((row) => row.operationId!.slice(5)))] },
      status: { in: [...DELIVERED] },
    },
    select: { id: true },
  });
  const delivered = new Set(jobs.map((job) => job.id));

  let settled = 0;
  for (const row of expired) {
    const operationId = row.operationId!;
    if (!delivered.has(operationId.slice(5))) continue;

    let actual = row.amount;
    if (row.unit !== "IMAGE") {
      const metered = await prisma.usageEntry.aggregate({
        where: { workspaceId: row.workspaceId, operationId },
        _sum: { costMicros: true },
      });
      const cost = metered._sum.costMicros ?? BigInt(0);
      actual = cost < row.amount ? cost : row.amount;
    }
    const result = await settleUsage(
      {
        workspaceId: row.workspaceId,
        unit: row.unit as UsageUnit,
        reservationKey: row.reservationKey,
      },
      actual,
    );
    if (result.status === "SETTLED") settled += 1;
  }
  return settled;
}
