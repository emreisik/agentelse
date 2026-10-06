import "server-only";

import { Prisma, type GscSiteLink, type SeoFinding } from "@prisma/client";

import { prisma } from "@/lib/prisma";
import { dateToDayKey, dayKeyToDate } from "@/lib/seo/dates";
import {
  DECIDED_LOOKBACK_DAYS,
  EVALUATION_WINDOW_DAYS,
  nextStatusFor,
  planLifecycle,
  type ExistingFindingRow,
  type SeoDecision,
} from "@/lib/seo/finding-lifecycle";
import {
  SEO_DISMISS_REASONS,
  SEO_FINDING_STATUSES,
  isSeoRuleKey,
  type SeoActionKind,
  type SeoConfidence,
  type SeoDismissReason,
  type SeoEffort,
  type SeoEvidence,
  type SeoFindingDraft,
  type SeoFindingKind,
  type SeoFindingStatus,
  type SeoImpact,
  type SeoRuleKey,
  type SeoSeverity,
  type SeoShadowVerdict,
} from "@/lib/seo/opportunity-types";
import type { SeoRulesRun } from "@/lib/seo/rules";
import { seoFindingFingerprint } from "@/lib/seo/rules/fingerprint";
import { AuditLogRepository } from "@/server/repositories/audit-log.repository";
import { primaryGscLink } from "@/server/seo/store";

// SeoFinding yazımı ve okuması (docs/search-opportunities.md "Bulgu yaşam
// döngüsü"): kurallar taslak verir, yaşam döngüsü planı (src/lib/seo/
// finding-lifecycle.ts) tek transaction'da uygulanır. Bağın bütün OPEN ve
// ACCEPTED satırları, son 120 günde karar verilmiş DISMISSED/DONE satırları
// ve bu koşunun parmak izleri okunur (kural süzgeci yok: süre dolması ancak
// böyle çalışır). Kullanıcı kararları gölge satırları reddeder; AuditLog'a
// yalnız kural, karar ve gerekçe kodu yazılır (Google metni yok).

const DAY_MS = 86_400_000;
const TX_TIMEOUT_MS = 30_000;
const LIST_DEFAULT = 20;
const LIST_MAX = 100;

export type PersistResult = {
  created: SeoFinding[];
  updated: number;
  touched: number;
  superseded: number;
  resolved: number;
  expired: number;
  suppressed: number;
};

export type SeoFindingView = {
  id: string;
  ruleKey: SeoRuleKey;
  kind: SeoFindingKind;
  status: SeoFindingStatus;
  severity: SeoSeverity;
  confidence: SeoConfidence;
  effort: SeoEffort;
  actionKind: SeoActionKind;
  impact: SeoImpact | null;
  priority: number;
  title: string;
  summary: string;
  explanation: string | null;
  evidence: SeoEvidence;
  periodStart: string;
  periodEnd: string;
  periodKey: string;
  pageId: string | null;
  queryId: string | null;
  clusterId: string | null;
  keyword: string | null;
  ideaIds: string[];
  signalId: string | null;
  shadow: boolean;
  review: SeoShadowVerdict | null;
  createdAt: Date;
  lastSeenAt: Date;
};

function json(value: unknown): Prisma.InputJsonValue {
  return value as Prisma.InputJsonValue;
}

function impactJson(
  impact: SeoImpact | null,
): Prisma.InputJsonValue | typeof Prisma.DbNull {
  return impact ? json(impact) : Prisma.DbNull;
}

function oneOf<T extends string>(
  value: string | null,
  options: readonly T[],
  fallback: T,
): T {
  return options.find((option) => option === value) ?? fallback;
}

