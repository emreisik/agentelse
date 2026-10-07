import "server-only";

import {
  Prisma,
  type GaChangeWatch,
  type GaPropertyLink,
} from "@prisma/client";

import { prisma } from "@/lib/prisma";
import { gaSyncAllowedFor } from "@/lib/website-analytics/flags";
import { fixErrorFor } from "@/lib/website-analytics/fixes/copy";
import {
  detectManualChanges,
  type GaOwnTouch,
} from "@/lib/website-analytics/fixes/change-events";
import {
  gaFixesEnabled,
  gaSyncProjectAllowList,
} from "@/lib/website-analytics/fixes/flags";
import { mockMatchesLink } from "@/lib/website-analytics/fixes/lifecycle";
import { retentionRank } from "@/lib/website-analytics/fixes/plan";
import type { GaChangeHistoryEvent } from "@/lib/website-analytics/fixes/resources";
import type { GaAdminWriter } from "@/server/integrations/google-analytics/admin-write";
import { GoogleApiError } from "@/server/integrations/google/errors";
import { SiteAlerts } from "@/server/monitoring/site-alerts";
import { Heartbeat } from "@/server/observability/heartbeat";

import { resolveGaFixDeps } from "./deps";
import { clearGaEditGrant, loadGaEditAccess } from "./edit-grant";
import type { GaFixDeps } from "./types";

// GA-F7 değişiklik geçmişi bekçisi (docs/website-fixes.md, "Değişiklik
// geçmişi"): `ga-change-watch` tick adımı. Günde en çok bir kez (~23 saat)
// her bağ için searchChangeHistoryEvents okunur; Agentelse dışında yapılan
// anahtar olay silme ve saklama kısaltma, yalnız uygulama içi GA4 uyarısı olur
// (WARN/INFO, asla CRITICAL: Telegram yok). Olaylar, kimin yaptığı ve zamanı
// saklanmaz ve loglanmaz; yalnız sabit başlıklı uyarı ve imleç kalır.
// Uyarının hâlâ geçerli olup olmadığına bağın eski sütunları değil CANLI
// okuma karar verir. Sınırlar: bağ başına en çok 5 sayfa x 100 olay, ilk tur
// yalnız imleci kurar, 3 günden eski boşluk geriye dönük taranmaz.

const HEARTBEAT_KEY = "ga.changewatch";
const CANDIDATES = 20;
const RUN_EVERY_MS = 23 * 60 * 60 * 1000;
const GAP_RESET_MS = 3 * 24 * 60 * 60 * 1000;
const OVERLAP_MS = 60 * 60 * 1000;
const LEASE_MS = 3 * 60 * 1000;
const MAX_PAGES = 5;
const PAGE_SIZE = 100;
const OPEN_ALERT_STATUSES = ["OPEN", "ACKED", "MUTED"] as const;

export const GA_CHG_KEY_EVENT_REMOVED = "GA_CHG_KEY_EVENT_REMOVED";
export const GA_CHG_RETENTION_SHORTENED = "GA_CHG_RETENTION_SHORTENED";
const CHG_KINDS = [GA_CHG_KEY_EVENT_REMOVED, GA_CHG_RETENTION_SHORTENED];

const KEY_EVENT_TITLE = "A key event was removed in Google Analytics";
const RETENTION_TITLE =
  "Event data retention was shortened in Google Analytics";

// Kullanıcıya gösterilen süre adları; bilinmeyen değer genel metne düşer.
const RETENTION_LABEL: Record<string, string> = {
  TWO_MONTHS: "2 months",
  FOURTEEN_MONTHS: "14 months",
  TWENTY_SIX_MONTHS: "26 months",
  THIRTY_EIGHT_MONTHS: "38 months",
  FIFTY_MONTHS: "50 months",
};

type WatchError =
  | "permission"
  | "scope_missing"
  | "reconnect"
  | "rate_limited"
  | "google_unavailable"
  | "unknown";

function errorName(error: unknown): string {
  return error instanceof Error ? error.name : "unknown";
}

