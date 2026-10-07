import "server-only";

import { Prisma } from "@prisma/client";

import { prisma } from "@/lib/prisma";
import { GOOGLE_PROVIDER } from "@/server/integrations/google-client";
import { ReportShares } from "@/server/report-share/store";

// SC-F9 verisinin unutulması. Bayraktan BAĞIMSIZDIR (bayrak kapansa da silme
// çalışır) ve asla fırlatmaz: her adım ayrı try/catch, günlüğe yalnız hata adı
// yazılır. İki yol var:
//  - "Delete stored data": müşterinin kendi yazdığı ayarlar (kurallar, ek site
//    üyeliği, BigQuery proje/veri kümesi/sınırlar) kalır; Google'dan türeyen
//    her şey (paylaşılan rapor bağlantıları, uygulanan grup durumu, BigQuery
//    mutabakat/kapsam/doğrulama alanları) silinir ya da sıfırlanır.
//  - Disconnect: projenin bütün ajans ayarı bağ satırları çoktan gitmiş olsa
//    bile PROJE kimliğiyle silinir (bağ satırına dayanmaz).

function logFailure(scope: string, error: unknown): void {
  console.error(
    `[gsc-agency-forget] ${scope} failed:`,
    error instanceof Error ? error.name : "error",
  );
}

const REPORT_ID_CAP = 10_000;

// Bağlar silinmeden ÖNCE çağrılır (deleteGscDataForProject).
export async function forgetAgencyForProjectMode(
  projectId: string,
  isMock: boolean,
): Promise<void> {
  try {
    const reports = await prisma.seoReport.findMany({
      where: { projectId, isMock },
      select: { id: true },
      take: REPORT_ID_CAP,
    });
    if (reports.length > 0) {
      await ReportShares.deleteForReports(
        "SEARCH",
        reports.map((report) => report.id),
      );
    }
  } catch (error) {
    logFailure("shares", error);
  }
  try {
    await prisma.gscSiteSetting.updateMany({
      where: { projectId, isMock },
      data: {
        groupsAppliedVersion: 0,
        groupsAppliedWeek: null,
        groupsCursor: null,
        groupsLeaseUntil: null,
        groupsLeaseOwner: null,
      },
    });
  } catch (error) {
    logFailure("page groups", error);
  }
  try {
    await prisma.gscBqSource.updateMany({
      where: { projectId, isMock },
      data: {
        reconcile: Prisma.DbNull,
        exportStart: null,
        exportedThrough: null,
        coverageCheckedAt: null,
        lastVerifiedAt: null,
        lastSyncAt: null,
        lastError: null,
        consecutiveFailures: 0,
        nextRunAt: null,
        leaseUntil: null,
        leaseOwner: null,
        status: "DRAFT",
      },
    });
  } catch (error) {
    logFailure("bigquery", error);
  }
}

// Bağ satırları silinmeden önce çağrılır (Disconnect). Kipten bağımsız:
// projenin bütün ayar ve BigQuery kaynakları ile SEARCH paylaşımları gider;
// ReportBranding workspace düzeyindedir ve kalır.
export async function forgetAgencyForCredential(
  credentialId: string,
): Promise<{ shares: number; settings: number; bqSources: number }> {
  const result = { shares: 0, settings: 0, bqSources: 0 };
  let projectId: string;
  try {
    const credential = await prisma.integrationCredential.findUnique({
      where: { id: credentialId },
      select: { projectId: true, provider: true },
    });
    if (
      !credential ||
      credential.provider !== GOOGLE_PROVIDER.search_console
    ) {
      return result;
    }
    projectId = credential.projectId;
  } catch (error) {
    logFailure("credential", error);
    return result;
  }
  try {
    result.shares = await ReportShares.deleteForProject("SEARCH", projectId);
  } catch (error) {
    logFailure("shares", error);
  }
  try {
    result.settings = (
      await prisma.gscSiteSetting.deleteMany({ where: { projectId } })
    ).count;
  } catch (error) {
    logFailure("settings", error);
  }
  try {
    result.bqSources = (
      await prisma.gscBqSource.deleteMany({ where: { projectId } })
    ).count;
  } catch (error) {
    logFailure("bigquery", error);
  }
  return result;
}