const KINDS: readonly SeoFindingKind[] = [
  "OPPORTUNITY",
  "RISK",
  "CHANGE",
  "WIN",
];
const SEVERITIES: readonly SeoSeverity[] = ["INFO", "WARN", "CRITICAL"];
const CONFIDENCES: readonly SeoConfidence[] = ["SIGNIFICANT", "DIRECTIONAL"];
const EFFORTS: readonly SeoEffort[] = ["S", "M", "L", "VARIES"];
const ACTIONS: readonly SeoActionKind[] = [
  "TITLE_META",
  "CONTENT_REFRESH",
  "NEW_CONTENT",
  "INTERNAL_LINKS",
  "CONSOLIDATE",
  "TECH_FIX",
  "SCHEMA",
  "LOCALIZE",
  "INVESTIGATE",
];
const VERDICTS: readonly SeoShadowVerdict[] = ["USEFUL", "NOT_USEFUL"];

function parseImpact(value: Prisma.JsonValue | null): SeoImpact | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const num = (key: string): number | null =>
    typeof record[key] === "number" && Number.isFinite(record[key])
      ? (record[key] as number)
      : null;
  if (record.kind === "clicks") {
    const perMonth = num("perMonth");
    if (perMonth === null) return null;
    return {
      kind: "clicks",
      perMonth,
      low: num("low") ?? perMonth,
      high: num("high") ?? perMonth,
    };
  }
  if (record.kind === "reach") {
    const impressionsPerMonth = num("impressionsPerMonth");
    return impressionsPerMonth === null
      ? null
      : { kind: "reach", impressionsPerMonth };
  }
  return null;
}

// Saklanan kanıt motorun kendi yazdığı SeoEvidence'tır; bozuksa boş metrikli
// pencere.
function parseEvidence(
  value: Prisma.JsonValue,
  fallback: { from: string; to: string },
): SeoEvidence {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { window: fallback, metrics: {} };
  }
  const record = value as Record<string, unknown>;
  const metrics =
    record.metrics &&
    typeof record.metrics === "object" &&
    !Array.isArray(record.metrics)
      ? (record.metrics as Record<string, number>)
      : {};
  const window =
    record.window && typeof record.window === "object"
      ? (record.window as { from: string; to: string })
      : fallback;
  return { ...(record as unknown as SeoEvidence), window, metrics };
}

export function findingViewOf(row: SeoFinding): SeoFindingView {
  const periodStart = dateToDayKey(row.periodStart);
  const periodEnd = dateToDayKey(row.periodEnd);
  return {
    id: row.id,
    ruleKey: isSeoRuleKey(row.ruleKey) ? row.ruleKey : "SO1_STRIKING_DISTANCE",
    kind: oneOf(row.kind, KINDS, "OPPORTUNITY"),
    status: oneOf(row.status, SEO_FINDING_STATUSES, "OPEN"),
    severity: oneOf(row.severity, SEVERITIES, "INFO"),
    confidence: oneOf(row.confidence, CONFIDENCES, "DIRECTIONAL"),
    effort: oneOf(row.effort, EFFORTS, "VARIES"),
    actionKind: oneOf(row.actionKind, ACTIONS, "INVESTIGATE"),
    impact: parseImpact(row.impact),
    priority: row.priority,
    title: row.title,
    summary: row.summary,
    explanation: row.explanation,
    evidence: parseEvidence(row.evidence, { from: periodStart, to: periodEnd }),
    periodStart,
    periodEnd,
    periodKey: row.periodKey,
    pageId: row.pageId,
    queryId: row.queryId,
    clusterId: row.clusterId,
    keyword: row.keyword,
    ideaIds: row.ideaIds,
    signalId: row.signalId,
    shadow: row.shadow,
    review: VERDICTS.find((verdict) => verdict === row.review) ?? null,
    createdAt: row.createdAt,
    lastSeenAt: row.lastSeenAt,
  };
}

// Taslağın her yeniden görülüşte tazelenen alanları.
function refreshedFields(draft: SeoFindingDraft) {
  return {
    title: draft.title,
    summary: draft.summary,
    evidence: json(draft.evidence),
    impact: impactJson(draft.impact),
    priority: draft.priority,
    severity: draft.severity,
    confidence: draft.confidence,
  };
}