// Hata sınıfından bekçi hata kodu. Ham mesaj hiçbir yere yazılmaz.
function watchErrorFor(error: unknown): WatchError {
  if (!(error instanceof GoogleApiError)) return "unknown";
  const mapped = fixErrorFor({
    errorClass: error.errorClass,
    httpStatus: error.httpStatus,
    message: error.message,
    alpha: false,
  });
  switch (mapped.code) {
    case "no_property_access":
      return "permission";
    case "scope_missing":
      return "scope_missing";
    case "reconnect":
      return "reconnect";
    case "rate_limited":
      return "rate_limited";
    case "google_unavailable":
      return "google_unavailable";
    default:
      return "unknown";
  }
}

function keyEventDedupeKey(linkId: string, eventName: string): string {
  return `ga4:${linkId}:CHG:KEY_EVENT_REMOVED:${eventName}`;
}

function retentionDedupeKey(linkId: string): string {
  return `ga4:${linkId}:CHG:RETENTION`;
}

function linkPrefix(linkId: string): string {
  return `ga4:${linkId}:CHG:`;
}

// 4. ':' sonrasındaki metin olay adıdır (olay adında ':' olamaz).
function eventNameOfKey(dedupeKey: string): string {
  return dedupeKey.split(":").slice(4).join(":");
}

function beforeOf(data: Prisma.JsonValue | null): string | null {
  if (typeof data !== "object" || data === null || Array.isArray(data)) {
    return null;
  }
  const before = (data as Record<string, unknown>).before;
  return typeof before === "string" && before ? before : null;
}

// Bağ başına izleme satırı; iki süreç aynı anda oluşturursa ikincisi okur.
async function ensureWatch(link: GaPropertyLink): Promise<GaChangeWatch> {
  try {
    return await prisma.gaChangeWatch.upsert({
      where: { linkId: link.id },
      create: {
        linkId: link.id,
        workspaceId: link.workspaceId,
        projectId: link.projectId,
      },
      update: {},
    });
  } catch (error) {
    const existing = await prisma.gaChangeWatch.findUnique({
      where: { linkId: link.id },
    });
    if (existing) return existing;
    throw error;
  }
}

async function claim(
  linkId: string,
  owner: string,
  now: Date,
): Promise<boolean> {
  const claimed = await prisma.gaChangeWatch.updateMany({
    where: {
      linkId,
      OR: [{ leaseUntil: null }, { leaseUntil: { lt: now } }],
    },
    data: { leaseUntil: new Date(now.getTime() + LEASE_MS), leaseOwner: owner },
  });
  return claimed.count === 1;
}

// Kira bırakılır ve sonuç yazılır; kira başkasına geçtiyse (süre doldu)
// yazılmaz.
async function finish(
  linkId: string,
  owner: string,
  data: Prisma.GaChangeWatchUpdateManyMutationInput,
): Promise<void> {
  await prisma.gaChangeWatch.updateMany({
    where: { linkId, leaseOwner: owner },
    data: { ...data, leaseUntil: null, leaseOwner: null },
  });
}

// Hata günü: imleç ilerlemez (olaylar yarın yeniden taranır), yarın yeniden
// denenir.
async function finishWithError(
  link: GaPropertyLink,
  owner: string,
  now: Date,
  code: WatchError | "truncated",
): Promise<void> {
  await finish(link.id, owner, { lastRunAt: now, lastError: code });
}

// Agentelse'in kendi dokunuşları: bunlar uyarı üretmez. Saklama kaydı tekil
// kaynaktır (properties/<id>/dataRetentionSettings), diğerleri kaynak adıyla.
async function ownTouchesFor(
  link: GaPropertyLink,
  since: Date,
): Promise<GaOwnTouch[]> {
  const rows = await prisma.gaConfigChange.findMany({
    where: {
      linkId: link.id,
      status: { in: ["APPLIED", "VERIFIED", "UNDONE", "UNDOING", "FAILED"] },
      OR: [{ appliedAt: { gte: since } }, { rolledBackAt: { gte: since } }],
    },
    select: {
      kind: true,
      resourceName: true,
      appliedAt: true,
      rolledBackAt: true,
    },
    take: 200,
  });
  const touches: GaOwnTouch[] = [];
  for (const row of rows) {
    const times = [row.appliedAt, row.rolledBackAt].filter(
      (value): value is Date => value !== null,
    );
    if (times.length === 0) continue;
    const at = new Date(Math.max(...times.map((value) => value.getTime())));
    if (row.kind === "RETENTION_14M") {
      touches.push({
        resource: `properties/${link.propertyId}/dataRetentionSettings`,
        at,
      });
    } else if (row.resourceName) {
      touches.push({ resource: row.resourceName, at });
    }
  }
  return touches;
}

