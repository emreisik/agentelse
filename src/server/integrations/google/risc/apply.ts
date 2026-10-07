import "server-only";

import type { Prisma } from "@prisma/client";

import {
  riscActionFor,
  type RiscEvent,
  type RiscTokenIdentifier,
} from "@/lib/google-risc/events";
import { matchRiscTokenIdentifier } from "@/lib/google-risc/token-id";
import { prisma } from "@/lib/prisma";
import { gaAlertDedupeKey } from "@/lib/website-analytics/health/registry";
import { forgetGoogleAccessTokens } from "@/server/integrations/google/access-token";
import { decryptGoogleSecret } from "@/server/integrations/google/secret";
import { SiteAlerts } from "@/server/monitoring/site-alerts";
import { AuditLogRepository } from "@/server/repositories/audit-log.repository";

// RISC olaylarının uygulanması (docs/website-agency.md "RISC"). Google'ın
// subject kimliği (sub) hiçbir yere yazılmaz; yalnız bağlantıların kendi
// metadata.googleSub değeriyle eşleştirilir. Uygulama idempotenttir: yalnız
// ACTIVE bağlantılar EXPIRED yapılır, ikinci teslimat hiçbir şey değiştirmez.
// account-purged yalnız EXPIRE eder (veri silme sahip kararı: geri alınamaz).

const PROVIDERS = ["google_analytics", "google_search_console"];
// Tek token iptalinde ayrı şifreli metinler sayfa sayfa taranır; sayfa
// sınırı ve süre bütçesi aşılırsa sonuç NO_MATCH değil RECHECK olur (taranmamış
// bağlantı "eşleşme yok" diye sessizce geçilmez).
const TOKEN_SCAN_PAGE = 500;
const TOKEN_SCAN_MAX_PAGES = 40;
const TOKEN_SCAN_BUDGET_MS = 20_000;

export type RiscApplyResult = {
  outcome: "APPLIED" | "RECHECK" | "NO_MATCH" | "IGNORED";
  matched: number;
};

type Outcome = RiscApplyResult["outcome"];
const PRIORITY: Record<Outcome, number> = {
  APPLIED: 3,
  RECHECK: 2,
  NO_MATCH: 1,
  IGNORED: 0,
};

type CredentialRow = {
  id: string;
  workspaceId: string;
  projectId: string;
  brandId: string;
  provider: string;
  metadata: Prisma.JsonValue;
};

const CREDENTIAL_SELECT = {
  id: true,
  workspaceId: true,
  projectId: true,
  brandId: true,
  provider: true,
  metadata: true,
} as const;

function logFailure(step: string, error: unknown): void {
  // Yalnız hata adı: ileti Google verisi ya da kimlik taşıyabilir.
  console.error(
    `[google-risc] ${step} failed:`,
    error instanceof Error ? error.name : "unknown error",
  );
}

async function raiseGaAlerts(
  links: { id: string; projectId: string; workspaceId: string }[],
  now: Date,
): Promise<void> {
  for (const link of links) {
    try {
      await SiteAlerts.raise(
        {
          workspaceId: link.workspaceId,
          projectId: link.projectId,
          source: "GA4",
          kind: "GA_MH24",
          severity: "CRITICAL",
          dedupeKey: gaAlertDedupeKey(link.id, "MH24"),
          title: "Google Analytics access was revoked",
          detail:
            "Google told us this account's access was revoked. Reconnect to keep your data flowing.",
        },
        now,
      );
    } catch (error) {
      logFailure("GA alert", error);
    }
  }
}

async function raiseGscAlerts(
  links: { projectId: string; workspaceId: string }[],
  now: Date,
): Promise<void> {
  // Proje başına tek uyarı: GSC_CONNECTION proje düzeyindedir.
  const projects = new Map<string, string>();
  for (const link of links) projects.set(link.projectId, link.workspaceId);
  for (const [projectId, workspaceId] of projects) {
    try {
      await SiteAlerts.raise(
        {
          workspaceId,
          projectId,
          source: "GSC",
          kind: "GSC_CONNECTION",
          severity: "CRITICAL",
          dedupeKey: "gsc:GSC_CONNECTION",
          title: "Search Console access was revoked",
          detail:
            "Google told us this account's access was revoked. Reconnect to keep your data flowing.",
        },
        now,
      );
    } catch (error) {
      logFailure("Search Console alert", error);
    }
  }
}