export async function persistFindings(input: {
  link: Pick<GscSiteLink, "id" | "projectId" | "workspaceId">;
  run: SeoRulesRun;
  mode: "shadow" | "on";
  now: Date;
}): Promise<PersistResult> {
  const { link, run, mode, now } = input;
  const drafts = new Map<string, SeoFindingDraft>();
  for (const draft of run.drafts) {
    const fingerprint = seoFindingFingerprint({
      linkId: link.id,
      ruleKey: draft.ruleKey,
      subject: draft.subject,
      periodKey: draft.periodKey,
    });
    if (!drafts.has(fingerprint)) drafts.set(fingerprint, draft);
  }
  const fingerprints = [...drafts.keys()];

  const existing: ExistingFindingRow[] = await prisma.seoFinding.findMany({
    where: {
      linkId: link.id,
      OR: [
        { status: { in: ["OPEN", "ACCEPTED"] } },
        {
          status: { in: ["DISMISSED", "DONE"] },
          decidedAt: {
            gte: new Date(now.getTime() - DECIDED_LOOKBACK_DAYS * DAY_MS),
          },
        },
        ...(fingerprints.length > 0
          ? [{ fingerprint: { in: fingerprints } }]
          : []),
      ],
    },
    select: {
      id: true,
      fingerprint: true,
      ruleKey: true,
      subject: true,
      status: true,
      decidedAt: true,
      evaluateAfter: true,
      lastSeenAt: true,
      shadow: true,
    },
  });

  const plan = planLifecycle({
    drafts: [...drafts.entries()].map(([fingerprint, draft]) => ({
      fingerprint,
      ruleKey: draft.ruleKey,
      subject: draft.subject,
    })),
    seen: run.seen,
    existing,
    evaluated: run.evaluated,
    mode,
    now,
  });

  const created = await prisma.$transaction(
    async (tx) => {
      const carryIds = plan.create
        .map((item) => item.carryFrom)
        .filter((id): id is string => id !== null);
      const carried = new Map(
        (carryIds.length > 0
          ? await tx.seoFinding.findMany({
              where: { id: { in: carryIds } },
              select: {
                id: true,
                explanation: true,
                explainedAt: true,
                signalId: true,
                ideaIds: true,
              },
            })
          : []
        ).map((row) => [row.id, row]),
      );

      // Önce eski satırlar kapanır, sonra yenileri yazılır.
      const close = async (ids: string[], status: SeoFindingStatus) => {
        if (ids.length === 0) return;
        await tx.seoFinding.updateMany({
          where: { id: { in: ids }, status: "OPEN" },
          data: { status },
        });
      };
      await close(plan.supersede, "SUPERSEDED");
      await close(plan.resolve, "RESOLVED");
      await close(plan.expire, "EXPIRED");
      if (plan.touch.length > 0) {
        await tx.seoFinding.updateMany({
          where: { id: { in: plan.touch } },
          data: { lastSeenAt: now },
        });
      }
      for (const item of plan.update) {
        const draft = drafts.get(item.fingerprint);
        if (!draft) continue;
        await tx.seoFinding.update({
          where: { id: item.id },
          data: {
            ...refreshedFields(draft),
            lastSeenAt: now,
            ...(item.unshadow ? { shadow: false } : {}),
            ...(item.reopen ? { status: "OPEN" } : {}),
          },
        });
      }

      const rows: SeoFinding[] = [];
      for (const item of plan.create) {
        const draft = drafts.get(item.fingerprint);
        if (!draft) continue;
        const from = item.carryFrom ? carried.get(item.carryFrom) : undefined;
        rows.push(
          await tx.seoFinding.create({
            data: {
              workspaceId: link.workspaceId,
              projectId: link.projectId,
              linkId: link.id,
              ruleKey: draft.ruleKey,
              ruleVersion: draft.ruleVersion,
              kind: draft.kind,
              subject: draft.subject,
              periodStart: dayKeyToDate(draft.periodStart),
              periodEnd: dayKeyToDate(draft.periodEnd),
              periodKey: draft.periodKey,
              status: "OPEN",
              shadow: mode === "shadow",
              effort: draft.effort,
              actionKind: draft.actionKind,
              keyword: draft.keyword,
              ideaWorthy: draft.ideaWorthy,
              signalWorthy: draft.signalWorthy,
              fingerprint: item.fingerprint,
              pageId: draft.pageId,
              queryId: draft.queryId,
              clusterId: draft.clusterId,
              lastSeenAt: now,
              ...refreshedFields(draft),
              ...(from
                ? {
                    explanation: from.explanation,
                    explainedAt: from.explainedAt,
                    signalId: from.signalId,
                    ideaIds: from.ideaIds,
                  }
                : {}),
            },
          }),
        );
      }
      return rows;
    },
    { timeout: TX_TIMEOUT_MS },
  );

  return {
    created,
    updated: plan.update.length,
    touched: plan.touch.length,
    superseded: plan.supersede.length,
    resolved: plan.resolve.length,
    expired: plan.expire.length,
    suppressed: plan.suppressed,
  };
}

