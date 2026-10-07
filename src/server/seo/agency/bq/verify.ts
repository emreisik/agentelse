import "server-only";

import { Prisma, type GscBqSource, type GscSiteLink } from "@prisma/client";

import { isRateLimited } from "@/lib/rate-limit";
import { prisma } from "@/lib/prisma";
import {
  BQ_SOURCE_ERROR_TEXT,
  BQ_VERIFY_STEP_KEYS,
  BQ_VERIFY_STEP_LABEL,
  type BqSourceErrorCode,
  type BqVerifyResult,
  type BqVerifyStep,
  type BqVerifyStepKey,
} from "@/lib/seo/agency/bq/copy";
import { formatBytes } from "@/lib/seo/agency/bq/cost";
import { hardMaxBytes, rowCap } from "@/lib/seo/agency/bq/limits";
import {
  coverageFromResults,
  dayRowsFromResult,
  matchSiteUrl,
  normalizeSiteUrl,
  type BqCoverage,
} from "@/lib/seo/agency/bq/rows";
import {
  coverageLogSql,
  coverageTableSql,
  periodSql,
  reconcileDaysSql,
  siteMatchSql,
  type BqSql,
  type BqTarget,
} from "@/lib/seo/agency/bq/sql";
import { gscBigQueryActiveFor } from "@/lib/seo/agency/flags";
import {
  addDays,
  dateToDayKey,
  dayKeyToDate,
  gscToday,
  lastCompleteWeekStart,
  weekEndOf,
} from "@/lib/seo/dates";
import {
  bigQueryClient,
  classifyBigQueryError,
  type BigQueryClient,
  type BqQueryResult,
} from "@/server/integrations/google/bigquery";
import { AuditLogRepository } from "@/server/repositories/audit-log.repository";

import {
  addBqUsage,
  bqOwnershipHolds,
  findBqLink,
  findBqSource,
} from "./source";
// Yalnız yan etki: "gsc." sahte işleyicisini kaydeder (mock arka uç dışında
// erişilemez).
import "./mock-export";

// BigQuery kaynağının doğrulaması (kullanıcı tetikler, 5 dakikada 5 kez).
//
// SAHİPLİK GÜVENLİK SINIRIDIR (confused deputy): Agentelse'in servis hesabı
// TÜM müşteriler için tek bir ilkedir. Kendi veri kümesine bu hesaba okuma
// yetkisi veren herkes, adını bilen başka biri tarafından da hedeflenebilir;
// bu yüzden erişim veri kümesi kimliğine değil, Search Console mülkünün
// SAHİPLİĞİNE (GscSiteLink.permissionLevel = siteOwner) bağlanır. Sahiplik
// ilk adımdır ve hiçbir BigQuery çağrısından önce yerelde (saklanan değerle)
// denetlenir. Site eşleşmesi sorgusu yalnız bağın KENDİ mülkünü süzer: başka
// mülkler okunmaz, sayılmaz, listelenmez; veri kümesi bu mülkü içermiyorsa
// SITE_MISMATCH ile biter ve hiçbir şey okunmaz. Ham Google/BigQuery mesajı
// ve tablo satırları saklanmaz; yalnız sabit kodlar.

const RATE_MAX = 5;
const RATE_WINDOW_MS = 600_000;
const GIB = 1024 ** 3;
const MAX_VERIFY_BYTES = GIB;
const COVERAGE_PROBE_DAYS = 800;
const SITE_MATCH_DAYS = 30;
const RECONCILE_DAYS = 14;
const RECONCILE_WARN_PCT = 3;

function codeOf(error: unknown): BqSourceErrorCode {
  return classifyBigQueryError(error).code;
}

// Site eşleşmesi geçmeden önce veri kümesinin var olup olmadığı sızdırılmaz:
// "bulunamadı" ile "erişilemiyor" aynı koda iner (başkasının proje/veri
// kümesi adını deneyen biri ikisini ayıramasın).
function maskedCode(error: unknown): BqSourceErrorCode {
  const code = codeOf(error);
  return code === "NOT_FOUND" ? "NO_ACCESS" : code;
}