// Bağlantıyı EXPIRED yapar ve bağlarını AUTH'a çeker. Bağlar ÖNCE yazılır:
// yazma yarıda kalırsa bağlantı hâlâ ACTIVE olduğundan Google'ın yeniden
// denemesi aynı adımları tekrar eder. Dönen değer: bu çağrı mı EXPIRE etti.
async function revokeCredential(
  row: CredentialRow,
  eventKey: string,
  now: Date,
): Promise<boolean> {
  const analytics = row.provider === "google_analytics";
  const clearLease = { syncLeaseUntil: null, syncLeaseOwner: null } as const;
  let links: { id: string; projectId: string; workspaceId: string }[];
  if (analytics) {
    links = await prisma.gaPropertyLink.findMany({
      where: { credentialId: row.id },
      select: { id: true, projectId: true, workspaceId: true },
    });
    await prisma.gaPropertyLink.updateMany({
      where: { credentialId: row.id },
      data: {
        health: "AUTH",
        healthReason: "Reconnect Google Analytics",
        ...clearLease,
      },
    });
  } else {
    // SeoHealth bağlantı denetimi GscSiteLink.health OK kaldıkça GSC_CONNECTION
    // uyarısını kapatır; her bağ (SC-F9 ek siteleri dahil) AUTH'a çekilir.
    links = await prisma.gscSiteLink.findMany({
      where: { credentialId: row.id },
      select: { id: true, projectId: true, workspaceId: true },
    });
    await prisma.gscSiteLink.updateMany({
      where: { credentialId: row.id },
      data: {
        health: "AUTH",
        healthReason: "Reconnect Search Console",
        ...clearLease,
      },
    });
  }

  const metadata =
    row.metadata !== null &&
    typeof row.metadata === "object" &&
    !Array.isArray(row.metadata)
      ? row.metadata
      : {};
  const expired = await prisma.integrationCredential.updateMany({
    where: { id: row.id, status: "ACTIVE" },
    data: {
      status: "EXPIRED",
      metadata: {
        ...metadata,
        googleHealth: {
          state: "NEEDS_RECONNECT",
          checkedAt: now.toISOString(),
          source: "risc",
        },
      } as Prisma.InputJsonValue,
    },
  });
  if (expired.count === 0) return false;
  forgetGoogleAccessTokens(row.id);

  if (analytics) await raiseGaAlerts(links, now);
  else await raiseGscAlerts(links, now);

  try {
    await AuditLogRepository.record({
      workspaceId: row.workspaceId,
      projectId: row.projectId,
      brandId: row.brandId,
      actorType: "SYSTEM",
      action: "google_risc.credential_expired",
      entityType: "IntegrationCredential",
      entityId: row.id,
      metadata: { event: eventKey },
    });
  } catch (error) {
    logFailure("audit log", error);
  }
  return true;
}

async function revokeRows(
  rows: readonly CredentialRow[],
  eventKey: string,
  now: Date,
): Promise<number> {
  let revoked = 0;
  for (const row of rows) {
    if (await revokeCredential(row, eventKey, now)) revoked += 1;
  }
  return revoked;
}

async function applyBySub(
  event: RiscEvent,
  now: Date,
): Promise<RiscApplyResult> {
  if (!event.sub) return { outcome: "IGNORED", matched: 0 };
  const rows = await prisma.integrationCredential.findMany({
    where: {
      provider: { in: PROVIDERS },
      status: "ACTIVE",
      metadata: { path: ["googleSub"], equals: event.sub },
    },
    select: CREDENTIAL_SELECT,
  });
  if (rows.length === 0) return { outcome: "NO_MATCH", matched: 0 };
  const matched = await revokeRows(rows, event.key, now);
  return { outcome: matched > 0 ? "APPLIED" : "NO_MATCH", matched };
}

async function applyByToken(
  event: RiscEvent,
  identifier: RiscTokenIdentifier,
  now: Date,
): Promise<RiscApplyResult> {
  // Boş token'la çağrı yalnız algoritmanın bilinip bilinmediğini söyler:
  // bilinmeyen algoritmada veritabanı taranmaz.
  if (matchRiscTokenIdentifier(identifier, "") === "unknown_alg") {
    return { outcome: "RECHECK", matched: 0 };
  }
  const matching: string[] = [];
  const startedAt = Date.now();
  let after = "";
  let complete = false;
  for (let page = 0; page < TOKEN_SCAN_MAX_PAGES; page += 1) {
    const distinct = await prisma.integrationCredential.findMany({
      where: {
        provider: { in: PROVIDERS },
        status: "ACTIVE",
        // Anahtar kümeli sayfalama: önceki sayfanın son şifreli metninden sonrası.
        encryptedSecret: after ? { gt: after } : { not: "" },
      },
      select: { encryptedSecret: true },
      distinct: ["encryptedSecret"],
      orderBy: { encryptedSecret: "asc" },
      take: TOKEN_SCAN_PAGE,
    });
    for (const { encryptedSecret } of distinct) {
      try {
        const token = decryptGoogleSecret(encryptedSecret);
        if (matchRiscTokenIdentifier(identifier, token) === "match") {
          matching.push(encryptedSecret);
        }
      } catch {
        // Çözülemeyen şifreli metin taramayı durdurmaz.
      }
    }
    if (distinct.length < TOKEN_SCAN_PAGE) {
      complete = true;
      break;
    }
    after = distinct[distinct.length - 1]!.encryptedSecret;
    if (Date.now() - startedAt > TOKEN_SCAN_BUDGET_MS) break;
  }
  if (!complete && matching.length === 0) {
    console.warn("[google-risc] token scan stopped before the end");
    return { outcome: "RECHECK", matched: 0 };
  }
  if (matching.length === 0) return { outcome: "NO_MATCH", matched: 0 };
  const rows = await prisma.integrationCredential.findMany({
    where: {
      provider: { in: PROVIDERS },
      status: "ACTIVE",
      encryptedSecret: { in: matching },
    },
    select: CREDENTIAL_SELECT,
  });
  const matched = await revokeRows(rows, event.key, now);
  return { outcome: matched > 0 ? "APPLIED" : "NO_MATCH", matched };
}

export async function applyRiscEvents(
  events: readonly RiscEvent[],
  now: Date,
): Promise<RiscApplyResult> {
  let outcome: Outcome = "IGNORED";
  let matched = 0;
  for (const event of events) {
    const action = riscActionFor(event.key);
    let result: RiscApplyResult = { outcome: "IGNORED", matched: 0 };
    if (action === "REVOKE") {
      result = await applyBySub(event, now);
    } else if (action === "RECHECK" && event.token) {
      result = await applyByToken(event, event.token, now);
    }
    matched += result.matched;
    if (PRIORITY[result.outcome] > PRIORITY[outcome]) outcome = result.outcome;
  }
  return { outcome, matched };
}
