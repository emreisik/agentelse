import "server-only";

import { Prisma, type GaPropertyLink } from "@prisma/client";

import { prisma } from "@/lib/prisma";
import {
  gaFindingFingerprint,
  shadowRetiredFingerprint,
  subjectKeyOf,
} from "@/lib/website-analytics/analysis/keys";
import { persistDecision } from "@/lib/website-analytics/analysis/lifecycle";
import { findingPriority } from "@/lib/website-analytics/analysis/priority";
import { gaRule, isEvaluable } from "@/lib/website-analytics/analysis/registry";
import { limitLiveOpportunities } from "@/lib/website-analytics/analysis/run-rules";
import { GA_MAX_NEW_FINDINGS_PER_RUN } from "@/lib/website-analytics/analysis/schedule";
import { parseGaFindingEvidence } from "@/lib/website-analytics/analysis/stored";
import type {
  GaFindingCandidate,
  GaFindingMode,
  GaFindingSeverity,
  GaFindingStatus,
  GaRuleKey,
} from "@/lib/website-analytics/analysis/types";
import { dateToDayKey, dayKeyToDate } from "@/lib/website-analytics/days";

// GA-F4 bulgu yazımı (docs/website-insights.md "Veri modeli"). Parmak izi
// bağ + kural + konu özeti + dönemdir. Adaylar dönem başına artan sırayla
// işlenir: eski dönem yeni satırı asla kapatmaz ("stale"). Koşul kuralı
// önceki OPEN satırı SUPERSEDED yapar (previousId, occurrences+1); olay
// kuralı her dönem kendi satırını alır. Canlı tur aynı parmak izli OPEN
// gölge satırı tek işlemde emekliye ayırıp canlı satırı yazar. Kanıt yalnız
// toplulaştırılmış sayı ve maskelenmiş yol taşır.

type PersistLink = Pick<
  GaPropertyLink,
  "id" | "workspaceId" | "projectId" | "isMock"
>;

export type GaPersistResult = {
  created: string[];
  refreshed: number;
  superseded: number;
  suppressed: number;
  stale: number;
  // Kural başına aday / oluşan / atlanan (GaAnalysisRun.stats)
  byRule: Partial<
    Record<GaRuleKey, { candidates: number; created: number; skipped: number }>
  >;
};

function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as { code?: unknown }).code === "P2002"
  );
}

function json(value: unknown): Prisma.InputJsonValue {
  return value as Prisma.InputJsonValue;
}

// Önce canlı öneri sınırı, sonra öncelikle en çok 20 aday, sonra dönem
// başlangıcına göre artan (eşitlikte öncelik).
function ordered(
  candidates: readonly GaFindingCandidate[],
  mode: GaFindingMode,
): { candidate: GaFindingCandidate; priority: number }[] {
  return limitLiveOpportunities(candidates, mode)
    .map((candidate, index) => ({
      candidate,
      index,
      priority: findingPriority(candidate),
    }))
    .sort((a, b) => b.priority - a.priority || a.index - b.index)
    .slice(0, GA_MAX_NEW_FINDINGS_PER_RUN)
    .sort(
      (a, b) =>
        a.candidate.period.from.localeCompare(b.candidate.period.from) ||
        b.priority - a.priority ||
        a.index - b.index,
    )
    .map(({ candidate, priority }) => ({ candidate, priority }));
}

function createData(input: {
  link: PersistLink;
  candidate: GaFindingCandidate;
  mode: GaFindingMode;
  priority: number;
  subjectKey: string;
  fingerprint: string;
  previous: { id: string; occurrences: number } | null;
}): Prisma.GaFindingUncheckedCreateInput {
  const { link, candidate } = input;
  return {
    workspaceId: link.workspaceId,
    projectId: link.projectId,
    linkId: link.id,
    ruleKey: candidate.ruleKey,
    ruleVersion: gaRule(candidate.ruleKey).version,
    kind: candidate.kind,
    subject: candidate.subject,
    subjectKey: input.subjectKey,
    periodGrain: candidate.period.grain,
    periodKey: candidate.period.key,
    periodStart: dayKeyToDate(candidate.period.from),
    periodEnd: dayKeyToDate(candidate.period.to),
    severity: candidate.severity,
    confidence: candidate.confidence,
    mode: input.mode,
    isMock: link.isMock,
    priority: input.priority,
    evidence: json(candidate.evidence),
    impact: candidate.impact ? json(candidate.impact) : Prisma.JsonNull,
    fingerprint: input.fingerprint,
    ...(input.previous
      ? {
          previousId: input.previous.id,
          occurrences: input.previous.occurrences + 1,
        }
      : {}),
  };
}