async function readHistory(
  writer: GaAdminWriter,
  link: GaPropertyLink & { accountId: string },
  earliest: Date,
  latest: Date,
): Promise<{ events: GaChangeHistoryEvent[]; truncated: boolean }> {
  const events: GaChangeHistoryEvent[] = [];
  let pageToken: string | undefined;
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const result = await writer.searchChangeHistory({
      accountId: link.accountId,
      propertyId: link.propertyId,
      earliest,
      latest,
      pageToken,
      pageSize: PAGE_SIZE,
    });
    events.push(...result.events);
    if (!result.nextPageToken) return { events, truncated: false };
    pageToken = result.nextPageToken;
  }
  return { events, truncated: true };
}

function retentionDetail(before: string, live: string): string {
  const was = RETENTION_LABEL[before] ?? "a longer period";
  const now = RETENTION_LABEL[live] ?? "a shorter period";
  return `It was ${was} and is now ${now}. Reports that need older data may be affected.`;
}

type Deps = {
  writer?: GaFixDeps["writer"];
  mock?: boolean;
  tokenFor?: GaFixDeps["tokenFor"];
};

type LinkOutcome = "processed" | "skipped";

async function watchLink(
  link: GaPropertyLink,
  now: Date,
  deps: Deps,
): Promise<LinkOutcome> {
  const d = resolveGaFixDeps({
    writer: deps.writer,
    mock: deps.mock,
    tokenFor: deps.tokenFor,
    now,
  });
  const watch = await ensureWatch(link);
  const owner = `ga-changewatch:${process.pid}:${now.getTime()}:${link.id}`;
  if (!(await claim(link.id, owner, now))) return "skipped";

  try {
    // Yazma izni olmadan geçmiş okunmaz (izin bağın kapısıdır).
    const access = await loadGaEditAccess(link.projectId, { mock: d.mock });
    if (
      !access ||
      !access.granted ||
      access.credentialId !== link.credentialId
    ) {
      await finishWithError(link, owner, now, "scope_missing");
      return "processed";
    }

    // İlk tur ya da 3 günden eski boşluk: yalnız imleç kurulur; geçmişe
    // bakılmaz ve uyarı üretilmez.
    const gap =
      watch.cursorAt !== null &&
      watch.lastRunAt !== null &&
      now.getTime() - watch.lastRunAt.getTime() > GAP_RESET_MS;
    if (watch.cursorAt === null || gap) {
      await finish(link.id, owner, {
        cursorAt: now,
        lastRunAt: now,
        lastEventCount: 0,
        lastAlertCount: 0,
        lastError: null,
      });
      return "processed";
    }

    if (!link.accountId) {
      await finishWithError(link, owner, now, "unknown");
      return "processed";
    }
    const credential = await prisma.integrationCredential.findUnique({
      where: { id: link.credentialId },
      select: { id: true, status: true, encryptedSecret: true },
    });
    if (
      !credential ||
      credential.status !== "ACTIVE" ||
      !credential.encryptedSecret
    ) {
      await finishWithError(link, owner, now, "reconnect");
      return "processed";
    }

    const token = await d.tokenFor({
      id: credential.id,
      encryptedSecret: credential.encryptedSecret,
    });
    const writer = d.writerFor(token);
    const earliest = new Date(watch.cursorAt.getTime() - OVERLAP_MS);
    const history = await readHistory(
      writer,
      { ...link, accountId: link.accountId },
      earliest,
      now,
    );

    const ownTouches = await ownTouchesFor(
      link,
      new Date(earliest.getTime() - OVERLAP_MS),
    );
    const findings = detectManualChanges(history.events, { ownTouches });

    // C. Bu bağın açık uyarıları.
    const prefix = linkPrefix(link.id);
    const rows = await prisma.adsAlert.findMany({
      where: {
        projectId: link.projectId,
        source: "GA4",
        kind: { in: CHG_KINDS },
        status: { in: [...OPEN_ALERT_STATUSES] },
        dedupeKey: { startsWith: prefix },
      },
      select: { dedupeKey: true, kind: true, data: true },
      take: 200,
    });

    const needsKeys =
      findings.removedKeyEvents.length > 0 ||
      rows.some((row) => row.kind === GA_CHG_KEY_EVENT_REMOVED);
    const needsRetention =
      findings.retentionShortened ||
      rows.some((row) => row.kind === GA_CHG_RETENTION_SHORTENED);

    let raisedCount = 0;
    if (needsKeys || needsRetention) {
      // A. Canlı durum (yalnız okuma). Hata genel hata yoluna gider:
      // imleç ilerlemez, uyarı açılmaz ve kapanmaz.
      const liveKeys = needsKeys
        ? new Set(
            (await writer.listKeyEvents(link.propertyId)).map(
              (key) => key.eventName,
            ),
          )
        : new Set<string>();
      const liveRetention = needsRetention
        ? (await writer.getDataRetention(link.propertyId)).eventDataRetention
        : null;

      // B. Yalnız koşul hâlâ canlıda geçerliyse uyarı. Geri gelmiş olay
      // asla açılmaz (1 saatlik örtüşme ÇÖZÜLMÜŞ uyarıyı yeniden açmasın).
      const raised = new Set<string>();
      for (const eventName of findings.removedKeyEvents) {
        if (liveKeys.has(eventName)) continue;
        const dedupeKey = keyEventDedupeKey(link.id, eventName);
        await SiteAlerts.raise(
          {
            workspaceId: link.workspaceId,
            projectId: link.projectId,
            source: "GA4",
            kind: GA_CHG_KEY_EVENT_REMOVED,
            severity: "WARN",
            dedupeKey,
            title: KEY_EVENT_TITLE,
            detail: `"${eventName}" is no longer marked as a key event, so it stops counting as a conversion in your reports.`,
          },
          now,
        );
        raised.add(dedupeKey);
      }
      if (
        findings.retentionShortened &&
        findings.retentionBefore !== null &&
        liveRetention !== null &&
        retentionRank(liveRetention) < retentionRank(findings.retentionBefore)
      ) {
        const dedupeKey = retentionDedupeKey(link.id);
        await SiteAlerts.raise(
          {
            workspaceId: link.workspaceId,
            projectId: link.projectId,
            source: "GA4",
            kind: GA_CHG_RETENTION_SHORTENED,
            severity: "INFO",
            dedupeKey,
            title: RETENTION_TITLE,
            detail: retentionDetail(findings.retentionBefore, liveRetention),
            data: { before: findings.retentionBefore },
          },
          now,
        );
        raised.add(dedupeKey);
      }
      raisedCount = raised.size;

      // D. Açık kalacaklar: bu turda açılanlar, projenin DİĞER bağlarının
      // bütün GA_CHG_ uyarıları ve koşulu canlıda hâlâ süren bu bağ satırları.
      const stillOpen = new Set<string>(raised);
      const others = await prisma.adsAlert.findMany({
        where: {
          projectId: link.projectId,
          source: "GA4",
          kind: { in: CHG_KINDS },
          status: { in: [...OPEN_ALERT_STATUSES] },
          NOT: { dedupeKey: { startsWith: prefix } },
        },
        select: { dedupeKey: true },
        take: 500,
      });
      for (const other of others) stillOpen.add(other.dedupeKey);
      for (const row of rows) {
        if (row.kind === GA_CHG_KEY_EVENT_REMOVED) {
          if (!liveKeys.has(eventNameOfKey(row.dedupeKey))) {
            stillOpen.add(row.dedupeKey);
          }
        } else if (row.kind === GA_CHG_RETENTION_SHORTENED) {
          const before = beforeOf(row.data);
          const threshold = retentionRank(before ?? "FOURTEEN_MONTHS");
          if (
            liveRetention !== null &&
            retentionRank(liveRetention) < threshold
          ) {
            stillOpen.add(row.dedupeKey);
          }
        }
      }

      // E. Bu turda açılan uyarı aynı turda kapanamaz; bağın eski sütunlarına
      // (keyEvents, dataRetention) hiç bakılmaz.
      await SiteAlerts.resolveMissing(
        {
          projectId: link.projectId,
          source: "GA4",
          kinds: CHG_KINDS,
          stillOpen,
        },
        now,
      );
    }

    // F. Başarı: imleç ilerler (kesilse de; maliyet sınırlı).
    await finish(link.id, owner, {
      cursorAt: now,
      lastRunAt: now,
      lastEventCount: history.events.length,
      lastAlertCount: raisedCount,
      lastError: history.truncated ? "truncated" : null,
    });
    return "processed";
  } catch (error) {
    const code = watchErrorFor(error);
    console.error(`[ga-changewatch] run failed: ${code} (${errorName(error)})`);
    try {
      if (code === "scope_missing") await clearGaEditGrant(link.credentialId);
      await finishWithError(link, owner, now, code);
    } catch (releaseError) {
      // Kira süresi dolunca bir sonraki tur devralır.
      console.error(
        `[ga-changewatch] state could not be written: ${errorName(releaseError)}`,
      );
    }
    return "processed";
  }
}

