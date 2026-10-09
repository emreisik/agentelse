// Canlıya geçmeden önce: TEST modunda (sk_test anahtarıyla) bağlanmış abonelikleri emekli eder
// (docs/billing-rollout.md adım 3). Test sürecinde herhangi biri test kartıyla (4242 ...) plan
// almış olabilir; BILLING_MODE=enforce açıldığında o satırlar ödenmiş süre bitene dek GERÇEK
// erişim verirdi (yıllık planda bir yıla kadar). Bu betik onları iptal edilmiş sayar ve ödenmiş
// süreyi şimdiye çeker; canlı ödeme yapan workspace'e dokunulmaz (stripeLivemode = true).
//
//   npm run billing:retire-test-subscriptions            -> kuru çalışma: yalnız listeler
//   npm run billing:retire-test-subscriptions -- --apply -> yazar
//
// Tekrar çalıştırmak güvenlidir: zaten emekli edilmiş (CANCELED, ödenmiş süresi geçmiş) satıra
// dokunulmaz. Stripe'a hiç gitmez; test müşterilerini Stripe panelinden silmek isteğe bağlıdır.

import { existsSync } from "node:fs";

if (existsSync(".env")) process.loadEnvFile(".env");

import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();
const apply = process.argv.includes("--apply");

async function main() {
  const now = new Date();
  const rows = await prisma.subscription.findMany({
    where: { stripeLivemode: false, stripeSubscriptionId: { not: null } },
    select: {
      workspaceId: true,
      planKey: true,
      interval: true,
      status: true,
      paidThrough: true,
    },
    orderBy: { paidThrough: "desc" },
  });
  const active = rows.filter(
    (row) =>
      row.status !== "CANCELED" ||
      (row.paidThrough !== null && row.paidThrough.getTime() > now.getTime()),
  );

  console.log(
    `TEST modunda bağlanmış abonelik: ${rows.length} (hâlâ erişim verenler: ${active.length}).`,
  );
  for (const row of active) {
    console.log(
      `- ${row.workspaceId} · ${row.planKey ?? "-"}/${row.interval ?? "-"} · ${row.status} · ödenmiş süre ${row.paidThrough?.toISOString() ?? "-"}`,
    );
  }

  if (!apply) {
    console.log(
      "\nKuru çalışma: hiçbir şey yazılmadı. Yazmak için --apply ekle.",
    );
    return;
  }

  let written = 0;
  for (const row of active) {
    const result = await prisma.subscription.updateMany({
      where: { workspaceId: row.workspaceId, stripeLivemode: false },
      data: {
        status: "CANCELED",
        endedAt: now,
        endedReason: "CANCELED",
        paidThrough: now,
        graceUntil: null,
        cancelAtPeriodEnd: false,
        pendingPlanKey: null,
        pendingInterval: null,
        pendingEffectiveAt: null,
      },
    });
    written += result.count;
  }
  console.log(`\nEmekli edilen satır: ${written}.`);
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
