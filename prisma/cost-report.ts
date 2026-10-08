// Gerçek AI maliyet raporu — SALT OKUNUR (~/.claude/plans/billing-usage-plan.md,
// Faz 1). Hiçbir satırı değiştirmez.
//
//   npm run db:report:cost                      son 30 gün, tüm workspace'ler
//   npm run db:report:cost -- --days 7          son 7 gün
//   npm run db:report:cost -- --workspace <id>  tek workspace
//
// Kaynak: UsageEntry (her ücretli dış çağrının gerçek kullanımı). "Tahmini"
// işaretli satırlar sağlayıcının kullanım döndürmediği ya da fiyatın liste
// tahmini olduğu çağrılardır (ör. fal.ai); gerçek maliyet değildir.
// Paket fiyatlarını bu birim maliyetlere göre doğrula, sonra kilitle.

import { existsSync } from "node:fs";

if (existsSync(".env")) process.loadEnvFile(".env");

import { Prisma, PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

function argValue(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

const days = Math.max(1, Number(argValue("days") ?? 30) || 30);
const workspaceId = argValue("workspace");
const since = new Date(Date.now() - days * 24 * 60 * 60_000);

const usd = (micros: bigint | number | null | undefined) =>
  `$${(Number(micros ?? 0) / 1_000_000).toFixed(2)}`;
const usd4 = (micros: number) => `$${(micros / 1_000_000).toFixed(4)}`;
const pct = (part: number, whole: number) =>
  whole === 0 ? "-" : `${((part / whole) * 100).toFixed(1)}%`;

function heading(title: string) {
  console.log(`\n## ${title}`);
}

const where = {
  createdAt: { gte: since },
  ...(workspaceId ? { workspaceId } : {}),
};

async function summary() {
  heading(
    `Özet (son ${days} gün${workspaceId ? `, workspace ${workspaceId}` : ""})`,
  );
  const [all, estimated, failed, unattributed] = await Promise.all([
    prisma.usageEntry.aggregate({
      where,
      _sum: { costMicros: true },
      _count: true,
    }),
    prisma.usageEntry.aggregate({
      where: { ...where, costEstimated: true, success: true },
      _sum: { costMicros: true },
      _count: true,
    }),
    prisma.usageEntry.count({ where: { ...where, success: false } }),
    prisma.usageEntry.aggregate({
      where: { ...where, workspaceId: "unattributed" },
      _sum: { costMicros: true },
      _count: true,
    }),
  ]);
  if (all._count === 0) {
    console.log(
      "Kayıt yok (ölçüm henüz çalışmıyor ya da migration uygulanmadı).",
    );
    return false;
  }
  const total = Number(all._sum.costMicros ?? 0);
  console.log(`Toplam maliyet: ${usd(total)} (${all._count} çağrı)`);
  console.log(
    `Tahmini işaretli (başarılı): ${usd(estimated._sum.costMicros)} · ${estimated._count} çağrı · maliyetin ${pct(Number(estimated._sum.costMicros ?? 0), total)}`,
  );
  console.log(
    `Başarısız çağrı: ${failed} (kullanımı bilinmediği için 0 USD yazıldı; sayı mutabakatta şüpheli ücret adayıdır)`,
  );
  console.log(
    `Kapsamı bulunamayan (unattributed): ${unattributed._count} çağrı · ${usd(unattributed._sum.costMicros)} — sıfır olmalı; değilse aşağıdaki listeye bak`,
  );
  return true;
}

async function group(title: string, by: "module" | "provider" | "kind") {
  heading(title);
  const rows = await prisma.usageEntry.groupBy({
    by: [by],
    where,
    _sum: { costMicros: true },
    _count: true,
    orderBy: { _sum: { costMicros: "desc" } },
  });
  for (const row of rows) {
    console.log(
      `- ${String(row[by] ?? "(boş)")}: ${usd(row._sum.costMicros)} · ${row._count} çağrı`,
    );
  }
}

async function topPurposes() {
  heading("En pahalı 15 amaç (purpose)");
  const rows = await prisma.usageEntry.groupBy({
    by: ["purpose", "kind"],
    where,
    _sum: { costMicros: true },
    _count: true,
    orderBy: { _sum: { costMicros: "desc" } },
    take: 15,
  });
  for (const row of rows) {
    const total = Number(row._sum.costMicros ?? 0);
    console.log(
      `- ${row.purpose} [${row.kind}]: ${usd(total)} · ${row._count} çağrı · çağrı başına ${usd4(total / row._count)}`,
    );
  }
}

async function images() {
  heading("Görsel birim maliyeti (başarılı üretimler)");
  const rows = await prisma.usageEntry.groupBy({
    by: ["provider", "model", "costEstimated"],
    where: { ...where, kind: "IMAGE", success: true },
    _sum: { costMicros: true, units: true },
    _count: true,
    orderBy: { _sum: { costMicros: "desc" } },
  });
  if (rows.length === 0) {
    console.log("Görsel kaydı yok.");
    return;
  }
  for (const row of rows) {
    const total = Number(row._sum.costMicros ?? 0);
    console.log(
      `- ${row.provider} · ${row.model}${row.costEstimated ? " (tahmini)" : ""}: ${row._count} görsel · ${usd(total)} · görsel başına ${usd4(total / row._count)}`,
    );
  }
  const imageAll = rows.reduce((sum, row) => sum + row._count, 0);
  const imageCost = rows.reduce(
    (sum, row) => sum + Number(row._sum.costMicros ?? 0),
    0,
  );
  console.log(
    `Ortalama görsel maliyeti: ${usd4(imageCost / imageAll)} (plan varsayımı: $0.1500)`,
  );
}

async function chatPerMessage() {
  heading("Sohbet");
  const workspaceFilter = workspaceId
    ? Prisma.sql`AND "workspaceId" = ${workspaceId}`
    : Prisma.empty;
  const rows = await prisma.$queryRaw<
    Array<{ messages: bigint; cost: bigint | null }>
  >(Prisma.sql`SELECT COUNT(DISTINCT "operationId") AS messages, SUM("costMicros") AS cost
    FROM "UsageEntry"
    WHERE "purpose" = 'chat.turn' AND "createdAt" >= ${since} ${workspaceFilter}`);
  const row = rows[0];
  const messages = Number(row?.messages ?? 0);
  if (!row || messages === 0) {
    console.log("Sohbet kaydı yok.");
    return;
  }
  const cost = Number(row.cost ?? 0);
  console.log(
    `${messages} mesaj · ${usd(cost)} · mesaj başına ${usd4(cost / messages)} (plan varsayımı: ~$0.10)`,
  );
}

async function byWorkspace() {
  heading("Workspace bazında (en çok harcayan 20)");
  const rows = await prisma.usageEntry.groupBy({
    by: ["workspaceId"],
    where,
    _sum: { costMicros: true },
    _count: true,
    orderBy: { _sum: { costMicros: "desc" } },
    take: 20,
  });
  for (const row of rows) {
    const [imageCount, imageCost] = await Promise.all([
      prisma.usageEntry.count({
        where: {
          ...where,
          workspaceId: row.workspaceId,
          kind: "IMAGE",
          success: true,
        },
      }),
      prisma.usageEntry.aggregate({
        where: {
          ...where,
          workspaceId: row.workspaceId,
          kind: "IMAGE",
          success: true,
        },
        _sum: { costMicros: true },
      }),
    ]);
    const total = Number(row._sum.costMicros ?? 0);
    console.log(
      `- ${row.workspaceId}: ${usd(total)} (aylığa çevrilmiş ≈ ${usd((total / days) * 30)}) · ${row._count} çağrı · ${imageCount} görsel ${usd(imageCost._sum.costMicros)}`,
    );
  }
}

async function unattributedPurposes() {
  const rows = await prisma.usageEntry.groupBy({
    by: ["purpose", "source"],
    where: { ...where, workspaceId: "unattributed" },
    _sum: { costMicros: true },
    _count: true,
    orderBy: { _count: { purpose: "desc" } },
    take: 15,
  });
  if (rows.length === 0) return;
  heading("Kapsamı bulunamayan çağrılar (eksik giriş noktaları)");
  for (const row of rows) {
    console.log(
      `- ${row.purpose} (${row.source ?? "kaynak yok"}): ${row._count} çağrı · ${usd(row._sum.costMicros)}`,
    );
  }
}

async function main() {
  const hasData = await summary();
  if (!hasData) return;
  await group("Modül bazında", "module");
  await group("Sağlayıcı bazında", "provider");
  await group("Tür bazında", "kind");
  await topPurposes();
  await images();
  await chatPerMessage();
  await byWorkspace();
  await unattributedPurposes();
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
