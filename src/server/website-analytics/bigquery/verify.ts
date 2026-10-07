import "server-only";

import { prisma } from "@/lib/prisma";
import { gaBigQueryEnabledFor } from "@/lib/website-analytics/agency/flags";
import { maxBytesCap, sumBytes } from "@/lib/website-analytics/bigquery/budget";
import {
  keyEventNamesOf,
  parseBigQueryConfigInput,
} from "@/lib/website-analytics/bigquery/config";
import {
  gaBigQueryErrorOf,
  gaBigQueryMessage,
  type GaBigQueryErrorCode,
} from "@/lib/website-analytics/bigquery/errors";
import { buildGaStatements } from "@/lib/website-analytics/bigquery/sql";
import { addDays } from "@/lib/website-analytics/days";
import {
  BigQueryError,
  bigQueryClient,
  bigQueryMockMode,
  isValidDatasetId,
  isValidGcpProjectId,
  type BigQueryClient,
} from "@/server/integrations/google/bigquery";
import { AuditLogRepository } from "@/server/repositories/audit-log.repository";

import { registerGaBigQueryMock } from "./mock";

// GA4 BigQuery kaynağı kurulumu ve doğrulaması (GA-F8). Tek proje kuralı: istemciye
// giden HER çağrı (getDataset, getTable, dryRun) aynı gcpProjectId'yi projectId
// olarak kullanır; ayrı faturalama projesi yoktur. Veri kümesi yalnız
// analytics_<mülk kimliği> olabilir (parseBigQueryConfigInput, istemci çağrısından ÖNCE).

export type GaBigQueryDeps = { client?: BigQueryClient; now?: () => Date };

export type BigQuerySetupResult =
  | { ok: true }
  | {
      ok: false;
      code: GaBigQueryErrorCode | "invalid" | "off" | "no_link";
      message: string;
    };

const OFF_MESSAGE = "BigQuery export isn't available for this project.";
const NO_LINK_MESSAGE = "Google Analytics isn't connected for this property.";
const PROBE_DAYS = 4;
const DRY_RUN_DAYS = 3;

// Mock kipinde 'ga.' işleyicisini ilk istemci çağrısından önce kaydeder.
export function prepareGaBigQueryClient(deps: GaBigQueryDeps): BigQueryClient {
  if (bigQueryMockMode()) registerGaBigQueryMock();
  return deps.client ?? bigQueryClient();
}

function failure(
  code: GaBigQueryErrorCode,
  client: BigQueryClient,
): BigQuerySetupResult {
  return {
    ok: false,
    code,
    message: gaBigQueryMessage(code, client.serviceAccountEmail()),
  };
}

function compactDay(day: string): string {
  return day.replace(/-/g, "");
}

