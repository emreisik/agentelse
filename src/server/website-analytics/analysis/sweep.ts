import "server-only";

import { prisma } from "@/lib/prisma";
import { dayKeyInTimezone } from "@/lib/timezone";
import {
  expiryReason,
  measurementResolvable,
} from "@/lib/website-analytics/analysis/lifecycle";
import {
  isEvaluable,
  isGaRuleKey,
} from "@/lib/website-analytics/analysis/registry";
import { parseGaFindingEvidence } from "@/lib/website-analytics/analysis/stored";
import type {
  GaAn1DayOutcome,
  GaClosedReason,
  GaFindingStatus,
} from "@/lib/website-analytics/analysis/types";
import {
  addDays,
  dateToDayKey,
  safeTimezone,
} from "@/lib/website-analytics/days";

import { loadExcludedDays } from "./inputs";

// GA-F4 kapanış süpürmesi (docs/website-insights.md "Yaşam döngüsü"): her
// analiz turunun sonunda bağın açık ve kabul edilmiş satırları gözden
// geçirilir. Her güncelleme mevcut duruma CAS'tır ve closedAt + closedReason
// yazar.
// - EXPIRED "ttl": kural süresi doldu (lifecycle.ts expiryReason).
// - RESOLVED "measurement": bulgu yazıldıktan sonra şüpheli işaretlenen gün
//   (yalnız kendi şüpheli günlerini dışlamayan AN1, AN2, AN9, AN15).
// - RESOLVED "revised" / "recovered": yalnız günlük kısım bu turda koştuysa
//   (AN1 günü yeniden değerlendirildi ve olağan çıktı; AN15 hedefi bu ay
//   değerlendirildi ve aday üretmedi).

const MEASUREMENT_RULES = new Set(["AN1", "AN2", "AN9", "AN15"]);
const MEASUREMENT_LOOKBACK_DAYS = 60;
const SUSPECT_LOOKBACK_DAYS = 70;
const IDLE_AFTER_MS = 36 * 3_600_000;
const IDLE_SWEEP_LIMIT = 20;

export async function sweepFindings(input: {
  linkId: string;
  today: string;
  now: Date;
  suspect: ReadonlySet<string>;
  daily: {
    an1Days: readonly GaAn1DayOutcome[];
    an15Evaluated: ReadonlySet<string>;
    an15Active: ReadonlySet<string>;
  } | null;
}): Promise<{ expired: number; resolved: number }> {
  const { now, today } = input;
  const rows = await prisma.gaFinding.findMany({
    where: { linkId: input.linkId, status: { in: ["OPEN", "ACCEPTED"] } },
    select: {
      id: true,
      ruleKey: true,
      status: true,
      evidence: true,
      fingerprint: true,
      periodStart: true,
      periodEnd: true,
      createdAt: true,
      acceptedAt: true,
      doneAt: true,
    },
  });
  const revisedDays = new Set(
    (input.daily?.an1Days ?? [])
      .filter((day) => day.outcome === "not_anomalous")
      .map((day) => day.day),
  );
  const lookback = addDays(today, -MEASUREMENT_LOOKBACK_DAYS);

  let expired = 0;
  let resolved = 0;
  const close = async (
    id: string,
    from: string,
    status: "EXPIRED" | "RESOLVED",
    reason: GaClosedReason,
  ) => {
    const updated = await prisma.gaFinding.updateMany({
      where: { id, status: from },
      data: { status, closedReason: reason, closedAt: now },
    });
    return updated.count === 1;
  };

  for (const row of rows) {
    if (!isGaRuleKey(row.ruleKey)) continue;
    const ruleKey = row.ruleKey;
    const status = row.status as GaFindingStatus;
    const evidence = parseGaFindingEvidence(row.evidence);
    const period = {
      from: dateToDayKey(row.periodStart),
      to: dateToDayKey(row.periodEnd),
    };
    if (
      expiryReason({
        ruleKey,
        status,
        createdAt: row.createdAt,
        acceptedAt: row.acceptedAt,
        doneAt: row.doneAt,
        evaluable: evidence ? isEvaluable(ruleKey, evidence) : false,
        periodEnd: period.to,
        today,
        now,
      }) === "ttl"
    ) {
      if (await close(row.id, row.status, "EXPIRED", "ttl")) expired += 1;
      continue;
    }
    if (status !== "OPEN" || !evidence) continue;

    if (
      MEASUREMENT_RULES.has(ruleKey) &&
      period.to >= lookback &&
      period.from <= today &&
      measurementResolvable({
        ruleKey,
        status,
        evidence,
        period,
        suspect: input.suspect,
      })
    ) {
      if (await close(row.id, "OPEN", "RESOLVED", "measurement")) resolved += 1;
      continue;
    }
    if (!input.daily) continue;

    if (
      evidence.rule === "AN1" &&
      evidence.mode === "day" &&
      revisedDays.has(evidence.target)
    ) {
      if (await close(row.id, "OPEN", "RESOLVED", "revised")) resolved += 1;
      continue;
    }
    if (
      ruleKey === "AN15" &&
      input.daily.an15Evaluated.has(row.fingerprint) &&
      !input.daily.an15Active.has(row.fingerprint)
    ) {
      if (await close(row.id, "OPEN", "RESOLVED", "recovered")) resolved += 1;
    }
  }
  return { expired, resolved };
}

// Analizi duran bağlar (sağlık durdu, proje duraklatıldı, günlük veri
// gelmiyor): analiz turu koşmadığı için süpürme de koşmaz. Değerlendirici
// adımı, açık ya da kabul edilmiş satırı olan ve son 36 saatte günlük analiz
// görmemiş bağları (tur başına en çok 20) günlük kısım olmadan süpürür; TTL
// ve ölçüm kapanışları yeni veriye bağlı kalmaz.
export async function sweepIdleLinks(input: {
  now: Date;
  projectIds: readonly string[] | null;
}): Promise<{ expired: number; resolved: number }> {
  const { now } = input;
  const groups = await prisma.gaFinding.groupBy({
    by: ["linkId"],
    where: {
      status: { in: ["OPEN", "ACCEPTED"] },
      ...(input.projectIds ? { projectId: { in: [...input.projectIds] } } : {}),
    },
  });
  if (groups.length === 0) return { expired: 0, resolved: 0 };
  const links = await prisma.gaPropertyLink.findMany({
    where: { id: { in: groups.map((group) => group.linkId) } },
    select: {
      id: true,
      timeZone: true,
      analysisRun: { select: { lastDailyAt: true } },
    },
  });
  const cutoff = now.getTime() - IDLE_AFTER_MS;
  const idle = links
    .filter((link) => {
      const last = link.analysisRun?.lastDailyAt;
      return !last || last.getTime() < cutoff;
    })
    .slice(0, IDLE_SWEEP_LIMIT);

  let expired = 0;
  let resolved = 0;
  for (const link of idle) {
    const today = dayKeyInTimezone(now, safeTimezone(link.timeZone));
    const { suspect } = await loadExcludedDays(link.id, null, {
      from: addDays(today, -SUSPECT_LOOKBACK_DAYS),
      to: today,
    });
    const swept = await sweepFindings({
      linkId: link.id,
      today,
      now,
      suspect,
      daily: null,
    });
    expired += swept.expired;
    resolved += swept.resolved;
  }
  return { expired, resolved };
}
