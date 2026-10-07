import "server-only";

import type { Prisma } from "@prisma/client";

import { dayKeyInTimezone } from "@/lib/timezone";
import { prisma } from "@/lib/prisma";
import { gaFunnelEnabledFor } from "@/lib/website-analytics/agency/flags";
import { isGaEngineLink } from "@/lib/website-analytics/agency/scope";
import { addDays, safeTimezone } from "@/lib/website-analytics/days";
import {
  parseFunnelResponse,
  readStoredFunnelSteps,
} from "@/lib/website-analytics/funnel/parse";
import { buildFunnelRequest } from "@/lib/website-analytics/funnel/request";
import { gaQuotaDecision, nextQuotaDay } from "@/lib/website-analytics/governor";
import type { StoredGaQuota } from "@/lib/website-analytics/governor";
import { GoogleApiError } from "@/server/integrations/google/errors";
import { gaMockMode } from "@/server/integrations/google-analytics/data-api";
import {
  FunnelUnavailableError,
  runGaFunnelReport,
} from "@/server/integrations/google-analytics/funnel-api";
import { getFreshGoogleAccessToken } from "@/server/integrations/google-token";
import { flushGaApiCounters } from "@/server/website-analytics/api-counters";

// Huni çalıştırma (GA-F8, GA_FUNNEL). Kapı sırası: bayrak -> huni+bağ -> sağlık
// -> 10 dk hız sınırı -> kota yöneticisi -> günlük sınır (ÖNCE ARTIR, SONRA
// DENETLE) -> token -> Google. Google hata iletisi saklanmaz; lastError yalnız
// hata sınıfıdır.

export const GA_FUNNEL_RUNS_PER_DAY = 20;
export const GA_FUNNEL_MIN_INTERVAL_MS = 10 * 60_000;
const DEFAULT_RATE_LIMIT_MS = 15 * 60_000;

export type RunFunnelOutcome =
  | "ok"
  | "off"
  | "not_found"
  | "throttled"
  | "daily_limit"
  | "quota"
  | "unavailable"
  | "auth"
  | "failed";

function utcDay(now: Date): string {
  return now.toISOString().slice(0, 10);
}

// Sayacı atomik artırır: bugünün sayacı varsa artırır, yoksa günü sıfırlayıp 1
// yapar. Yarışta (iki çalıştırma aynı anda gün devrediyor) kaybeden taraf
// yeniden dener; ikisi de sayılır.
async function claimRun(
  funnelId: string,
  today: string,
  now: Date,
): Promise<boolean> {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const same = await prisma.gaFunnel.updateMany({
      where: { id: funnelId, runDay: today },
      data: { runsToday: { increment: 1 }, lastRunAt: now },
    });
    if (same.count > 0) return true;
    const fresh = await prisma.gaFunnel.updateMany({
      where: {
        id: funnelId,
        OR: [{ runDay: null }, { runDay: { not: today } }],
      },
      data: { runDay: today, runsToday: 1, lastRunAt: now },
    });
    if (fresh.count > 0) return true;
  }
  return false;
}

// Artırmayı geri alır (sınır aşıldı ya da Google'a hiç gidilmedi); lastRunAt
// önceki değerine döner.
async function releaseRun(
  funnelId: string,
  today: string,
  previousRunAt: Date | null,
): Promise<void> {
  await prisma.gaFunnel.updateMany({
    where: { id: funnelId, runDay: today, runsToday: { gt: 0 } },
    data: { runsToday: { decrement: 1 }, lastRunAt: previousRunAt },
  });
}