function roundPct(value: number): number {
  return Math.round(value * 10) / 10;
}

// (bq − api) / api × 100, bir ondalık; API sıfırsa null.
function diffPct(bq: number, api: number): number | null {
  return api > 0 ? roundPct(((bq - api) / api) * 100) : null;
}

function emptySteps(): BqVerifyStep[] {
  return BQ_VERIFY_STEP_KEYS.map((key) => ({
    key,
    label: BQ_VERIFY_STEP_LABEL[key],
    state: "skipped",
    detail: null,
  }));
}

function refused(code: BqSourceErrorCode): BqVerifyResult {
  return { ok: false, steps: emptySteps(), errorCode: code };
}

export async function verifyBqSource(input: {
  projectId: string;
  linkId: string;
  userId: string;
  now?: Date;
  client?: BigQueryClient;
}): Promise<BqVerifyResult> {
  if (!gscBigQueryActiveFor(input.projectId)) return refused("INVALID_REQUEST");
  if (isRateLimited(`bq-verify:${input.linkId}`, RATE_MAX, RATE_WINDOW_MS)) {
    return refused("RATE_LIMIT");
  }
  const now = input.now ?? new Date();
  const link = await findBqLink(input.projectId, input.linkId);
  if (!link) return refused("INVALID_REQUEST");
  const source = await findBqSource(link);
  if (!source) return refused("INVALID_REQUEST");

  const client = input.client ?? bigQueryClient();
  const steps = emptySteps();
  const step = (key: BqVerifyStepKey) =>
    steps.find((entry) => entry.key === key) as BqVerifyStep;
  const done = (key: BqVerifyStepKey, detail: string | null = null) => {
    step(key).state = "ok";
    step(key).detail = detail;
  };
  const warn = (key: BqVerifyStepKey, detail: string) => {
    step(key).state = "warn";
    step(key).detail = detail;
  };

  const target: BqTarget = {
    projectId: source.bqProjectId,
    dataset: source.dataset,
  };
  const today = gscToday(now);
  // Doğrulama sorgularının tavanı: min(sorgu başına tavan, 1 GiB).
  const verifyBytes = Math.max(
    10 * 1024 * 1024,
    Math.min(Number(source.maxBytesPerQuery), hardMaxBytes(), MAX_VERIFY_BYTES),
  );
  let billed = 0;
  let queries = 0;
  let location: string | null = source.location;
  const save: Prisma.GscBqSourceUpdateInput = {};
  let coverage: BqCoverage | null = null;
  let siteLiteral: string | null = null;
  let reconcile: Prisma.InputJsonValue | null = null;

  const run: BqRun = async (built, maxRows) => {
    queries += 1;
    const result = await client.query({
      purpose: built.purpose,
      projectId: source.bqProjectId,
      location,
      sql: built.sql,
      params: built.params,
      maxBytesBilled: verifyBytes,
      maxRows,
      timeoutMs: 60_000,
    });
    billed += result.bytesBilled ?? result.bytesProcessed;
    return result;
  };

  let failure: { key: BqVerifyStepKey; code: BqSourceErrorCode } | null = null;
  try {
    // 1 Sahiplik: yerel (saklanan değer, bağ sağlığı, kimlik bilgisi); hiçbir
    // BigQuery çağrısı yok.
    if (!(await bqOwnershipHolds(link))) {
      failure = { key: "ownership", code: "NOT_OWNER" };
    } else {
      done("ownership");
    }

    // 2 Servis hesabı
    if (!failure) {
      if (!client.configured()) {
        failure = { key: "service_account", code: "NOT_CONFIGURED" };
      } else {
        done("service_account");
      }
    }

    // 3 Veri kümesi
    if (!failure) {
      try {
        const dataset = await client.getDataset({
          projectId: source.bqProjectId,
          dataset: source.dataset,
        });
        location = dataset.location ?? location;
        save.location = location;
        done("dataset");
      } catch (error) {
        failure = { key: "dataset", code: maskedCode(error) };
      }
    }

    // 4 Tablolar
    if (!failure) {
      try {
        for (const table of [
          "searchdata_site_impression",
          "searchdata_url_impression",
        ]) {
          await client.getTable({
            projectId: source.bqProjectId,
            dataset: source.dataset,
            table,
          });
        }
        done("tables");
      } catch (error) {
        failure = { key: "tables", code: maskedCode(error) };
      }
    }

    // 5 Site eşleşmesi: yalnız bağın kendi mülkü sorgulanır. Dışa aktarım
    // penceresi gibi veri kümesine ait hiçbir bilgi bundan önce okunmaz.
    if (!failure) {
      try {
        const built = siteMatchSql(
          target,
          addDays(today, -SITE_MATCH_DAYS),
          normalizeSiteUrl(link.siteUrl),
        );
        const result = await run(built, 20);
        siteLiteral = matchSiteUrl(
          result.rows.map((cells) => ({
            siteUrl: typeof cells[0] === "string" ? cells[0] : "",
            clicks: typeof cells[1] === "number" ? cells[1] : 0,
          })),
          link.siteUrl,
        );
        if (siteLiteral === null) {
          failure = { key: "site_match", code: "SITE_MISMATCH" };
        } else {
          done("site_match");
        }
      } catch (error) {
        failure = { key: "site_match", code: maskedCode(error) };
      }
    }

    // 6 Dışa aktarım verisi (yalnız site eşleştikten sonra): ExportLog, yoksa
    // tabloların kendi mülk yoklaması
    if (!failure) {
      try {
        coverage = await readBqCoverage(run, target, link, today);
        if (!coverage?.exportStart || !coverage.exportedThrough) {
          failure = { key: "export_data", code: "NO_EXPORT_DATA" };
        } else {
          done("export_data", `${coverage.exportStart} to ${coverage.exportedThrough}`);
        }
      } catch (error) {
        failure = { key: "export_data", code: codeOf(error) };
      }
    }

    // 7 Maliyet tahmini: son tam haftanın sorgu×sayfa özeti (en ağır sorgu)
    if (!failure && coverage?.exportedThrough && siteLiteral) {
      try {
        const range = estimateRange(coverage);
        const built = periodSql(
          target,
          "query_page",
          siteLiteral,
          range.from,
          range.to,
          rowCap(),
        );
        const estimate = await client.dryRun({
          purpose: built.purpose,
          projectId: source.bqProjectId,
          location,
          sql: built.sql,
          params: built.params,
          maxBytesBilled: verifyBytes,
          maxRows: 1,
        });
        const cap = Math.min(Number(source.maxBytesPerQuery), hardMaxBytes());
        const detail = `about ${formatBytes(estimate.bytesProcessed)} per weekly import`;
        if (estimate.bytesProcessed > cap) {
          warn(
            "cost_estimate",
            `${detail}. That is above your per-query cap of ${formatBytes(cap)}; raise the cap to import weeks.`,
          );
        } else {
          done("cost_estimate", detail);
        }
      } catch (error) {
        failure = { key: "cost_estimate", code: codeOf(error) };
      }
    }

    // 8 Mutabakat: API ile örtüşen en çok 14 kesin gün
    if (!failure && coverage?.exportStart && coverage.exportedThrough && siteLiteral) {
      try {
        const outcome = await reconcileWithApi({
          run,
          target,
          link,
          siteLiteral,
          coverage,
          now,
        });
        if (outcome === null) {
          step("reconcile").state = "skipped";
          step("reconcile").detail = "No overlapping days with the API yet.";
        } else {
          reconcile = {
            checkedAt: now.toISOString(),
            days: outcome.days,
            clicksDiffPct: outcome.clicksDiffPct,
            impressionsDiffPct: outcome.impressionsDiffPct,
          };
          const worst = Math.max(
            Math.abs(outcome.clicksDiffPct ?? 0),
            Math.abs(outcome.impressionsDiffPct ?? 0),
          );
          const detail = `${outcome.days} days compared`;
          if (worst > RECONCILE_WARN_PCT) {
            warn(
              "reconcile",
              `${detail}; the totals differ by more than ${RECONCILE_WARN_PCT}%.`,
            );
          } else {
            done("reconcile", detail);
          }
        }
      } catch (error) {
        failure = { key: "reconcile", code: codeOf(error) };
      }
    }
  } catch (error) {
    // Beklenmeyen hata: ham ileti saklanmaz.
    console.error(
      "[gsc-bigquery] verification crashed:",
      error instanceof Error ? error.name : error,
    );
    failure = { key: "ownership", code: "UNKNOWN" };
  }

  if (failure?.code === "SITE_MISMATCH") {
    // Eşleşmeyen veri kümesi hakkında hiçbir şey (var olduğu bile) gösterilmez.
    step("dataset").state = "skipped";
    step("tables").state = "skipped";
  }
  if (failure) {
    step(failure.key).state = "fail";
    step(failure.key).detail = BQ_SOURCE_ERROR_TEXT[failure.code];
  }

  const persisted = await persist({
    source,
    link,
    now,
    save,
    failure: failure?.code ?? null,
    coverage: failure ? null : coverage,
    siteLiteral: failure ? null : siteLiteral,
    reconcile: failure ? null : reconcile,
    billed,
    queries,
  });
  // Doğrulama sürerken kaynak başka bir projeye/veri kümesine çevrildiyse
  // sonuç yazılmaz: doğrulanan hedef ile saklanan hedef aynı olmalıdır.
  if (!persisted) return refused("INVALID_REQUEST");
  await AuditLogRepository.record({
    workspaceId: link.workspaceId,
    projectId: link.projectId,
    actorType: "USER",
    actorId: input.userId,
    action: "gsc_bigquery.verified",
    entityType: "GscBqSource",
    entityId: source.id,
    metadata: { linkId: link.id, ok: failure === null },
  }).catch((error: unknown) => {
    console.error(
      "[gsc-bigquery] audit could not be written:",
      error instanceof Error ? error.name : error,
    );
  });
  return { ok: failure === null, steps, errorCode: failure?.code ?? null };
}