const DECISION_ACTION: Record<SeoDecision, string> = {
  ACCEPT: "seo_finding.accepted",
  DISMISS: "seo_finding.dismissed",
  DONE: "seo_finding.done",
};

export async function decideFinding(input: {
  projectId: string;
  findingId: string;
  decision: SeoDecision;
  reason?: SeoDismissReason;
  userId: string;
  now?: Date;
}): Promise<
  | { ok: true; status: SeoFindingStatus }
  | { ok: false; reason: "not_found" | "invalid_transition" | "shadow" }
> {
  const now = input.now ?? new Date();
  const row = await prisma.seoFinding.findFirst({
    where: { id: input.findingId, projectId: input.projectId },
    select: {
      id: true,
      workspaceId: true,
      ruleKey: true,
      status: true,
      shadow: true,
      actionKind: true,
    },
  });
  if (!row) return { ok: false, reason: "not_found" };
  if (row.shadow) return { ok: false, reason: "shadow" };
  const current = oneOf(row.status, SEO_FINDING_STATUSES, "OPEN");
  if (current !== row.status)
    return { ok: false, reason: "invalid_transition" };
  const next = nextStatusFor(input.decision, current);
  if (!next) return { ok: false, reason: "invalid_transition" };

  const reason =
    input.decision === "DISMISS" &&
    input.reason &&
    SEO_DISMISS_REASONS.includes(input.reason)
      ? input.reason
      : null;
  let evaluateAfter: Date | null | undefined;
  if (input.decision === "DONE") {
    const days =
      EVALUATION_WINDOW_DAYS[oneOf(row.actionKind, ACTIONS, "INVESTIGATE")];
    evaluateAfter =
      days === null ? null : new Date(now.getTime() + days * DAY_MS);
  }
  const updated = await prisma.seoFinding.updateMany({
    where: { id: row.id, status: row.status, shadow: false },
    data: {
      status: next,
      decidedAt: now,
      decidedByUserId: input.userId,
      dismissReason: reason,
      ...(evaluateAfter !== undefined ? { evaluateAfter } : {}),
    },
  });
  if (updated.count !== 1) return { ok: false, reason: "invalid_transition" };

  await AuditLogRepository.record({
    workspaceId: row.workspaceId,
    projectId: input.projectId,
    actorType: "USER",
    actorId: input.userId,
    action: DECISION_ACTION[input.decision],
    entityType: "SeoFinding",
    entityId: row.id,
    metadata: {
      ruleKey: row.ruleKey,
      decision: input.decision,
      ...(reason ? { reason } : {}),
    },
  });
  return { ok: true, status: next };
}