// Aday bağlar: birincil, ACTIVE bağlantı, düzenleme izni olan (ya da mock) ve
// 23 saattir koşmamış. İzin listesi SQL'de uygulanır ki izin dışı satırlar
// LIMIT'in başında oturmasın.
async function candidateIds(now: Date, mock: boolean): Promise<string[]> {
  const allowList = gaSyncProjectAllowList();
  const dueBefore = new Date(now.getTime() - RUN_EVERY_MS);
  const allowSql =
    allowList === null
      ? Prisma.empty
      : Prisma.sql`AND l."projectId" = ANY(${allowList}::text[])`;
  const rows = await prisma.$queryRaw<{ id: string }[]>(Prisma.sql`
    SELECT l.id
    FROM "GaPropertyLink" l
    JOIN "IntegrationCredential" c ON c.id = l."credentialId"
    LEFT JOIN "GaChangeWatch" w ON w."linkId" = l.id
    WHERE l."isPrimary"
      AND l."isMock" = ${mock}
      AND c.status = 'ACTIVE'
      AND (c.metadata -> 'gaEdit' IS NOT NULL OR l."isMock")
      AND (w."lastRunAt" IS NULL OR w."lastRunAt" < ${dueBefore})
      ${allowSql}
    ORDER BY w."lastRunAt" NULLS FIRST
    LIMIT ${CANDIDATES}
  `);
  return rows.map((row) => row.id);
}

