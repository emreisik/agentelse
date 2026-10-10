// Canlıya geçmeden önce: TEST modunda (sk_test anahtarıyla) bağlanmış abonelikleri emekli eder
// (docs/billing-rollout.md adım 3). Test sürecinde herhangi biri test kartıyla (4242 ...) plan
// almış olabilir; BILLING_MODE=enforce açıldığında o satırlar ödenmiş süre bitene dek GERÇEK
// erişim verirdi (yıllık planda bir yıla kadar). Bu betik onları iptal edilmiş sayar ve ödenmiş
// süreyi şimdiye çeker; canlı ödeme yapan workspace'e dokunulmaz (stripeLivemode = true).
//
//   npm run billing:retire-test-subscriptions            -> kuru çalışma: yalnız listeler
//   npm run billing:retire-test-subscriptions -- --apply -> yazar
//
// SIRA: önce canlı anahtara geçin (test anahtarı hâlâ çalışırken emekli edilen satır, yeniden
// gönderilen bir olayla canlanabilir), sonra bunu çalıştırın, sonra BILLING_MODE=enforce.
// Betik Stripe'a hiç gitmez (yalnız veritabanına yazar); test müşterilerini Stripe panelinden
// silmek isteğe bağlıdır. Tekrar çalıştırmak güvenlidir.
//
// Mantık src/server/billing/retire-test-subscriptions.ts'te (testli); burası komut satırıdır.

import { existsSync } from "node:fs";

if (existsSync(".env")) process.loadEnvFile(".env");

import { PrismaClient } from "@prisma/client";

import {
  describeDatabase,
  parseLegacyBefore,
  planRetirement,
  retireCandidates,
} from "../src/server/billing/retire-test-subscriptions";

const prisma = new PrismaClient();
const apply = process.argv.includes("--apply");

async function main() {
  const now = new Date();
  const legacyBefore = parseLegacyBefore(process.env.BILLING_LEGACY_BEFORE);
  console.log(
    `Veritabanı: ${describeDatabase(process.env.DATABASE_URL)} (kimlik bilgisi gösterilmez). ${apply ? "YAZACAK" : "Kuru çalışma"}.`,
  );
  if (!legacyBefore) {
    console.log(
      "Uyarı: BILLING_LEGACY_BEFORE okunamadı; eski müşteri (LEGACY) işareti gösterilemez.",
    );
  }

  const plan = await planRetirement(prisma, { now, legacyBefore });
  console.log(
    `TEST modunda bağlanmış abonelik: ${plan.total} (hâlâ erişim verenler: ${plan.active.length}).`,
  );
  for (const row of plan.active) {
    console.log(
      `- ${row.workspaceId} · ${row.planKey ?? "-"}/${row.interval ?? "-"} · ${row.status} · ödenmiş süre ${row.paidThrough?.toISOString() ?? "-"}${row.wasLegacy ? " · ESKİ MÜŞTERİ" : ""}${row.extraLeft > 0 ? ` · test kartıyla alınmış ek hak kaldı: ${row.extraLeft}` : ""}`,
    );
  }
  const legacy = plan.active.filter((row) => row.wasLegacy);
  if (legacy.length > 0) {
    console.log(
      `\n${legacy.length} workspace BILLING_LEGACY_BEFORE'dan önce açılmış: satırsız kalsalardı mevcut müşteri (sınırsız) sayılırlardı; emekli edilirse İPTAL EDİLMİŞ (salt-okunur) olurlar. İstemiyorsanız önce o workspace'in Subscription satırını elle silin (silinen satır listeden düşer), sonra --apply çalıştırın.`,
    );
  }
  const withExtra = plan.active.filter((row) => row.extraLeft > 0);
  if (withExtra.length > 0) {
    console.log(
      `\n${withExtra.length} workspace test kartıyla alınmış ek paket hakkı taşıyor (süresiz, emekli edilince silinmez); canlıda plan alınınca harcanabilir hâle gelir. İstemiyorsanız hakkı elle geri alın.`,
    );
  }

  if (!apply) {
    console.log(
      "\nKuru çalışma: hiçbir şey yazılmadı. Yazmak için --apply ekle.",
    );
    return;
  }

  const written = await retireCandidates(prisma, plan.active, now);
  console.log(`\nEmekli edilen satır: ${written}.`);
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