// Tahmin aralığı: penceredeki son tam hafta; tam hafta yoksa pencerenin kendisi.
function estimateRange(coverage: BqCoverage): { from: string; to: string } {
  const through = coverage.exportedThrough as string;
  const start = coverage.exportStart as string;
  const week = lastCompleteWeekStart(through);
  return week >= start
    ? { from: week, to: weekEndOf(week) }
    : { from: start, to: through };
}

export type BqRun = (built: BqSql, maxRows: number) => Promise<BqQueryResult>;

// Kapsam: önce ExportLog; tablo yoksa ya da sorgu geçersizse iki tablonun
// KENDİ mülkü için yoklaması.
export async function readBqCoverage(
  run: BqRun,
  target: BqTarget,
  link: GscSiteLink,
  today: string,
): Promise<BqCoverage | null> {
  try {
    const log = await run(coverageLogSql(target), 10);
    const fromLog = coverageFromResults(log, { site: null, url: null });
    if (fromLog) return fromLog;
  } catch (error) {
    const code = classifyBigQueryError(error).code;
    // Yetki, fatura ve geçici hatalar yedeğe düşmez.
    if (code !== "NOT_FOUND" && code !== "INVALID_QUERY") throw error;
  }
  const since = addDays(today, -COVERAGE_PROBE_DAYS);
  const [site, url] = [
    await run(coverageTableSql(target, "site", since, link.siteUrl), 2),
    await run(coverageTableSql(target, "url", since, link.siteUrl), 2),
  ];
  return coverageFromResults(null, { site, url });
}