export async function persistCandidates(input: {
  link: PersistLink;
  candidates: readonly GaFindingCandidate[];
  mode: GaFindingMode;
  now: Date;
}): Promise<GaPersistResult> {
  const { link, mode, now } = input;
  const result: GaPersistResult = {
    created: [],
    refreshed: 0,
    superseded: 0,
    suppressed: 0,
    stale: 0,
    byRule: {},
  };
  const tally = (
    key: GaRuleKey,
    field: "candidates" | "created" | "skipped",
  ) => {
    const entry = (result.byRule[key] ??= {
      candidates: 0,
      created: 0,
      skipped: 0,
    });
    entry[field] += 1;
  };

  for (const { candidate, priority } of ordered(input.candidates, mode)) {
    const rule = gaRule(candidate.ruleKey);
    const subjectKey = subjectKeyOf(candidate.subject);
    const fingerprint = gaFindingFingerprint({
      linkId: link.id,
      ruleKey: candidate.ruleKey,
      subjectKey,
      periodKey: candidate.period.key,
    });
    tally(candidate.ruleKey, "candidates");
    const base = { link, candidate, mode, priority, subjectKey, fingerprint };
    try {
      const existing = await prisma.gaFinding.findUnique({
        where: { fingerprint },
        select: { id: true, status: true, mode: true },
      });
      if (existing) {
        if (
          existing.status === "OPEN" &&
          (existing.mode === mode || existing.mode === "live")
        ) {
          // Aynı dönem yeniden değerlendirildi (ör. revizyon penceresi).
          await prisma.gaFinding.updateMany({
            where: { id: existing.id, status: "OPEN" },
            data: {
              evidence: json(candidate.evidence),
              impact: candidate.impact
                ? json(candidate.impact)
                : Prisma.JsonNull,
              severity: candidate.severity,
              confidence: candidate.confidence,
              priority,
            },
          });
          result.refreshed += 1;
        } else if (existing.status === "OPEN" && existing.mode === "shadow") {
          // Gölgeden canlıya geçiş: gölge satır kullanıcıya hiç görünmez.
          const [, created] = await prisma.$transaction([
            prisma.gaFinding.updateMany({
              where: { id: existing.id, status: "OPEN", mode: "shadow" },
              data: {
                status: "SUPERSEDED",
                closedReason: "shadow",
                closedAt: now,
                fingerprint: shadowRetiredFingerprint(fingerprint, existing.id),
              },
            }),
            prisma.gaFinding.create({
              data: createData({ ...base, previous: null }),
              select: { id: true },
            }),
          ]);
          result.created.push(created.id);
          result.superseded += 1;
          tally(candidate.ruleKey, "created");
        } else {
          // Kapanmış ya da kullanıcının üzerinde çalıştığı aynı dönem.
          result.suppressed += 1;
          tally(candidate.ruleKey, "skipped");
        }
        continue;
      }

      const latest = await prisma.gaFinding.findFirst({
        where: {
          linkId: link.id,
          ruleKey: candidate.ruleKey,
          subjectKey,
          mode: mode === "live" ? "live" : { in: ["shadow", "live"] },
        },
        orderBy: [{ periodStart: "desc" }, { createdAt: "desc" }],
        select: {
          id: true,
          status: true,
          severity: true,
          dismissedAt: true,
          evidence: true,
          periodStart: true,
          occurrences: true,
        },
      });
      const latestEvidence = latest
        ? parseGaFindingEvidence(latest.evidence)
        : null;
      const decision = persistDecision({
        recurrence: rule.recurrence,
        latest: latest
          ? {
              status: latest.status as GaFindingStatus,
              severity: latest.severity as GaFindingSeverity,
              dismissedAt: latest.dismissedAt,
              evaluable: latestEvidence
                ? isEvaluable(candidate.ruleKey, latestEvidence)
                : false,
              periodStart: dateToDayKey(latest.periodStart),
            }
          : null,
        candidate: {
          severity: candidate.severity,
          periodStart: candidate.period.from,
        },
        now,
      });

      if (decision === "suppress" || decision === "stale") {
        if (decision === "stale") result.stale += 1;
        else result.suppressed += 1;
        tally(candidate.ruleKey, "skipped");
        continue;
      }
      if (decision === "supersede" && latest) {
        const [, created] = await prisma.$transaction([
          prisma.gaFinding.updateMany({
            where: { id: latest.id, status: "OPEN" },
            data: {
              status: "SUPERSEDED",
              closedReason: "newer",
              closedAt: now,
            },
          }),
          prisma.gaFinding.create({
            data: createData({ ...base, previous: latest }),
            select: { id: true },
          }),
        ]);
        result.created.push(created.id);
        result.superseded += 1;
        tally(candidate.ruleKey, "created");
        continue;
      }
      const created = await prisma.gaFinding.create({
        data: createData({
          ...base,
          previous: rule.recurrence === "condition" ? latest : null,
        }),
        select: { id: true },
      });
      result.created.push(created.id);
      tally(candidate.ruleKey, "created");
    } catch (error) {
      // Eşzamanlı tur aynı parmak izini yazdı: yenilenmiş sayılır.
      if (!isUniqueViolation(error)) throw error;
      result.refreshed += 1;
    }
  }
  return result;
}