export async function runFunnel(input: {
  projectId: string;
  funnelId: string;
  now?: Date;
}): Promise<RunFunnelOutcome> {
  const { projectId, funnelId } = input;
  const now = input.now ?? new Date();
  if (!gaFunnelEnabledFor(projectId)) return "off";

  const funnel = await prisma.gaFunnel.findFirst({
    where: { id: funnelId, projectId },
  });
  if (!funnel) return "not_found";
  const link = await prisma.gaPropertyLink.findFirst({
    where: { id: funnel.linkId, projectId },
  });
  if (!link || !isGaEngineLink(link)) return "not_found";
  const steps = readStoredFunnelSteps(funnel.steps);
  if (!steps) return "failed";

  // Sağlık: OK ve UNKNOWN çalışır, AUTH yeniden bağlanma ister, gerisi hata.
  if (link.health === "AUTH") return "auth";
  if (link.health !== "OK" && link.health !== "UNKNOWN") return "failed";

  if (
    funnel.lastRunAt &&
    now.getTime() - funnel.lastRunAt.getTime() < GA_FUNNEL_MIN_INTERVAL_MS
  ) {
    return "throttled";
  }

  const decision = gaQuotaDecision({
    lane: "P1",
    now,
    stored: (link.lastQuota ?? null) as StoredGaQuota | null,
    rateLimitedUntil: link.rateLimitedUntil,
  });
  if (!decision.ok) return "quota";

  // Günlük sınır: önce bu hunide artır, sonra mülkün toplamını oku. Toplam
  // aşıldıysa artırma geri alınır: eşzamanlı çalıştırmalar sınırı aşamaz
  // (en kötü ihtimalle eksik sayar).
  const today = utcDay(now);
  const previousRunAt = funnel.lastRunAt;
  if (!(await claimRun(funnel.id, today, now))) return "failed";
  const total = await prisma.gaFunnel.aggregate({
    where: { linkId: link.id, runDay: today },
    _sum: { runsToday: true },
  });
  if ((total._sum.runsToday ?? 0) > GA_FUNNEL_RUNS_PER_DAY) {
    await releaseRun(funnel.id, today, previousRunAt);
    return "daily_limit";
  }

  let calledGoogle = false;
  try {
    let accessToken = "mock-access-token";
    if (!gaMockMode()) {
      const credential = await prisma.integrationCredential.findUnique({
        where: { id: link.credentialId },
        select: { id: true, status: true, encryptedSecret: true },
      });
      if (!credential || credential.status !== "ACTIVE") {
        await releaseRun(funnel.id, today, previousRunAt);
        return "auth";
      }
      accessToken = await getFreshGoogleAccessToken(credential);
    }

    // Son `periodDays` tam gün; mülkün dün'ünde biter.
    const endDate = addDays(
      dayKeyInTimezone(now, safeTimezone(link.timeZone)),
      -1,
    );
    const startDate = addDays(endDate, -(funnel.periodDays - 1));
    const request = buildFunnelRequest(
      { isOpen: funnel.isOpen, steps },
      { startDate, endDate },
    );
    calledGoogle = true;
    const raw = await runGaFunnelReport(accessToken, link.propertyId, request);
    const parsed = parseFunnelResponse(
      raw,
      steps.map((step) => step.name),
      endDate,
    );
    if (!parsed) {
      await prisma.gaFunnel.update({
        where: { id: funnel.id },
        data: { lastError: "BAD_RESPONSE" },
      });
      return "failed";
    }
    await prisma.gaFunnel.update({
      where: { id: funnel.id },
      data: {
        lastResult: parsed.result as unknown as Prisma.InputJsonValue,
        lastError: null,
      },
    });
    if (parsed.quota) {
      const stored: StoredGaQuota = {
        at: now.toISOString(),
        quota: parsed.quota,
      };
      await prisma.gaPropertyLink.updateMany({
        where: { propertyId: link.propertyId },
        data: { lastQuota: stored as unknown as Prisma.InputJsonValue },
      });
    }
    return "ok";
  } catch (error) {
    if (error instanceof FunnelUnavailableError) {
      await releaseRun(funnel.id, today, previousRunAt);
      return "unavailable";
    }
    if (!calledGoogle) {
      // Token alınamadı: Data API'ye gidilmedi, hak harcanmaz.
      await releaseRun(funnel.id, today, previousRunAt);
    }
    const errorClass =
      error instanceof GoogleApiError ? error.errorClass : "UNKNOWN";
    await prisma.gaFunnel
      .update({ where: { id: funnel.id }, data: { lastError: errorClass } })
      .catch(() => undefined);
    if (errorClass === "RATE_LIMIT" || errorClass === "QUOTA_DAILY") {
      // Eşzamanlı senkron da durur: kova mülk başınadır.
      const until =
        errorClass === "QUOTA_DAILY"
          ? nextQuotaDay(now)
          : new Date(
              now.getTime() +
                ((error as GoogleApiError).retryAfterMs ??
                  DEFAULT_RATE_LIMIT_MS),
            );
      await prisma.gaPropertyLink.updateMany({
        where: { propertyId: link.propertyId },
        data: { rateLimitedUntil: until },
      });
      return "quota";
    }
    if (errorClass === "AUTH") return "auth";
    return "failed";
  } finally {
    await flushGaApiCounters(now).catch(() => undefined);
  }
}