async function reconcileWithApi(input: {
  run: BqRun;
  target: BqTarget;
  link: GscSiteLink;
  siteLiteral: string;
  coverage: BqCoverage;
  now: Date;
}): Promise<{
  days: number;
  clicksDiffPct: number | null;
  impressionsDiffPct: number | null;
} | null> {
  const { link, coverage } = input;
  const finalThrough = link.lastFinalDate;
  if (!finalThrough || !coverage.exportStart || !coverage.exportedThrough) {
    return null;
  }
  const to = finalThrough < coverage.exportedThrough ? finalThrough : coverage.exportedThrough;
  const earliest = addDays(to, -(RECONCILE_DAYS - 1));
  const from = earliest > coverage.exportStart ? earliest : coverage.exportStart;
  if (from > to) return null;

  const [bq, api] = await Promise.all([
    input.run(reconcileDaysSql(input.target, input.siteLiteral, from, to), 40),
    prisma.gscDailyTotal.findMany({
      where: {
        linkId: link.id,
        searchType: "web",
        fresh: false,
        date: { gte: dayKeyToDate(from), lte: dayKeyToDate(to) },
      },
      select: { date: true, clicks: true, impressions: true },
    }),
  ]);
  const apiByDay = new Map(
    api.map((row) => [dateToDayKey(row.date), row] as const),
  );
  let bqClicks = 0;
  let bqImpressions = 0;
  let apiClicks = 0;
  let apiImpressions = 0;
  let days = 0;
  for (const row of dayRowsFromResult(bq)) {
    const match = apiByDay.get(row.day);
    if (!match) continue;
    days += 1;
    bqClicks += row.clicks;
    bqImpressions += row.impressions;
    apiClicks += match.clicks;
    apiImpressions += match.impressions;
  }
  if (days === 0) return null;
  return {
    days,
    clicksDiffPct: diffPct(bqClicks, apiClicks),
    impressionsDiffPct: diffPct(bqImpressions, apiImpressions),
  };
}

