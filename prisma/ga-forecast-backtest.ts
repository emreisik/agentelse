// GA ay sonu tahmininin geriye dönük sınaması: SALT OKUNUR (docs/website-reports.md
// "Tahmin"). Hiçbir satırı değiştirmez, Google'a gitmez.
//
//   npx tsx prisma/ga-forecast-backtest.ts <projectId>
//   npm run db:report:ga-forecast <projectId>
//
// Projenin birincil GA bağının son 400 günlük GaDailyTotal verisinden, son 6
// tam ayın 10'unda ve 20'sinde yapılan tahmini ay sonu gerçeğiyle karşılaştırır.
// ≤ %20 hedefi sahibin mülkünde doğrulanmalı: sentetik testler yalnız formülü
// sınar. Çıktı YALNIZ ay anahtarlarını, kontrol noktalarını ve hata yüzdelerini
// yazar; metrik değerleri, sayfa yolları ya da Google metinleri basılmaz.
// Şüpheli günler GaHealthRun.suspectDays'ten gelir (tatiller hariç tutulmaz:
// betik ülke takvimine bakmaz, sonuç biraz kötümser olabilir).

import { existsSync } from "node:fs";

if (existsSync(".env")) process.loadEnvFile(".env");

import { PrismaClient } from "@prisma/client";

import type { GaAnalysisDay } from "../src/lib/website-analytics/analysis/types";
import { addDays, dateToDayKey } from "../src/lib/website-analytics/days";
import { backtestForecast } from "../src/lib/website-analytics/reports/forecast";
import type { ForecastMetric } from "../src/lib/website-analytics/reports/types";

const prisma = new PrismaClient();
const HISTORY_DAYS = 400;
const TARGET_PCT = 20;
const METRICS: { metric: ForecastMetric; label: string }[] = [
  { metric: "sessions", label: "sessions" },
  { metric: "keyEvents", label: "keyEvents" },
];

function heading(title: string) {
  console.log(`\n## ${title}`);
}

// Şüpheli günler { "YYYY-MM-DD": [...] } sözlüğünün anahtarlarıdır.
function suspectDaysOf(value: unknown): Set<string> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return new Set();
  }
  return new Set(
    Object.keys(value).filter((key) => /^\d{4}-\d{2}-\d{2}$/.test(key)),
  );
}

async function main() {
  const projectId = process.argv[2];
  if (!projectId) {
    console.error("Kullanım: npx tsx prisma/ga-forecast-backtest.ts <projectId>");
    process.exitCode = 1;
    return;
  }

  const link = await prisma.gaPropertyLink.findFirst({
    where: { projectId, isPrimary: true },
    select: { id: true, isMock: true },
  });
  if (!link) {
    console.log("Bu proje için birincil GA bağı yok.");
    return;
  }

  const latest = await prisma.gaDailyTotal.findFirst({
    where: { linkId: link.id },
    orderBy: { date: "desc" },
    select: { date: true },
  });
  if (!latest) {
    console.log("Ambarda günlük toplam yok.");
    return;
  }
  const through = dateToDayKey(latest.date);
  const since = addDays(through, -(HISTORY_DAYS - 1));
  const rows = await prisma.gaDailyTotal.findMany({
    where: { linkId: link.id, date: { gte: new Date(`${since}T00:00:00.000Z`) } },
    orderBy: { date: "asc" },
    select: {
      date: true,
      sessions: true,
      engagedSessions: true,
      keyEvents: true,
      revenueMicros: true,
      transactions: true,
      isFinal: true,
    },
  });
  const days: GaAnalysisDay[] = rows.map((row) => ({
    day: dateToDayKey(row.date),
    sessions: row.sessions,
    engagedSessions: row.engagedSessions,
    keyEvents: row.keyEvents,
    revenue: Number(row.revenueMicros) / 1e6,
    transactions: row.transactions,
    isFinal: row.isFinal,
  }));
  const health = await prisma.gaHealthRun.findUnique({
    where: { linkId: link.id },
    select: { suspectDays: true },
  });
  const exclude = suspectDaysOf(health?.suspectDays);

  console.log(`# GA tahmin geriye dönük sınaması · ${new Date().toISOString()}`);
  console.log(
    `Gün sayısı: ${days.length} · şüpheli gün: ${exclude.size}${link.isMock ? " · DEMO bağı" : ""}`,
  );

  for (const { metric, label } of METRICS) {
    heading(label);
    const result = backtestForecast({ days, metric, exclude });
    if (result.rows.length === 0) {
      console.log("Yeterli tam ay yok (en az 56 gün geçmiş ve tam aylar gerekir).");
      continue;
    }
    for (const row of result.rows) {
      console.log(`- ${row.month} · ${row.checkpoint}. gün: hata %${row.errorPct}`);
    }
    const mean = result.meanAbsErrorPct;
    const verdict =
      mean === null
        ? "-"
        : mean <= TARGET_PCT
          ? `hedef içinde (≤ %${TARGET_PCT})`
          : `hedef AŞILDI (> %${TARGET_PCT})`;
    console.log(`Ortalama mutlak hata: %${mean ?? "-"} · ${verdict}`);
  }
  console.log("\nNot: Bu rapor hiçbir şeyi değiştirmedi.");
}

main()
  .catch((error: unknown) => {
    // Hata iletisi Google ya da kullanıcı metni taşıyabilir: yalnız ad.
    console.error(error instanceof Error ? error.name : "Error");
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
