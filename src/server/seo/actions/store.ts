import "server-only";

import { Prisma, type SeoAction } from "@prisma/client";

import { prisma } from "@/lib/prisma";
import { normalizeCrawlUrl, crawlUrlHash, pathOf } from "@/lib/seo/crawl-url";
import { seoMockMode } from "@/lib/seo/health-flags";
import { EVALUATION_WINDOW_DAYS } from "@/lib/seo/finding-lifecycle";
import {
  ACTION_LEASE_MS,
  ACTION_WINDOW_DAYS,
  CHECK_NOW_MIN_GAP_MS,
  EVAL_GIVE_UP_DAYS,
  measuringFields,
  nextActionStatus,
  type SeoActionEvent,
} from "@/lib/seo/actions/lifecycle";
import {
  emptyProposal,
  isSeoActionStatus,
  isSeoFixKind,
  parseEvaluation,
  parsePageSnapshot,
  parseProposal,
  parseVerification,
  type PageSnapshot,
  type SeoActionConfidence,
  type SeoActionProposalStored,
  type SeoActionSource,
  type SeoActionStatus,
  type SeoActionView,
  type SeoAppliedVia,
  type SeoFixKind,
  type SeoOutcome,
  type SeoVerification,
  type VerificationMethod,
} from "@/lib/seo/actions/types";
import { AuditLogRepository } from "@/server/repositories/audit-log.repository";
import { primaryGscLink } from "@/server/seo/store";

// SeoAction satırlarının TEK yazarı (docs/search-actions.md "Yaşam döngüsü").
// Doğrulayıcı ve değerlendirici de yazımlarını releaseAction / startMeasuring
// üzerinden yapar. Geçişler CAS ile (updateMany + durum koşulu) yapılır; açık
// eylemin tekilliği openKey üzerindeki benzersiz anahtardır (terminal durumda
// null olur). Denetim kaydına yalnız { kind, source?, status? } yazılır: URL,
// başlık ya da sorgu metni asla.

export type { SeoActionView } from "@/lib/seo/actions/types";

const DAY_MS = 86_400_000;
const LIST_DEFAULT = 50;
const LIST_MAX = 200;
const SOURCES: readonly SeoActionSource[] = [
  "FINDING",
  "SEO_MANAGER",
  "HEALTH_ISSUE",
  "OPPORTUNITY_DONE",
];
const OUTCOMES: readonly SeoOutcome[] = ["WORKED", "DIDNT", "INCONCLUSIVE"];
const CONFIDENCES: readonly SeoActionConfidence[] = [
  "SIGNIFICANT",
  "DIRECTIONAL",
];
const APPLIED_VIA: readonly SeoAppliedVia[] = ["USER", "DETECTED", "CMS"];

function oneOf<T extends string>(
  value: string | null,
  allowed: readonly T[],
): T | null {
  return allowed.find((item) => item === value) ?? null;
}

function json(value: unknown): Prisma.InputJsonValue {
  return value as Prisma.InputJsonValue;
}

function addDays(date: Date, days: number): Date {
  return new Date(date.getTime() + days * DAY_MS);
}

function isUniqueViolation(error: unknown): boolean {
  return (
    error instanceof Prisma.PrismaClientKnownRequestError &&
    error.code === "P2002"
  );
}

function report(scope: string, error: unknown): void {
  console.error(
    `[seo-actions] ${scope}:`,
    error instanceof Error ? error.message : error,
  );
}

// crawlUrlHash(normalizeCrawlUrl(url)); adres geçersizse null.
function hashOf(url: string | null): string | null {
  if (!url) return null;
  const normalized = normalizeCrawlUrl(url);
  return normalized ? crawlUrlHash(normalized) : null;
}