export async function verifyAndSaveBigQuerySource(
  input: {
    projectId: string;
    linkId: string;
    userId: string;
    config: { gcpProjectId: string; datasetId: string; location?: string };
  },
  deps: GaBigQueryDeps = {},
): Promise<BigQuerySetupResult> {
  if (!gaBigQueryEnabledFor(input.projectId)) {
    return { ok: false, code: "off", message: OFF_MESSAGE };
  }
  const client = prepareGaBigQueryClient(deps);
  if (!client.configured()) return failure("not_configured", client);

  const link = await prisma.gaPropertyLink.findFirst({
    where: {
      id: input.linkId,
      projectId: input.projectId,
      OR: [{ isPrimary: true }, { isSecondary: true }],
    },
  });
  if (!link) return { ok: false, code: "no_link", message: NO_LINK_MESSAGE };

  // Bağlama kuralı: istemci çağrısından önce.
  const parsed = parseBigQueryConfigInput(input.config, link.propertyId);
  if (!parsed.ok) {
    return { ok: false, code: "invalid", message: parsed.message };
  }
  const config = parsed.value;
  if (
    !isValidGcpProjectId(config.gcpProjectId) ||
    !isValidDatasetId(config.datasetId)
  ) {
    return {
      ok: false,
      code: "invalid",
      message: "That project id doesn't look right.",
    };
  }

  const now = (deps.now ?? (() => new Date()))();
  const cap = maxBytesCap();
  const today = now.toISOString().slice(0, 10);

  try {
    const dataset = await client.getDataset({
      projectId: config.gcpProjectId,
      dataset: config.datasetId,
    });
    // Kullanıcının verdiği konum önceliklidir; yoksa veri kümesinin konumu.
    const location = config.location ?? dataset.location ?? null;

    // Son 4 UTC gününün tabloları: biri varsa dışa aktarım çalışıyordur
    // (bugünün tablosu yoktur, yalnız intraday vardır).
    let foundDay: string | null = null;
    for (let back = 1; back <= PROBE_DAYS && !foundDay; back += 1) {
      const day = addDays(today, -back);
      try {
        await client.getTable({
          projectId: config.gcpProjectId,
          dataset: config.datasetId,
          table: `events_${compactDay(day)}`,
        });
        foundDay = day;
      } catch (error) {
        if (!(error instanceof BigQueryError) || error.code !== "NOT_FOUND") {
          throw error;
        }
      }
    }
    if (!foundDay) return failure("no_export_tables", client);

    // Üç ifadenin son 3 günlük kuru çalıştırması; TOPLAM sınırı aşarsa reddedilir
    // (günlük + sayfalar event_params'ı ayrı ayrı taradığı için ~üç tarama).
    const fromDay =
      foundDay < addDays(today, -DRY_RUN_DAYS)
        ? foundDay
        : addDays(today, -DRY_RUN_DAYS);
    const statements = buildGaStatements(
      { projectId: config.gcpProjectId, datasetId: config.datasetId },
      {
        fromDay,
        toDay: addDays(today, -1),
        keyEventNames: keyEventNamesOf(link.keyEvents),
      },
    );
    if (!statements) {
      return {
        ok: false,
        code: "invalid",
        message: "That project id doesn't look right.",
      };
    }
    const bytes: number[] = [];
    for (const statement of [
      statements.daily,
      statements.events,
      statements.pages,
    ]) {
      const dry = await client.dryRun({
        purpose: statement.purpose,
        projectId: config.gcpProjectId,
        location,
        sql: statement.sql,
        params: statement.params,
        maxBytesBilled: cap,
        maxRows: statement.maxRows,
      });
      bytes.push(dry.bytesProcessed);
    }
    if (sumBytes(bytes) > cap) return failure("bytes_limit", client);

    const existing = await prisma.gaBigQuerySource.findUnique({
      where: { linkId: link.id },
      select: { id: true, gcpProjectId: true, datasetId: true },
    });
    const sameTarget =
      existing?.gcpProjectId === config.gcpProjectId &&
      existing.datasetId === config.datasetId;
    const saved = await prisma.gaBigQuerySource.upsert({
      where: { linkId: link.id },
      create: {
        workspaceId: link.workspaceId,
        projectId: link.projectId,
        linkId: link.id,
        gcpProjectId: config.gcpProjectId,
        datasetId: config.datasetId,
        location,
        status: "OK",
        lastError: null,
        verifiedAt: now,
        nextRunAt: now,
        createdByUserId: input.userId,
      },
      update: {
        gcpProjectId: config.gcpProjectId,
        datasetId: config.datasetId,
        location,
        status: "OK",
        lastError: null,
        verifiedAt: now,
        nextRunAt: now,
        leaseUntil: null,
        leaseOwner: null,
        // Başka veri kümesine geçildiyse okuma baştan başlar.
        ...(sameTarget ? {} : { lastDay: null }),
      },
    });
    await AuditLogRepository.record({
      workspaceId: link.workspaceId,
      projectId: link.projectId,
      actorType: "USER",
      actorId: input.userId,
      action: "ga_bigquery.source_saved",
      entityType: "GaBigQuerySource",
      entityId: saved.id,
      metadata: {
        linkId: link.id,
        gcpProjectId: config.gcpProjectId,
        datasetId: config.datasetId,
      },
    });
    return { ok: true };
  } catch (error) {
    if (error instanceof BigQueryError) {
      return failure(gaBigQueryErrorOf(error.code), client);
    }
    // Yalnız hata adı: mesaj Google metni ya da kimlik taşıyabilir.
    console.error(
      "[ga-bigquery] verify failed:",
      error instanceof Error ? error.name : "unknown",
    );
    return failure("unavailable", client);
  }
}