// Sonucu kaynağa yazar. Başarıda durum VERIFIED olur (ACTIVE, PAUSED ve
// BUDGET kaynaklar durumunu korur: yeniden doğrulama çalışan kaynağı
// durdurmaz); başarısızlıkta ERROR + sabit kod.
async function persist(input: {
  source: GscBqSource;
  link: GscSiteLink;
  now: Date;
  save: Prisma.GscBqSourceUpdateInput;
  failure: BqSourceErrorCode | null;
  coverage: BqCoverage | null;
  siteLiteral: string | null;
  reconcile: Prisma.InputJsonValue | null;
  billed: number;
  queries: number;
}): Promise<boolean> {
  const { source, failure } = input;
  const data: Prisma.GscBqSourceUpdateInput = { ...input.save };
  if (failure) {
    data.status = "ERROR";
    data.lastError = failure;
    data.nextRunAt = null;
  } else {
    const keep = ["ACTIVE", "PAUSED", "BUDGET"].includes(source.status);
    data.status = keep ? source.status : "VERIFIED";
    data.lastError = null;
    data.lastVerifiedAt = input.now;
    data.coverageCheckedAt = input.now;
    data.exportStart = input.coverage?.exportStart ?? null;
    data.exportedThrough = input.coverage?.exportedThrough ?? null;
    data.bqSiteUrl = input.siteLiteral;
    data.consecutiveFailures = 0;
    if (input.reconcile !== null) data.reconcile = input.reconcile;
  }
  // Doğrulama birçok BigQuery çağrısı sürer; bu sırada kayıt kaydedilip başka
  // bir hedefe çevrilmiş olabilir. Yazma yalnız doğrulanan hedefe uygulanır.
  const written = await prisma.gscBqSource.updateMany({
    where: {
      id: source.id,
      bqProjectId: source.bqProjectId,
      dataset: source.dataset,
    },
    data: data as Prisma.GscBqSourceUpdateManyMutationInput,
  });
  if (written.count !== 1) return false;
  if (input.queries > 0) {
    await addBqUsage(source.id, input.billed, input.queries, input.now);
  }
  return true;
}