export function actionViewOf(row: SeoAction): SeoActionView {
  const kind: SeoFixKind = isSeoFixKind(row.kind) ? row.kind : "TECH_FIX";
  const status: SeoActionStatus = isSeoActionStatus(row.status)
    ? row.status
    : "PROPOSED";
  return {
    id: row.id,
    projectId: row.projectId,
    workspaceId: row.workspaceId,
    isMock: row.isMock,
    linkId: row.linkId,
    findingId: row.findingId,
    source: oneOf(row.source, SOURCES) ?? "SEO_MANAGER",
    kind,
    status,
    targetUrl: row.targetUrl,
    targetUrlHash: row.targetUrlHash,
    targetPath: row.targetUrl ? pathOf(row.targetUrl) : null,
    pageId: row.pageId,
    targetQueries: row.targetQueries,
    proposal: parseProposal(row.proposal, kind) ?? emptyProposal(kind),
    baseline: parsePageSnapshot(row.baseline),
    verification: parseVerification(row.verification),
    evaluation: parseEvaluation(row.evaluation),
    outcome: oneOf(row.outcome, OUTCOMES),
    confidence: oneOf(row.confidence, CONFIDENCES),
    appliedVia: oneOf(row.appliedVia, APPLIED_VIA),
    appliedAt: row.appliedAt,
    verifiedAt: row.verifiedAt,
    askedAt: row.askedAt,
    measureFrom: row.measureFrom,
    evaluateAfter: row.evaluateAfter,
    evaluatedAt: row.evaluatedAt,
    nextCheckAt: row.nextCheckAt,
    windowDays: row.windowDays,
    commandId: row.commandId,
    workId: row.workId,
    creativeId: row.creativeId,
    learningId: row.learningId,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

async function audit(input: {
  workspaceId: string;
  projectId: string;
  actionId: string;
  userId: string | null;
  action: string;
  metadata: { kind: string; source?: string; status?: string };
}): Promise<void> {
  try {
    await AuditLogRepository.record({
      workspaceId: input.workspaceId,
      projectId: input.projectId,
      actorType: input.userId ? "USER" : "SYSTEM",
      ...(input.userId ? { actorId: input.userId } : {}),
      action: input.action,
      entityType: "SeoAction",
      entityId: input.actionId,
      metadata: input.metadata,
    });
  } catch (error) {
    report("audit could not be written", error);
  }
}

// --- bulgu eşlemesi -----------------------------------------------------------

// Bulgu için değerlendirme penceresi (gün); bulgu türünde yoksa eylem penceresi.
function findingWindowDays(kind: string): number | null {
  const own = (EVALUATION_WINDOW_DAYS as Record<string, number | null>)[kind];
  if (own !== undefined) return own;
  return isSeoFixKind(kind) ? ACTION_WINDOW_DAYS[kind] : null;
}

// Eylem uygulanınca bulgu DONE olur (OPEN | ACCEPTED'dan); W3'ün kararındaki
// alanlarla aynı yazılır. Asla fırlatmaz.
export async function markFindingDone(input: {
  projectId: string;
  findingId: string;
  kindForWindow: string;
  userId: string | null;
  now: Date;
}): Promise<void> {
  try {
    const days = findingWindowDays(input.kindForWindow);
    await prisma.seoFinding.updateMany({
      where: {
        id: input.findingId,
        projectId: input.projectId,
        status: { in: ["OPEN", "ACCEPTED"] },
      },
      data: {
        status: "DONE",
        decidedAt: input.now,
        decidedByUserId: input.userId,
        evaluateAfter: days === null ? null : addDays(input.now, days),
      },
    });
  } catch (error) {
    report("finding could not be marked done", error);
  }
}

// "Not done yet": henüz değerlendirilmemiş DONE bulgu ACCEPTED'a döner.
export async function revertFindingDone(input: {
  projectId: string;
  findingId: string;
}): Promise<void> {
  try {
    await prisma.seoFinding.updateMany({
      where: {
        id: input.findingId,
        projectId: input.projectId,
        status: "DONE",
        evaluatedAt: null,
      },
      data: { status: "ACCEPTED", evaluateAfter: null },
    });
  } catch (error) {
    report("finding could not be reverted", error);
  }
}

// --- okuyucular ---------------------------------------------------------------

export async function getAction(
  projectId: string,
  actionId: string,
): Promise<SeoActionView | null> {
  const row = await prisma.seoAction.findFirst({
    where: { id: actionId, projectId, isMock: seoMockMode() },
  });
  return row ? actionViewOf(row) : null;
}

export async function findOpenAction(
  projectId: string,
  openKey: string,
): Promise<SeoActionView | null> {
  const row = await prisma.seoAction.findFirst({
    where: { projectId, isMock: seoMockMode(), openKey },
  });
  return row ? actionViewOf(row) : null;
}

// Kartın eylemi: bir kart en çok bir eylem taşır; terminal olsa da en yenisi.
export async function actionForCard(
  projectId: string,
  commandId: string,
): Promise<SeoActionView | null> {
  const row = await prisma.seoAction.findFirst({
    where: { projectId, isMock: seoMockMode(), commandId },
    orderBy: { createdAt: "desc" },
  });
  return row ? actionViewOf(row) : null;
}

export async function listActions(
  projectId: string,
  options: {
    statuses?: readonly SeoActionStatus[];
    since?: Date;
    limit?: number;
  } = {},
): Promise<SeoActionView[]> {
  const limit = Math.min(
    LIST_MAX,
    Math.max(1, Math.floor(options.limit ?? LIST_DEFAULT)),
  );
  const rows = await prisma.seoAction.findMany({
    where: {
      projectId,
      isMock: seoMockMode(),
      ...(options.statuses ? { status: { in: [...options.statuses] } } : {}),
      ...(options.since ? { updatedAt: { gte: options.since } } : {}),
    },
    orderBy: { updatedAt: "desc" },
    take: limit,
  });
  return rows.map(actionViewOf);
}

// --- oluşturma ----------------------------------------------------------------

function freshVerification(): SeoVerification {
  return parseVerification(null);
}

export async function createSeoAction(input: {
  workspaceId: string;
  projectId: string;
  kind: SeoFixKind;
  source: SeoActionSource;
  status: "PROPOSED" | "ACCEPTED" | "APPLIED";
  openKey: string | null;
  // undefined: birincil bağdan çöz; null ve değer açıkça kazanır
  linkId?: string | null;
  targetUrl: string | null;
  pageId: string | null;
  targetQueries: string[];
  proposal: SeoActionProposalStored;
  baseline?: PageSnapshot | null;
  findingId?: string | null;
  commandId?: string | null;
  workId?: string | null;
  creativeId?: string | null;
  nextCheckAt?: Date | null;
  userId: string | null;
  now?: Date;
}): Promise<{ action: SeoActionView; created: boolean }> {
  const now = input.now ?? new Date();
  const isMock = seoMockMode();

  let linkId: string | null;
  if (input.linkId !== undefined) {
    linkId = input.linkId;
  } else {
    const link = await primaryGscLink(input.projectId);
    linkId = link && link.isMock === isMock ? link.id : null;
  }

  const applied = input.status === "APPLIED";
  const liveArticle =
    input.status === "ACCEPTED" &&
    input.creativeId &&
    (input.kind === "NEW_CONTENT" || input.kind === "LOCALIZE");
  const nextCheckAt = applied
    ? now
    : liveArticle
      ? (input.nextCheckAt ?? now)
      : (input.nextCheckAt ?? null);

  try {
    const row = await prisma.seoAction.create({
      data: {
        workspaceId: input.workspaceId,
        projectId: input.projectId,
        isMock,
        linkId,
        findingId: input.findingId ?? null,
        source: input.source,
        kind: input.kind,
        openKey: input.openKey,
        pageId: input.pageId,
        targetUrl: input.targetUrl,
        targetUrlHash: hashOf(input.targetUrl),
        targetQueries: input.targetQueries.slice(0, 10),
        proposal: json(input.proposal),
        ...(input.baseline ? { baseline: json(input.baseline) } : {}),
        status: input.status,
        verification: json(freshVerification()),
        ...(applied
          ? {
              appliedVia: "USER",
              appliedAt: now,
              appliedByUserId: input.userId,
              decidedAt: now,
            }
          : {}),
        nextCheckAt,
        windowDays: ACTION_WINDOW_DAYS[input.kind],
        commandId: input.commandId ?? null,
        workId: input.workId ?? null,
        creativeId: input.creativeId ?? null,
        createdByUserId: input.userId,
      },
    });
    const action = actionViewOf(row);
    if (applied && action.findingId) {
      await markFindingDone({
        projectId: action.projectId,
        findingId: action.findingId,
        kindForWindow: action.kind,
        userId: input.userId,
        now,
      });
    }
    await audit({
      workspaceId: action.workspaceId,
      projectId: action.projectId,
      actionId: action.id,
      userId: input.userId,
      action: "seo_action.created",
      metadata: {
        kind: action.kind,
        source: action.source,
        status: action.status,
      },
    });
    return { action, created: true };
  } catch (error) {
    if (!isUniqueViolation(error) || !input.openKey) throw error;
    const existing = await findOpenAction(input.projectId, input.openKey);
    if (!existing) throw error;
    return { action: existing, created: false };
  }
}

// --- geçişler -----------------------------------------------------------------

export type ActionTransitionResult =
  | { ok: true; action: SeoActionView }
  | { ok: false; reason: "not_found" | "invalid_transition" };

type TransitionPatch = {
  proposal?: SeoActionProposalStored;
  targetUrl?: string | null;
  creativeId?: string | null;
  baseline?: PageSnapshot | null;
  dismissReason?: string | null;
  // SC-F8: CMS üzerinden uygulanan değişiklik appliedVia=CMS ve onay kimliğiyle yazılır.
  appliedVia?: "USER" | "CMS";
  approvalId?: string | null;
};

function patchData(
  patch: TransitionPatch,
): Prisma.SeoActionUpdateManyMutationInput {
  const data: Prisma.SeoActionUncheckedUpdateManyInput = {};
  if (patch.proposal !== undefined) data.proposal = json(patch.proposal);
  if (patch.targetUrl !== undefined) {
    data.targetUrl = patch.targetUrl;
    data.targetUrlHash = hashOf(patch.targetUrl);
  }
  if (patch.creativeId !== undefined) data.creativeId = patch.creativeId;
  if (patch.baseline !== undefined) {
    data.baseline =
      patch.baseline === null ? Prisma.DbNull : json(patch.baseline);
  }
  return data;
}

// Doğrulayıcı ya da değerlendirici kirayı tutarken kullanıcı geçişi yazılmaz:
// kira bitince yazacağı durum, kullanıcının geçişini ezerdi (ör. "Not done yet"
// sonrası bayat appliedAt ile ölçüm). Geçiş invalid_transition döner.
function noLiveLease(now: Date): Prisma.SeoActionWhereInput {
  return { OR: [{ leaseUntil: null }, { leaseUntil: { lte: now } }] };
}

type UserEvent = "ACCEPT" | "DISMISS" | "APPLY" | "UNDO_APPLY" | "CONFIRM_LIVE";

function eventData(
  event: UserEvent,
  next: SeoActionStatus,
  input: { userId: string; patch?: TransitionPatch },
  now: Date,
  // Takvimdeki makale (creativeId'li NEW_CONTENT/LOCALIZE): yayına girişi
  // doğrulayıcı günlük izler, geri alınca da izlenmeye devam eder.
  liveArticle: boolean,
): Prisma.SeoActionUncheckedUpdateManyInput {
  const patch = input.patch ?? {};
  switch (event) {
    case "ACCEPT":
      return { ...patchData(patch), status: next, decidedAt: now };
    case "DISMISS":
      return {
        status: next,
        openKey: null,
        nextCheckAt: null,
        decidedAt: now,
        dismissReason: patch.dismissReason ?? null,
      };
    case "APPLY":
      return {
        ...patchData(patch),
        status: next,
        appliedAt: now,
        appliedVia: patch.appliedVia ?? "USER",
        ...(patch.approvalId !== undefined
          ? { approvalId: patch.approvalId }
          : {}),
        appliedByUserId: input.userId,
        verification: json(freshVerification()),
        verifyAttempts: 0,
        askedAt: null,
        nextCheckAt: now,
      };
    case "UNDO_APPLY":
      return {
        status: next,
        appliedAt: null,
        appliedVia: null,
        appliedByUserId: null,
        nextCheckAt: liveArticle ? now : null,
        askedAt: null,
        verification: json(freshVerification()),
        verifyAttempts: 0,
      };
    case "CONFIRM_LIVE":
      return { status: next };
  }
}

export async function transitionAction(input: {
  projectId: string;
  actionId: string;
  event: UserEvent;
  userId: string;
  patch?: TransitionPatch;
  now?: Date;
}): Promise<ActionTransitionResult> {
  const now = input.now ?? new Date();
  const isMock = seoMockMode();
  const row = await prisma.seoAction.findFirst({
    where: { id: input.actionId, projectId: input.projectId, isMock },
  });
  if (!row) return { ok: false, reason: "not_found" };
  const current = actionViewOf(row);
  const next = nextActionStatus(input.event as SeoActionEvent, current.status);
  if (!next) return { ok: false, reason: "invalid_transition" };

  if (input.event === "CONFIRM_LIVE") {
    // Kullanıcı yayında olduğunu söyler: çapa appliedAt'tır (method USER).
    const verification: SeoVerification = {
      ...current.verification,
      method: "USER",
      liveSince: current.appliedAt ? current.appliedAt.toISOString() : null,
      lastCheckedAt: now.toISOString(),
      google: {
        state: "skipped",
        requestedAt: null,
        lastCrawlTime: null,
        verdict: null,
        richResultsVerdict: null,
        checkedAt: now.toISOString(),
      },
      reason: null,
    };
    const started = await startMeasuring({
      action: current,
      owner: null,
      verifiedAt: now,
      method: "USER",
      verification,
      googleCrawlAt: null,
      now,
    });
    if (!started) return { ok: false, reason: "invalid_transition" };
  } else {
    const updated = await prisma.seoAction.updateMany({
      where: {
        id: row.id,
        projectId: input.projectId,
        isMock,
        status: row.status,
        ...noLiveLease(now),
      },
      data: eventData(
        input.event,
        next,
        input,
        now,
        current.creativeId !== null &&
          (current.kind === "NEW_CONTENT" || current.kind === "LOCALIZE"),
      ),
    });
    if (updated.count !== 1) return { ok: false, reason: "invalid_transition" };
  }

  const fresh = await prisma.seoAction.findFirst({ where: { id: row.id } });
  if (!fresh) return { ok: false, reason: "not_found" };
  const action = actionViewOf(fresh);

  if (action.findingId) {
    if (input.event === "APPLY") {
      await markFindingDone({
        projectId: action.projectId,
        findingId: action.findingId,
        kindForWindow: action.kind,
        userId: input.userId,
        now,
      });
    } else if (input.event === "UNDO_APPLY") {
      await revertFindingDone({
        projectId: action.projectId,
        findingId: action.findingId,
      });
    }
  }
  await audit({
    workspaceId: action.workspaceId,
    projectId: action.projectId,
    actionId: action.id,
    userId: input.userId,
    action: `seo_action.${input.event.toLowerCase()}`,
    metadata: { kind: action.kind, status: action.status },
  });
  return { ok: true, action };
}

// Öneri ya da kabul edilmiş eylemin içeriği (kart akışı sürdükçe) güncellenir.
export async function updateProposal(input: {
  projectId: string;
  actionId: string;
  proposal: SeoActionProposalStored;
  targetUrl?: string | null;
  baseline?: PageSnapshot | null;
  pageId?: string | null;
}): Promise<boolean> {
  const data: Prisma.SeoActionUncheckedUpdateManyInput = {
    proposal: json(input.proposal),
  };
  if (input.targetUrl !== undefined) {
    data.targetUrl = input.targetUrl;
    data.targetUrlHash = hashOf(input.targetUrl);
  }
  if (input.baseline !== undefined) {
    data.baseline =
      input.baseline === null ? Prisma.DbNull : json(input.baseline);
  }
  if (input.pageId !== undefined) data.pageId = input.pageId;
  const updated = await prisma.seoAction.updateMany({
    where: {
      id: input.actionId,
      projectId: input.projectId,
      isMock: seoMockMode(),
      status: { in: ["PROPOSED", "ACCEPTED"] },
    },
    data,
  });
  return updated.count === 1;
}

export async function attachCard(input: {
  projectId: string;
  actionId: string;
  commandId: string;
  workId: string;
}): Promise<void> {
  await prisma.seoAction.updateMany({
    where: { id: input.actionId, projectId: input.projectId },
    data: { commandId: input.commandId, workId: input.workId },
  });
}

// Makale takvime yerleşince AYNI eylem creativeId alır (tür değişmez); doğrulayıcı
// yayına girdiğini keşfedene kadar günde bir bakar.
export async function attachCreative(input: {
  projectId: string;
  actionId: string;
  creativeId: string;
  nextCheckAt: Date;
}): Promise<boolean> {
  const updated = await prisma.seoAction.updateMany({
    where: {
      id: input.actionId,
      projectId: input.projectId,
      isMock: seoMockMode(),
      status: { in: ["PROPOSED", "ACCEPTED"] },
    },
    data: {
      status: "ACCEPTED",
      creativeId: input.creativeId,
      nextCheckAt: input.nextCheckAt,
    },
  });
  return updated.count === 1;
}

// "Check now": sıradaki bakışı öne çeker; çok sık basılırsa reddeder.
export async function requestCheckNow(
  projectId: string,
  actionId: string,
  now: Date = new Date(),
): Promise<"queued" | "too_soon" | "not_found"> {
  const row = await prisma.seoAction.findFirst({
    where: { id: actionId, projectId, isMock: seoMockMode() },
  });
  if (!row) return "not_found";
  const action = actionViewOf(row);
  const checkable =
    action.status === "APPLIED" ||
    action.status === "VERIFIED" ||
    (action.status === "ACCEPTED" && action.creativeId !== null);
  if (!checkable) return "not_found";
  const last = action.verification.lastCheckedAt
    ? Date.parse(action.verification.lastCheckedAt)
    : Number.NaN;
  if (!Number.isNaN(last) && now.getTime() - last < CHECK_NOW_MIN_GAP_MS) {
    return "too_soon";
  }
  const updated = await prisma.seoAction.updateMany({
    where: { id: row.id, status: row.status },
    data: { nextCheckAt: now },
  });
  return updated.count === 1 ? "queued" : "not_found";
}

// --- ölçüme geçiş -------------------------------------------------------------

// measureFrom / evaluateAfter'ın TEK yazıldığı yer: doğrulayıcı, CONFIRM_LIVE ve
// DETECTED yolları buradan geçer. Bağ geç bağlanır (SEO kaynaklı uyarı
// eylemleri hariç; onlar yalnız tarayıcıyla çalışır) ve bulgunun değerlendirme
// vadesi eylemin vadesinin EVAL_GIVE_UP_DAYS ötesine uzar.
export async function startMeasuring(input: {
  action: SeoActionView;
  owner: string | null;
  verifiedAt: Date;
  method: VerificationMethod;
  verification: SeoVerification;
  googleCrawlAt: Date | null;
  now: Date;
}): Promise<boolean> {
  const { action, owner } = input;
  if (!nextActionStatus("START_MEASURING", action.status)) return false;
  const fromAlert = action.proposal.alert !== null;
  const fields = measuringFields({
    kind: action.kind,
    appliedAt: action.appliedAt ?? input.now,
    verifiedAt: input.verifiedAt,
    googleCrawlAt: input.googleCrawlAt,
    method: input.method,
    fromAlert,
  });

  let linkId: string | null | undefined;
  if (action.linkId === null && action.proposal.alert?.source !== "SEO") {
    const link = await primaryGscLink(action.projectId);
    if (link && link.isMock === seoMockMode()) linkId = link.id;
  }

  const data = {
    status: "EVALUATING",
    verifiedAt: input.verifiedAt,
    verification: json(input.verification),
    measureFrom: fields.measureFrom,
    evaluateAfter: fields.evaluateAfter,
    nextCheckAt: fields.nextCheckAt,
    ...(linkId ? { linkId } : {}),
  };

  let ok: boolean;
  if (owner) {
    ok = await releaseAction(action.id, owner, data, action.status);
  } else {
    const updated = await prisma.seoAction.updateMany({
      where: {
        id: action.id,
        projectId: action.projectId,
        isMock: action.isMock,
        status: action.status,
        ...noLiveLease(input.now),
      },
      data,
    });
    ok = updated.count === 1;
  }
  if (!ok) return false;

  if (action.findingId) {
    try {
      await prisma.seoFinding.updateMany({
        where: {
          id: action.findingId,
          projectId: action.projectId,
          status: "DONE",
        },
        data: {
          evaluateAfter: addDays(fields.evaluateAfter, EVAL_GIVE_UP_DAYS),
        },
      });
    } catch (error) {
      report("finding window could not be extended", error);
    }
  }
  return true;
}

// --- kira (lease) -------------------------------------------------------------

export async function claimAction(
  actionId: string,
  owner: string,
  now: Date,
): Promise<boolean> {
  const claimed = await prisma.seoAction.updateMany({
    where: {
      id: actionId,
      OR: [{ leaseUntil: null }, { leaseUntil: { lte: now } }],
    },
    data: {
      leaseOwner: owner,
      leaseUntil: new Date(now.getTime() + ACTION_LEASE_MS),
    },
  });
  return claimed.count === 1;
}

// Kirayı bırakırken verilen alanlar da yazılır; yalnız kira hâlâ bizdeyse.
export async function releaseAction(
  actionId: string,
  owner: string,
  data: Prisma.SeoActionUpdateManyMutationInput,
  expectedStatus?: SeoActionStatus,
): Promise<boolean> {
  const released = await prisma.seoAction.updateMany({
    where: {
      id: actionId,
      leaseOwner: owner,
      ...(expectedStatus ? { status: expectedStatus } : {}),
    },
    data: { ...data, leaseOwner: null, leaseUntil: null },
  });
  return released.count === 1;
}
