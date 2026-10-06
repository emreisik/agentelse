import "server-only";

import type { GaPropertyLink } from "@prisma/client";

import { prisma } from "@/lib/prisma";
import { dayKeyInTimezone } from "@/lib/timezone";
import { gaInsightsModeFor } from "@/lib/website-analytics/analysis/flags";
import type { GaRunReportRequest } from "@/lib/website-analytics/catalog";
import { gaDisabledReports } from "@/lib/website-analytics/catalog-state";
import { safeTimezone } from "@/lib/website-analytics/days";
import type {
  GaServerErrors,
  StoredGaQuota,
} from "@/lib/website-analytics/governor";
import type { GaParsedReport } from "@/lib/website-analytics/response";
import { gaMockMode } from "@/server/integrations/google-analytics/data-api";
import { GoogleApiError } from "@/server/integrations/google/errors";
import { getFreshGoogleAccessToken } from "@/server/integrations/google-token";

import { flushGaApiCounters } from "../api-counters";
import { primaryGaLink } from "../store";
import type { GaSyncContext } from "../sync/context";
import {
  GaQuotaDeferred,
  runGaRequests,
  type GaRequestOutcome,
} from "../sync/requests";

// Sohbetin canlı Google Analytics sorgusu (query_website_analytics'in son
// çaresi, docs/website-insights.md "Sohbet"): ambar isteği karşılamayınca P1
// şeridinde tek runReport, çekirdek kota yöneticisinin altında. Proje ve mülk
// günü başına en çok GA_CHAT_LIVE_PER_DAY istek (süreç belleğinde). Sonuç hiçbir
// yere yazılmaz. AGENTELSE_PROVIDER_MODE=mock iken runGaRequests sahte rapor
// döner, Google'a gidilmez.

export const GA_CHAT_LIVE_PER_DAY = 20;

const STOPPED_HEALTH = new Set([
  "AUTH",
  "NEEDS_PERMISSION",
  "ACCESS_LOST",
  "GONE",
  "API_DISABLED",
]);

type LiveFailure = {
  ok: false;
  reason:
    | "off"
    | "not_connected"
    | "reconnect"
    | "quota"
    | "busy"
    | "limit"
    | "error";
};
type LiveResult = { ok: true; report: GaParsedReport } | LiveFailure;

type CredentialRow = { id: string; status: string; encryptedSecret: string };

// "projectId|mülk günü" → o gün yapılan canlı sorgu sayısı.
const used = new Map<string, number>();

function failure(reason: LiveFailure["reason"]): LiveFailure {
  return { ok: false, reason };
}

// Yalnız bu projenin başka günlerinin sayaçları atılır (bellek büyümesin).
// Projeler farklı saat dilimindeki mülklerde: gece yarısı çevresinde başka
// projenin "bugün"ü farklıdır, onun sayacına dokunulmaz.
function sweep(projectId: string, day: string): void {
  const prefix = `${projectId}|`;
  for (const key of used.keys()) {
    if (key.startsWith(prefix) && !key.endsWith(`|${day}`)) used.delete(key);
  }
}

// Sayaç denemeyi sayar: hata da günün payından düşer (kota tüketimi).
function takeSlot(projectId: string, day: string): boolean {
  sweep(projectId, day);
  const key = `${projectId}|${day}`;
  const count = used.get(key) ?? 0;
  if (count >= GA_CHAT_LIVE_PER_DAY) return false;
  used.set(key, count + 1);
  return true;
}

type Resolved =
  { ok: true; link: GaPropertyLink; credential: CredentialRow } | LiveFailure;

async function resolveLink(projectId: string): Promise<Resolved> {
  if (gaInsightsModeFor(projectId) !== "on") return failure("off");
  const link = await primaryGaLink(projectId);
  if (!link) return failure("not_connected");
  if (STOPPED_HEALTH.has(link.health)) return failure("reconnect");
  const credential = await prisma.integrationCredential.findUnique({
    where: { id: link.credentialId },
    select: { id: true, status: true, encryptedSecret: true },
  });
  if (!credential || credential.status !== "ACTIVE") {
    return failure("reconnect");
  }
  return { ok: true, link, credential };
}

async function accessToken(credential: CredentialRow): Promise<string> {
  return gaMockMode()
    ? "mock-access-token"
    : getFreshGoogleAccessToken(credential);
}

function googleClass(error: unknown): string {
  return error instanceof GoogleApiError ? error.errorClass : "UNKNOWN";
}

// live.ts mapError ile aynı eşleme; ham hata metni loglanmaz.
function mapError(error: unknown): LiveFailure {
  if (error instanceof GaQuotaDeferred) {
    return failure(error.reason === "CONCURRENCY" ? "busy" : "quota");
  }
  if (error instanceof GoogleApiError) {
    switch (error.errorClass) {
      case "AUTH":
      case "SCOPE_MISSING":
      case "PERMISSION":
        return failure("reconnect");
      case "RATE_LIMIT":
      case "QUOTA_DAILY":
        return failure("quota");
    }
  }
  console.warn(
    `[ga-chat-live] query could not be read (${googleClass(error)})`,
  );
  return failure("error");
}

export async function runWebsiteLiveQuery(
  projectId: string,
  request: GaRunReportRequest,
  now: Date = new Date(),
): Promise<LiveResult> {
  const resolved = await resolveLink(projectId);
  if (!resolved.ok) return resolved;
  const { link, credential } = resolved;
  const timeZone = safeTimezone(link.timeZone);
  const today = dayKeyInTimezone(now, timeZone);
  if (!takeSlot(projectId, today)) return failure("limit");

  try {
    const ctx: GaSyncContext = {
      link,
      accessToken: await accessToken(credential),
      timeZone,
      today,
      now,
      lane: "P1",
      disabled: gaDisabledReports(link.catalog),
      quota: (link.lastQuota ?? null) as StoredGaQuota | null,
      serverErrors: (link.serverErrorsHour ?? null) as GaServerErrors | null,
      rateLimitedUntil: link.rateLimitedUntil,
    };
    let outcome: GaRequestOutcome | undefined;
    try {
      [outcome] = await runGaRequests(ctx, [request], "P1");
    } finally {
      void flushGaApiCounters().catch(() => {});
    }
    if (!outcome) return mapError(null);
    // Geçersiz istek (400) hata olarak döner, atılmaz.
    if (!outcome.ok) return mapError(outcome.error);
    return { ok: true, report: outcome.report };
  } catch (error) {
    return mapError(error);
  }
}

// Testler için.
export function resetWebsiteLiveQueryLimits(): void {
  used.clear();
}