export const GaChangeWatcher = {
  // Tick adımı `ga-change-watch`. Bayrak kapalıyken sorgusuz 0. Asla fırlatmaz.
  async runDue(
    limit = 3,
    now: Date = new Date(),
    deps: Deps = {},
  ): Promise<number> {
    if (!gaFixesEnabled()) return 0;
    try {
      await Heartbeat.beat(HEARTBEAT_KEY, now);
      const mock = resolveGaFixDeps({ mock: deps.mock }).mock;
      const ids = await candidateIds(now, mock);
      if (ids.length === 0) {
        await Heartbeat.ok(HEARTBEAT_KEY, now);
        return 0;
      }
      const loaded = await prisma.gaPropertyLink.findMany({
        where: { id: { in: ids } },
      });
      const byId = new Map(loaded.map((link) => [link.id, link]));

      let processed = 0;
      for (const id of ids) {
        if (processed >= limit) break;
        const link = byId.get(id);
        if (!link) continue;
        if (!gaSyncAllowedFor(link.projectId)) continue;
        if (!mockMatchesLink(mock, link.isMock)) continue;
        try {
          if ((await watchLink(link, now, { ...deps, mock })) === "processed") {
            processed += 1;
          }
        } catch (error) {
          console.error(`[ga-changewatch] link failed: ${errorName(error)}`);
        }
      }
      await Heartbeat.ok(HEARTBEAT_KEY, now);
      return processed;
    } catch (error) {
      console.error(`[ga-changewatch] tick failed: ${errorName(error)}`);
      return 0;
    }
  },
};