// Gölge inceleme (platform operatörü, kendi projesinde; izin denetimi
// çağıranda).
export async function reviewShadowFinding(input: {
  projectId: string;
  findingId: string;
  verdict: SeoShadowVerdict;
  userId: string;
  now?: Date;
}): Promise<boolean> {
  if (!VERDICTS.includes(input.verdict)) return false;
  const row = await prisma.seoFinding.findFirst({
    where: { id: input.findingId, projectId: input.projectId },
    select: { id: true, workspaceId: true, ruleKey: true },
  });
  if (!row) return false;
  await prisma.seoFinding.update({
    where: { id: row.id },
    data: {
      review: input.verdict,
      reviewedAt: input.now ?? new Date(),
      reviewedByUserId: input.userId,
    },
  });
  await AuditLogRepository.record({
    workspaceId: row.workspaceId,
    projectId: input.projectId,
    actorType: "USER",
    actorId: input.userId,
    action: "seo_finding.reviewed",
    entityType: "SeoFinding",
    entityId: row.id,
    metadata: { ruleKey: row.ruleKey, verdict: input.verdict },
  });
  return true;
}

// Yalnız projenin şu anki birincil bağı; bayrak denetimi çağıranda.
export async function listProjectFindings(
  projectId: string,
  options: {
    statuses?: readonly SeoFindingStatus[];
    shadow?: boolean;
    limit?: number;
    ruleKeys?: readonly SeoRuleKey[];
    pageId?: string;
    periodKey?: string;
  } = {},
): Promise<SeoFindingView[]> {
  const link = await primaryGscLink(projectId);
  if (!link) return [];
  const limit = Math.min(
    LIST_MAX,
    Math.max(1, Math.floor(options.limit ?? LIST_DEFAULT)),
  );
  const rows = await prisma.seoFinding.findMany({
    where: {
      linkId: link.id,
      status: { in: [...(options.statuses ?? ["OPEN", "ACCEPTED"])] },
      shadow: options.shadow ?? false,
      ...(options.ruleKeys ? { ruleKey: { in: [...options.ruleKeys] } } : {}),
      ...(options.pageId ? { pageId: options.pageId } : {}),
      ...(options.periodKey ? { periodKey: options.periodKey } : {}),
    },
    orderBy: [{ priority: "desc" }, { createdAt: "desc" }],
    take: limit,
  });
  return rows.filter((row) => isSeoRuleKey(row.ruleKey)).map(findingViewOf);
}

// ?opportunity=<id>: eski (SUPERSEDED) bağlantı aynı konunun güncel satırını
// vurgular.
export async function resolveFindingHighlight(
  projectId: string,
  findingId: string,
): Promise<string | null> {
  const row = await prisma.seoFinding.findFirst({
    where: { id: findingId, projectId },
    select: {
      id: true,
      status: true,
      linkId: true,
      ruleKey: true,
      subject: true,
    },
  });
  if (!row) return null;
  if (row.status === "OPEN" || row.status === "ACCEPTED") return row.id;
  if (row.status !== "SUPERSEDED") return null;
  const current = await prisma.seoFinding.findFirst({
    where: {
      linkId: row.linkId,
      ruleKey: row.ruleKey,
      subject: row.subject,
      status: { in: ["OPEN", "ACCEPTED"] },
    },
    orderBy: { createdAt: "desc" },
    select: { id: true },
  });
  return current?.id ?? null;
}

// Çıktı adımları (açıklama, sinyal, fikir bağları) için.
export async function setFindingOutputs(
  findingId: string,
  patch: {
    explanation?: string | null;
    explainedAt?: Date;
    signalId?: string;
    ideaIds?: string[];
  },
): Promise<void> {
  await prisma.seoFinding.update({
    where: { id: findingId },
    data: {
      ...(patch.explanation !== undefined
        ? { explanation: patch.explanation }
        : {}),
      ...(patch.explainedAt !== undefined
        ? { explainedAt: patch.explainedAt }
        : {}),
      ...(patch.signalId !== undefined ? { signalId: patch.signalId } : {}),
      ...(patch.ideaIds !== undefined ? { ideaIds: patch.ideaIds } : {}),
    },
  });
}
