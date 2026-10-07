import "server-only";

import { createHash } from "node:crypto";

import type { GscBqSource, GscSiteLink } from "@prisma/client";

import {
  currentUsageMonth,
  decideSpend,
  type BqUsage,
} from "@/lib/seo/agency/bq/cost";
import { rowCap } from "@/lib/seo/agency/bq/limits";
import type { BqPeriodTask } from "@/lib/seo/agency/bq/plan";
import { periodRowsFromResult } from "@/lib/seo/agency/bq/rows";
import { periodSql } from "@/lib/seo/agency/bq/sql";
import { monthEnd, weekEndOf } from "@/lib/seo/dates";
import {
  classifyBigQueryError,
  type BigQueryClient,
} from "@/server/integrations/google/bigquery";
import type { GscPagedResult } from "@/server/integrations/search-console/search-analytics";

// Bir dönem anahtarının BigQuery'den okunması (docs/search-agency.md). Maliyet
// kalkanının sorgu başına kısmı burada: kuru çalıştırma → harcama kararı →
// maximumBytesBilled ile sorgu. Cap + 1 satır istenir; fazlası kırpılma
// işaretidir.

const MIN_TIMEOUT_MS = 5_000;
const MAX_TIMEOUT_MS = 90_000;

export type BqReadInput = {
  client: BigQueryClient;
  source: GscBqSource;
  link: GscSiteLink;
  task: BqPeriodTask;
  usage: BqUsage;
  hardMax: number;
  hardMonthly: number;
  // Turun duvar saati sınırı (ms epoch)
  deadlineAt: number;
  // Sorgu gönderildi ama sonucu alınamadıysa (zaman aşımı, ağ): iş Google'da
  // sürüp faturalanmış olabilir; çağıran bu tahmini bayt kadar harcama yazar.
  onUnfinished?: (chargedBytes: number) => Promise<void> | void;
};

// Aynı kaynak, dönem ve ay için sabit istek kimliği: yeniden denemede
// BigQuery aynı işe bağlanır (UUID biçimli, 36 karakter).
export function bqRequestId(input: {
  sourceId: string;
  grain: string;
  periodStart: string;
  key: string;
  usageMonth: string;
}): string {
  const hex = createHash("sha256")
    .update(
      [
        input.sourceId,
        input.grain,
        input.periodStart,
        input.key,
        input.usageMonth,
      ].join("|"),
    )
    .digest("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

// Gönderilmiş sorgunun sonucu belirsiz kalan hata sınıfları.
const UNFINISHED_CODES = new Set(["TIMEOUT", "UNAVAILABLE", "UNKNOWN"]);

export type BqReadOutcome =
  | { ok: true; result: GscPagedResult; billedBytes: number }
  | { ok: false; reason: "OVER_QUERY_CAP" | "OVER_MONTHLY_BUDGET" };

export async function readBqPeriod(input: BqReadInput): Promise<BqReadOutcome> {
  const { client, source, link, task } = input;
  const from = task.periodStart;
  const to = task.grain === "WEEK" ? weekEndOf(from) : monthEnd(from);
  const cap = rowCap();
  const built = periodSql(
    { projectId: source.bqProjectId, dataset: source.dataset },
    task.key,
    source.bqSiteUrl ?? link.siteUrl,
    from,
    to,
    cap,
  );
  const maxPerQuery = Number(source.maxBytesPerQuery);
  const base = {
    purpose: built.purpose,
    projectId: source.bqProjectId,
    location: source.location,
    sql: built.sql,
    params: built.params,
    maxRows: cap + 1,
  };

  // Her içe aktarma sorgusundan önce kuru çalıştırma (bayt tahmini).
  const estimate = await client.dryRun({
    ...base,
    maxBytesBilled: Math.max(1, Math.min(maxPerQuery, input.hardMax)),
  });
  const decision = decideSpend({
    estimateBytes: estimate.bytesProcessed,
    maxBytesPerQuery: maxPerQuery,
    monthlyBudgetBytes: Number(source.monthlyBudgetBytes),
    usage: input.usage,
    hardMax: input.hardMax,
    hardMonthly: input.hardMonthly,
  });
  if (!decision.ok) return { ok: false, reason: decision.reason };

  const remaining = input.deadlineAt - Date.now();
  let result;
  try {
    result = await client.query({
      ...base,
      maxBytesBilled: decision.maxBytesBilled,
      timeoutMs: Math.max(MIN_TIMEOUT_MS, Math.min(MAX_TIMEOUT_MS, remaining)),
      requestId: bqRequestId({
        sourceId: source.id,
        grain: task.grain,
        periodStart: task.periodStart,
        key: task.key,
        usageMonth: currentUsageMonth(new Date()),
      }),
    });
  } catch (error) {
    if (
      input.onUnfinished &&
      UNFINISHED_CODES.has(classifyBigQueryError(error).code)
    ) {
      await input.onUnfinished(
        Math.min(estimate.bytesProcessed, decision.maxBytesBilled),
      );
    }
    throw error;
  }
  const { rows, truncated } = periodRowsFromResult(task.key, result, cap);
  return {
    ok: true,
    billedBytes: result.bytesBilled ?? result.bytesProcessed,
    result: {
      rows,
      pages: 1,
      truncated,
      firstIncompleteDate: null,
      responseAggregationType: task.key === "page" ? "byPage" : "auto",
    },
  };
}
