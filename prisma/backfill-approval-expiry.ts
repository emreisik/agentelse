// Bekleyen Meta harcama onaylarına süre yazar (docs/meta-ads-plan.md F0b).
// Yeni onaylar 72 saatlik süreyle açılır (TaskPlanner.requestApproval); bu
// betik daha önce açılmış, süresi boş (expiresAt = null) olanlara
// createdAt + 72 saat yazar. Süresi geçmiş olanları işçinin expireOverdue
// adımı EXPIRED yapar ve görevlerini "Approval expired" ile kapatır.
//
//   npm run db:backfill:approval-expiry            -> kuru çalışma: yalnız sayar
//   npm run db:backfill:approval-expiry -- --apply -> yazar
//
// Tekrar çalıştırmak güvenlidir: süresi dolu olan satıra dokunulmaz.

import { existsSync } from "node:fs";

if (existsSync(".env")) process.loadEnvFile(".env");

import { PrismaClient } from "@prisma/client";

import { isMetaSpendWrite } from "../src/lib/execution-backlog";

const prisma = new PrismaClient();
const TTL_MS = 72 * 60 * 60_000;
const apply = process.argv.includes("--apply");

async function main() {
  const pending = await prisma.approval.findMany({
    where: { status: "PENDING", expiresAt: null, taskId: { not: null } },
    select: {
      id: true,
      createdAt: true,
      task: { select: { capability: true, title: true } },
    },
  });
  const targets = pending.filter(
    (row) => row.task && isMetaSpendWrite(row.task.capability),
  );
  const now = Date.now();
  const alreadyOver = targets.filter(
    (row) => row.createdAt.getTime() + TTL_MS < now,
  ).length;

  console.log(
    `Süresiz bekleyen Meta onayı: ${targets.length} (72 saati çoktan geçmiş: ${alreadyOver}).`,
  );
  for (const row of targets) {
    console.log(
      `- ${row.task?.capability} "${row.task?.title}" · açıldı ${row.createdAt.toISOString()}`,
    );
  }

  if (!apply) {
    console.log("\nKuru çalışma: hiçbir şey yazılmadı. Yazmak için --apply ekle.");
    return;
  }

  let written = 0;
  for (const row of targets) {
    const result = await prisma.approval.updateMany({
      where: { id: row.id, status: "PENDING", expiresAt: null },
      data: { expiresAt: new Date(row.createdAt.getTime() + TTL_MS) },
    });
    written += result.count;
  }
  console.log(`\n${written} onaya süre yazıldı.`);
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
