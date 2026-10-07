import "server-only";

import { Prisma } from "@prisma/client";

import { prisma } from "@/lib/prisma";
import { ReportShares } from "@/server/report-share/store";

// GA-F8: WEBSITE paylaşım satırlarının silinmesi. ReportShare tablosunda dış
// anahtar yoktur (SC-F9), bu yüzden mülk/proje/kart silinince satırlar buradan
// elle gider. Bayrağa BAĞLI DEĞİLDİR (gizlilik: bayrak kapansa da silme
// çalışır), asla fırlatmaz, hata olursa 0 döner ve yalnız hata adını yazar.

function failure(what: string, error: unknown): number {
  const name = error instanceof Error ? error.name : "UnknownError";
  console.error(`[ga-share] ${what} failed: ${name}`);
  return 0;
}

// Bağlantı kesme ya da proje verisini silme: projenin tüm WEBSITE paylaşımları.
export async function forgetWebsiteSharesForProject(
  projectId: string,
): Promise<number> {
  try {
    return await ReportShares.deleteForProject("WEBSITE", projectId);
  } catch (error) {
    return failure("forget project", error);
  }
}

// Ek mülk kaldırma ya da kart silme: yalnız bu kartların paylaşımları.
export async function forgetWebsiteSharesForReports(
  commandIds: readonly string[],
): Promise<number> {
  if (commandIds.length === 0) return 0;
  try {
    return await ReportShares.deleteForReports("WEBSITE", commandIds);
  } catch (error) {
    return failure("forget reports", error);
  }
}

const MAX_SWEEP = 5_000;

// Kartlar 400 gün yaşar, paylaşımlar en çok 90 gün: çok eski bir karttan
// yapılan paylaşım kartı geçebilir. Raporu (id = reportId ve aynı proje) artık
// olmayan ya da projesi silinmiş WEBSITE satırlarını tek sınırlı DELETE ile
// siler. Tablo adları şemada @@map olmadığı için model adlarıdır.
export async function sweepOrphanWebsiteShares(limit = 500): Promise<number> {
  const bounded = Math.min(MAX_SWEEP, Math.max(1, Math.floor(limit)));
  try {
    return await prisma.$executeRaw(Prisma.sql`
      DELETE FROM "ReportShare"
      WHERE "id" IN (
        SELECT s."id" FROM "ReportShare" s
        WHERE s."kind" = 'WEBSITE'
          AND (
            NOT EXISTS (
              SELECT 1 FROM "Command" c
              WHERE c."id" = s."reportId" AND c."projectId" = s."projectId"
            )
            OR NOT EXISTS (
              SELECT 1 FROM "Project" p WHERE p."id" = s."projectId"
            )
          )
        LIMIT ${bounded}
      )
    `);
  } catch (error) {
    return failure("orphan sweep", error);
  }
}
