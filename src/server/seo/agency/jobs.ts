import "server-only";

import { Prisma } from "@prisma/client";

import { gscAgencyOn, gscBigQueryOn } from "@/lib/seo/agency/flags";
import { gscGlobalWorkAllowedHere } from "@/lib/seo/flags";
import { prisma } from "@/lib/prisma";
import { GOOGLE_PROVIDER } from "@/server/integrations/google-client";
import { claimPeriodic } from "@/server/observability/periodic";
import { GscBigQuerySync } from "@/server/seo/agency/bq/sync";
import { GscSplitTests } from "@/server/seo/agency/split/store";

import { GscPageGroups } from "./page-groups";
import { GscSites } from "./sites";

// `gsc-agency` tick adımı (SC-F9): ek site bağlarının hizalanması, sayfa grubu
// yeniden gruplama, BigQuery içe aktarımı, bölünmüş testler ve yetim ayar
// süpürmesi. Bütün alt işler TEK bir genel son tarihi paylaşır (deadlineAt,
// epoch ms): her biri yeni birim başlatmadan önce kalan süreye bakar; son
// tarih geçince kalan adımlar atlanır. Bir adımın hatası diğerlerini durdurmaz
// (günlüğe yalnız hata adı yazılır). Bayrak kapalıyken veritabanına gidilmez.

const DEFAULT_DEADLINE_MS = 90_000;
const LINKS_EVERY_MS = 2 * 60_000;
const SWEEP_EVERY_MS = 24 * 60 * 60_000;
const SWEEP_CHUNK = 500;
const SWEEP_MAX_CHUNKS = 10;

// Geliştirme süreci (global iş yasak) bağ hizalamasını süreç içinde kısar;
// claimPeriodic'e hiç gitmez.
let devLinksAt = 0;

async function sweepChunks(build: (limit: number) => Prisma.Sql): Promise<number> {
  let total = 0;
  for (let round = 0; round < SWEEP_MAX_CHUNKS; round += 1) {
    const removed = Number(await prisma.$executeRaw(build(SWEEP_CHUNK)));
    total += removed;
    if (removed < SWEEP_CHUNK) break;
  }
  return total;
}

// Proje ya da workspace'i silinmiş ayar/kaynak/paylaşım satırları ve bağı da
// ACTIVE|EXPIRED bağlantısı da kalmamış projelerin ayarları (Disconnect'i
// atlayan yollar: proje silme, yarım kalan temizlik). NOT EXISTS ile, parça
// parça silinir. Rapor paylaşımı saklaması bu adımda DEĞİLDİR (kendi adımı).
async function sweepOrphans(): Promise<number> {
  const provider = GOOGLE_PROVIDER.search_console;
  const noProject = (table: Prisma.Sql) => (limit: number) => Prisma.sql`
    DELETE FROM ${table} WHERE "id" IN (
      SELECT t."id" FROM ${table} t
       WHERE NOT EXISTS (SELECT 1 FROM "Project" p WHERE p."id" = t."projectId")
       LIMIT ${limit}
    )`;
  const noConnection = (table: Prisma.Sql) => (limit: number) => Prisma.sql`
    DELETE FROM ${table} WHERE "id" IN (
      SELECT t."id" FROM ${table} t
       WHERE NOT EXISTS (SELECT 1 FROM "GscSiteLink" l WHERE l."projectId" = t."projectId")
         AND NOT EXISTS (
           SELECT 1 FROM "IntegrationCredential" c
            WHERE c."projectId" = t."projectId"
              AND c."provider" = ${provider}
              AND c."status"::text IN ('ACTIVE', 'EXPIRED')
         )
       LIMIT ${limit}
    )`;
  let total = 0;
  for (const table of ['"GscSiteSetting"', '"GscBqSource"', '"ReportShare"']) {
    total += await sweepChunks(noProject(Prisma.raw(table)));
  }
  total += await sweepChunks(
    (limit) => Prisma.sql`
      DELETE FROM "ReportBranding" WHERE "id" IN (
        SELECT t."id" FROM "ReportBranding" t
         WHERE NOT EXISTS (SELECT 1 FROM "Workspace" w WHERE w."id" = t."workspaceId")
         LIMIT ${limit}
      )`,
  );
  for (const table of ['"GscSiteSetting"', '"GscBqSource"']) {
    total += await sweepChunks(noConnection(Prisma.raw(table)));
  }
  return total;
}

async function runDue(
  now: Date = new Date(),
  options: { deadlineMs?: number } = {},
): Promise<number> {
  if (!gscAgencyOn()) return 0;
  const deadlineAt = Date.now() + (options.deadlineMs ?? DEFAULT_DEADLINE_MS);
  const global = gscGlobalWorkAllowedHere();
  let total = 0;

  const step = async (name: string, run: () => Promise<number>) => {
    if (Date.now() >= deadlineAt) return;
    try {
      total += await run();
    } catch (error) {
      console.error(
        `[gsc-agency] ${name} failed:`,
        error instanceof Error ? error.name : "error",
      );
    }
  };

  await step("links", async () => {
    if (global) {
      if (!(await claimPeriodic("gsc.agency-links", LINKS_EVERY_MS, now))) {
        return 0;
      }
    } else {
      if (Date.now() - devLinksAt < LINKS_EVERY_MS) return 0;
      devLinksAt = Date.now();
    }
    return GscSites.reconcileAll(now);
  });
  await step("page-groups", () =>
    GscPageGroups.regroupDue(2, now, deadlineAt),
  );
  if (gscBigQueryOn()) {
    await step("bigquery", () => GscBigQuerySync.runDue(3, now, deadlineAt));
  }
  await step("split-tests", () => GscSplitTests.runDue(5, now, deadlineAt));
  if (global) {
    await step("orphans", async () =>
      (await claimPeriodic("gsc.agency-retention", SWEEP_EVERY_MS, now))
        ? sweepOrphans()
        : 0,
    );
  }
  return total;
}

export const GscAgency = { runDue };
