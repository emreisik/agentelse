import "server-only";

import {
  Prisma,
  type GscSiteLink,
  type IdeaStatus,
  type SeoContentPlan,
} from "@prisma/client";

import { appUrl } from "@/lib/app-url";
import { IDEA_POOL_STATUSES } from "@/lib/idea-pool";
import {
  IDEA_CONCEPT_VERSION,
  ideaFingerprint,
  parseIdeaConcept,
  type SeoIdeaConcept,
} from "@/lib/ideas/concept";
import { prisma } from "@/lib/prisma";
import { allocateSlots } from "@/lib/seo/content-plan/allocate";
import { buildCandidates } from "@/lib/seo/content-plan/candidates";
import { capacityOf, parseSettings } from "@/lib/seo/content-plan/cap";
import { PLAN_COPY } from "@/lib/seo/content-plan/copy";
import { guardCandidates, guardTitles, keywordKey } from "@/lib/seo/content-plan/doorway";
import { seoContentPlanActiveFor } from "@/lib/seo/content-plan/flags";
import { planInternalLinks } from "@/lib/seo/content-plan/links";
import {
  SLOT_TIME,
  layoutSlotDates,
  monthOf,
} from "@/lib/seo/content-plan/schedule";
import {
  ANGLE_MAX,
  DESCRIPTION_MAX,
  TITLE_MAX,
  basicAngle,
  basicDescription,
  basicTitle,
} from "@/lib/seo/content-plan/titles";
import {
  PLAN_MAX_PILLARS,
  PLAN_MAX_REGENERATIONS,
  PLAN_MAX_REJECTED,
  emptyPlanData,
  isDayKey,
  parseContentPlanData,
  type PillarEntry,
  type PlanCandidate,
  type PlanEmptyReason,
  type PlanRejectReason,
  type PlanSlot,
  type PlanWording,
  type SeoContentPlanData,
} from "@/lib/seo/content-plan/types";
import { dayKeyInTimezone, zonedDateTimeToUtc } from "@/lib/timezone";
import { gscGlobalWorkAllowedHere } from "@/lib/seo/flags";
import { AuditLogRepository } from "@/server/repositories/audit-log.repository";
import { primaryGscLink } from "@/server/seo/store";
import { isModulesEnabled } from "@/server/works/flag";

import { loadPlanInput, type LoadedPlanInput } from "./inputs";
import {
  archiveSlotPiecesInTx,
  countSeoPiecesInMonth,
  createSlotPiecesInTx,
  findUntouchedSlotCreatives,
  type SlotPieceInput,
  type SlotScope,
} from "./pieces";
import { isSerializationFailure, withSerializableRetry } from "./serializable";
import {
  activeSeoCards,
  localClock,
  projectTimezone,
  readPlanRow,
  readPlanSettings,
} from "./store";
import { writeWording } from "./wording";

// Aylık SEO içerik planlayıcısı (docs/search-content-plan.md "Plan nasıl
// kurulur"): oluşturma, yenileme (Refresh / Replace), atlama ve taşıma.
// Adaylar saklanmaz; her çağrı taze anlık görüntüden yeniden hesaplar. Aylık
// sınır iki kez uygulanır: önce dışarıda hesaplanan boş yer, sonra AYNI
// Serializable işlem içinde yeniden sayım (sınır asla aşılmaz). İşlemler kısadır
// (model çağrısı işlemin dışında). Bu dosya APPROVED yazmaz, Post.approvedAt
// doldurmaz, CreativeVersion üretmez (rails.test.ts taraması): slotlar yalnız
// DRAFT parçalardır ve ancak SEO Manager Review → Deliver yoluyla onaylanır.

export type PlanTrigger = "auto" | "manual" | "chat";

export type PlanOutcome =
  | { status: "created"; planId: string; slots: number }
  | { status: "empty"; reason: PlanEmptyReason }
  | { status: "exists" }
  | { status: "retry"; reason: "BUDGET" | "ENGINE_BEHIND" | "BUSY" }
  | { status: "off" };

export type RegenerateFailure =
  | "off"
  | "no_plan"
  | "limit"
  | "busy"
  | "nothing_to_replace"
  | "budget"
  | "failed"
  | "behind";

export type RegenerateResult =
  | { ok: true; replaced: number; kept: number }
  | { ok: false; reason: RegenerateFailure };

export type SkipResult =
  | { ok: true }
  | { ok: false; reason: "off" | "not_found" | "written" };

export type MoveResult =
  | { ok: true }
  | { ok: false; reason: "off" | "not_found" | "written" | "past" | "other_month" };

const TX_OPTIONS = {
  isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
  maxWait: 10_000,
  timeout: 30_000,
} as const;

const BUDGET_RETRY_LAST_DAY = 5;
const KEYWORD_MAX = 160;
const IDEA_KEYWORD_MAX = 100;
const SLOT_BRIEF =
  "Planned SEO article. Open Search -> This month's articles and press Write this article. It reaches the calendar as approved only after you review it.";
const WHY_NO_PILLAR =
  "People search this topic, and your site has no strong main page for it.";
const WHY_NO_PAGE = "Searched often, and no page on your site answers it yet.";
const FEWER_NOTE =
  "Fewer topics than the monthly limit allows had a clear gap, so this plan has fewer articles.";
const DAYS_NOTE =
  "Too few free weekdays are left, so this plan has fewer articles than the monthly limit allows.";
const EVIDENCE_TITLE = "This month's articles";
const EVIDENCE_MARK = "#content-plan";

type Tx = Prisma.TransactionClient;

// --- Küçük yardımcılar ---

function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as { code?: unknown }).code === "P2002"
  );
}

function clip(text: string, max: number): string {
  const chars = Array.from(text.replace(/\s+/g, " ").trim());
  return chars.length <= max ? chars.join("") : chars.slice(0, max).join("").trim();
}

function json(value: unknown): Prisma.InputJsonValue {
  return value as Prisma.InputJsonValue;
}

function gatedOff(link: Pick<GscSiteLink, "projectId" | "isMock">): boolean {
  return (
    !seoContentPlanActiveFor(link.projectId) ||
    !isModulesEnabled() ||
    // Geliştirme süreci canlı veritabanını paylaşırken mock bağa dokunulmaz.
    (link.isMock && !gscGlobalWorkAllowedHere())
  );
}

function poolStatusOf(value: string | null): IdeaStatus {
  return (IDEA_POOL_STATUSES as readonly string[]).includes(value ?? "")
    ? (value as IdeaStatus)
    : "VALIDATED";
}

function logFailure(label: string, error: unknown): void {
  // Hata metni Google dizgisi taşıyabilir: yalnız adı yazılır.
  console.error(
    `[seo-content-plan] ${label}:`,
    error instanceof Error ? error.name : "UnknownError",
  );
}

async function audit(input: {
  link: Pick<GscSiteLink, "workspaceId" | "projectId">;
  planId: string;
  trigger: PlanTrigger | "user";
  userId?: string;
  action: string;
  metadata?: Record<string, unknown>;
}): Promise<void> {
  try {
    await AuditLogRepository.record({
      workspaceId: input.link.workspaceId,
      projectId: input.link.projectId,
      actorType: input.trigger === "auto" ? "SYSTEM" : "USER",
      ...(input.userId ? { actorId: input.userId } : {}),
      action: input.action,
      entityType: "SeoContentPlan",
      entityId: input.planId,
      ...(input.metadata ? { metadata: input.metadata } : {}),
    });
  } catch (error) {
    logFailure("audit failed", error);
  }
}

// --- Taslak slotlar (kodla seçilmiş, modelle adlandırılmış) ---

type SlotDraft = {
  candidate: PlanCandidate;
  title: string;
  angle: string;
  description: string;
  date: string;
  time: string;
  linkFrom: PlanSlot["linkFrom"];
  linkTo: PlanSlot["linkTo"];
  linksVerified: boolean;
  reuseIdeaId: string | null;
};

type Composed =
  | {
      kind: "slots";
      drafts: SlotDraft[];
      wording: PlanWording;
      budgetHit: boolean;
      relaxed: boolean;
      capacity: number;
      considered: number;
      filtered: SeoContentPlanData["filtered"];
      strongPillarClusterIds: string[];
    }
  | {
      kind: "empty";
      reason: PlanEmptyReason;
      considered: number;
      filtered: SeoContentPlanData["filtered"];
    };

type LoadedOk = Extract<LoadedPlanInput, { ok: true }>;

function countFiltered(
  rows: readonly { reason: PlanRejectReason }[],
): SeoContentPlanData["filtered"] {
  const counts = new Map<PlanRejectReason, number>();
  for (const row of rows) counts.set(row.reason, (counts.get(row.reason) ?? 0) + 1);
  return [...counts].map(([reason, count]) => ({ reason, count }));
}

// Adaydan slota: aday seçimi, kapı sayfası bekçisi, kapasite, gün dizilimi,
// dağıtım, TEK model çağrısı, başlık bekçisi ve iç link planı. Veritabanı
// yazmaz.
async function composeSlots(input: {
  loaded: LoadedOk;
  month: string;
  today: string;
  timezone: string;
  now: Date;
  cap: number;
  capacity: number;
  // Verilirse gün dizilimi yerine bu günler kullanılır (Replace eski günü tutar).
  fixedDates?: readonly string[];
  rejectedExtra?: readonly string[];
  deprioritized?: readonly string[];
}): Promise<Composed> {
  const { loaded } = input;
  const planInput = {
    ...loaded.input,
    rejectedKeys: [...loaded.input.rejectedKeys, ...(input.rejectedExtra ?? [])],
    deprioritizedKeys: [...(input.deprioritized ?? [])],
  };
  const built = buildCandidates(planInput);
  if (built.lowData) {
    return { kind: "empty", reason: "NO_DATA", considered: 0, filtered: [] };
  }
  const considered = built.candidates.length;
  if (considered === 0) {
    return {
      kind: "empty",
      reason: planInput.clusters.length === 0 ? "NO_CLUSTERS" : "NO_GAPS",
      considered,
      filtered: countFiltered(built.filtered),
    };
  }
  const guard = guardCandidates(built.candidates, {
    existingTitles: planInput.existingTitles,
    existingKeywords: planInput.existingKeywords,
    rejectedKeys: planInput.rejectedKeys,
    brandTerms: planInput.brandTerms,
  });
  const filtered = countFiltered([...built.filtered, ...guard.rejected]);
  if (guard.kept.length === 0) {
    return { kind: "empty", reason: "ALL_FILTERED", considered, filtered };
  }
  if (input.capacity <= 0) {
    return { kind: "empty", reason: "CAP_FULL", considered, filtered };
  }
  const dates = input.fixedDates
    ? [...input.fixedDates]
    : layoutSlotDates({
        month: input.month,
        today: input.today,
        count: input.capacity,
        taken: loaded.takenDates,
      });
  if (dates.length === 0) {
    return { kind: "empty", reason: "NO_ROOM", considered, filtered };
  }
  const capacity = Math.min(input.capacity, dates.length);
  const allocation = allocateSlots(guard.kept, {
    capacity,
    cap: input.cap,
    strongPillarClusterIds: built.strongPillarClusterIds,
  });
  if (allocation.chosen.length === 0) {
    return { kind: "empty", reason: "NO_GAPS", considered, filtered };
  }

  // Ana sayfalar önce (yazılışı sırasıyla, tarihe göre artan).
  const chosen = [
    ...allocation.chosen.filter((candidate) => candidate.kind === "PILLAR"),
    ...allocation.chosen.filter((candidate) => candidate.kind !== "PILLAR"),
  ];

  // Havuz fikri yeniden kullanımı: aynı fikri iki slot talep edemez.
  const poolById = new Map(planInput.poolIdeas.map((idea) => [idea.id, idea]));
  const claimed = new Set<string>();
  const reuseOf = new Map<string, string>();
  for (const candidate of chosen) {
    const id = candidate.reuseIdeaId;
    if (id && poolById.has(id) && !claimed.has(id)) {
      claimed.add(id);
      reuseOf.set(candidate.id, id);
    }
  }

  const needsWording = chosen.filter((candidate) => !reuseOf.has(candidate.id));
  const wording = await writeWording({
    scope: loaded.scope,
    candidates: needsWording,
    language: loaded.language,
    now: input.now,
  });

  // Başlık bekçisi: model başlıkları mevcut başlıklara/birbirine çok yakınsa
  // ya da yer adı şablonuysa temel başlığa düşer.
  const aiTitles = needsWording.flatMap((candidate) => {
    const item = wording.items.get(candidate.id);
    return item ? [{ id: candidate.id, title: item.title }] : [];
  });
  const titleGuard = guardTitles(aiTitles, {
    existingTitles: planInput.existingTitles,
  });
  const okTitles = new Set(titleGuard.ok.map((item) => item.id));

  const drafts: SlotDraft[] = chosen.map((candidate, index) => {
    const reuse = poolById.get(reuseOf.get(candidate.id) ?? "") ?? null;
    const ai = okTitles.has(candidate.id) ? wording.items.get(candidate.id) : undefined;
    let title: string;
    let angle: string;
    let description: string;
    if (reuse) {
      title = clip(reuse.title, TITLE_MAX) || basicTitle(candidate.keyword, loaded.language);
      angle = clip(reuse.angle, ANGLE_MAX);
      description = clip(reuse.description, DESCRIPTION_MAX);
    } else if (ai) {
      title = ai.title;
      angle = ai.angle || basicAngle(candidate, loaded.language);
      description = ai.description || basicDescription(candidate.keyword, loaded.language);
    } else {
      title = basicTitle(candidate.keyword, loaded.language);
      angle = basicAngle(candidate, loaded.language);
      description = basicDescription(candidate.keyword, loaded.language);
    }
    const strongPillar =
      candidate.clusterId !== null &&
      built.strongPillarClusterIds.includes(candidate.clusterId);
    const cluster = planInput.clusters.find((item) => item.id === candidate.clusterId);
    const links = planInternalLinks({
      keyword: candidate.keyword,
      queries: candidate.queries,
      kind: candidate.kind,
      clusterId: candidate.clusterId,
      pillarPageId: strongPillar ? (cluster?.pillarPageId ?? null) : null,
      clusterQueryIds: cluster?.queryIds ?? candidate.queryIds,
      pages: planInput.pages,
      pairs: planInput.pairs,
      hasCrawl: planInput.hasCrawl,
      crawlComplete: planInput.crawlComplete,
    });
    return {
      candidate,
      title,
      angle,
      description,
      date: dates[index]!,
      time: SLOT_TIME,
      linkFrom: links.linkFrom,
      linkTo: links.linkTo,
      linksVerified: links.verified,
      reuseIdeaId: reuseOf.get(candidate.id) ?? null,
    };
  });

  return {
    kind: "slots",
    drafts,
    wording: wording.wording,
    budgetHit: wording.budgetHit,
    relaxed: allocation.relaxed,
    capacity,
    considered,
    filtered,
    strongPillarClusterIds: built.strongPillarClusterIds,
  };
}

// --- Fikir ve parça yazımı (işlem içinde) ---

function seoConcept(
  projectId: string,
  draft: SlotDraft,
): SeoIdeaConcept | null {
  const { candidate } = draft;
  let evidence: SeoIdeaConcept["evidence"];
  try {
    evidence = [
      {
        title: EVIDENCE_TITLE,
        url: appUrl(`/projects/${projectId}/arama${EVIDENCE_MARK}`).toString(),
      },
    ];
  } catch {
    // Uygulama adresi okunamıyorsa kanıt girdisi atlanır (isteğe bağlı alan).
    evidence = undefined;
  }
  const concept = parseIdeaConcept({
    v: IDEA_CONCEPT_VERSION,
    module: "seo",
    source: "search",
    why: candidate.gap === "NO_PILLAR" ? WHY_NO_PILLAR : WHY_NO_PAGE,
    strength:
      candidate.share >= 0.05 || candidate.findingConfidence === "SIGNIFICANT"
        ? 3
        : 2,
    ...(evidence ? { evidence } : {}),
    draft: {
      keyword: clip(candidate.keyword, IDEA_KEYWORD_MAX),
      intent: candidate.intent,
      title: draft.title,
      // Fikir şeması boş metin kabul etmez: İngilizce olmayan projelerde boş
      // kalan açı/açıklama yerine başlık konur.
      description: draft.description || draft.title,
      angle: draft.angle || draft.title,
    },
  });
  return concept?.module === "seo" ? concept : null;
}

function isOurEvidence(entry: { url?: unknown }): boolean {
  return typeof entry.url === "string" && entry.url.includes(EVIDENCE_MARK);
}

// Havuz fikrini PLANNING'e alır. updateMany durumu doğrudan değiştirir ve
// IDEA_TRANSITIONS'ı bilerek aşar (havuzdaki fikri slot tutarken yeni bir
// geçiş kuralı gerekmez; Skip/Replace/forget eski duruma döndürür).
async function claimPoolIdea(
  tx: Tx,
  projectId: string,
  ideaId: string,
  projectEvidence: SeoIdeaConcept["evidence"],
): Promise<{ id: string; prevStatus: IdeaStatus } | null> {
  const idea = await tx.idea.findFirst({
    where: { id: ideaId, projectId, status: { in: [...IDEA_POOL_STATUSES] } },
    select: { id: true, status: true, concept: true },
  });
  if (!idea) return null;
  const concept = parseIdeaConcept(idea.concept);
  const evidence =
    concept?.module === "seo" && projectEvidence
      ? [
          ...(concept.evidence ?? []).filter((entry) => !isOurEvidence(entry)).slice(0, 2),
          ...projectEvidence,
        ]
      : null;
  const claimed = await tx.idea.updateMany({
    where: { id: idea.id, projectId, status: idea.status },
    data: {
      status: "PLANNING",
      ...(concept && evidence ? { concept: json({ ...concept, evidence }) } : {}),
    },
  });
  return claimed.count === 1 ? { id: idea.id, prevStatus: idea.status } : null;
}

type WrittenSlot = PlanSlot;

async function writeSlotsInTx(
  tx: Tx,
  input: {
    scope: SlotScope;
    isMock: boolean;
    timezone: string;
    drafts: readonly SlotDraft[];
    firstSlotNumber: number;
  },
): Promise<WrittenSlot[]> {
  const { scope } = input;
  const ideaRefs: {
    ideaId: string;
    prevIdeaStatus: IdeaStatus | null;
    reused: boolean;
  }[] = [];
  for (const draft of input.drafts) {
    const concept = seoConcept(scope.projectId, draft);
    if (!concept) throw new Error("The plan idea did not validate.");
    let ref: (typeof ideaRefs)[number] | null = null;
    if (draft.reuseIdeaId) {
      const claimed = await claimPoolIdea(
        tx,
        scope.projectId,
        draft.reuseIdeaId,
        concept.evidence,
      );
      if (claimed) {
        ref = { ideaId: claimed.id, prevIdeaStatus: claimed.prevStatus, reused: true };
      }
    }
    if (!ref) {
      const created = await tx.idea.create({
        data: {
          workspaceId: scope.workspaceId,
          projectId: scope.projectId,
          brandId: scope.brandId,
          title: concept.draft.title,
          description: concept.draft.description,
          concept: json(concept),
          fingerprint: ideaFingerprint(concept),
          isMock: input.isMock,
          status: "PLANNING",
        },
        select: { id: true },
      });
      ref = { ideaId: created.id, prevIdeaStatus: null, reused: false };
    }
    ideaRefs.push(ref);
  }

  const pieces = await createSlotPiecesInTx(tx, scope, {
    timezone: input.timezone,
    items: input.drafts.map(
      (draft, index): SlotPieceInput => ({
        date: draft.date,
        time: draft.time,
        title: draft.title,
        brief: SLOT_BRIEF,
        ideaId: ideaRefs[index]!.ideaId,
      }),
    ),
  });

  return input.drafts.map((draft, index) => {
    const { candidate } = draft;
    const ref = ideaRefs[index]!;
    const piece = pieces[index]!;
    return {
      id: `s${input.firstSlotNumber + index}`,
      status: "PLANNED",
      kind: candidate.kind,
      clusterId: candidate.clusterId,
      clusterName: candidate.clusterName,
      keyword: clip(candidate.keyword, KEYWORD_MAX),
      queries: candidate.queries.slice(0, 3),
      intent: candidate.intent,
      impressions: candidate.impressions,
      share: Math.min(1, candidate.share),
      position: candidate.position,
      gap: candidate.gap,
      rising: candidate.rising,
      findingId: candidate.findingId,
      title: draft.title,
      angle: draft.angle,
      description: draft.description,
      date: draft.date,
      time: draft.time,
      creativeId: piece.creativeId,
      postId: piece.postId,
      ideaId: ref.ideaId,
      prevIdeaStatus: ref.prevIdeaStatus,
      linkFrom: draft.linkFrom,
      linkTo: draft.linkTo,
      linksVerified: draft.linksVerified,
      reusedIdea: ref.reused,
    };
  });
}

// Slotun fikrini bırakır: havuzdan alınmışsa önceki durumuna döner (kullanıcının
// kendi APPROVED fikri kaybolmaz) ve yalnız bizim kanıt girdimiz çıkarılır;
// planın yarattığı fikir arşivlenir. updateMany geçiş tablosunu bilerek aşar.
async function releaseIdeaInTx(
  tx: Tx,
  projectId: string,
  slot: Pick<PlanSlot, "ideaId" | "reusedIdea" | "prevIdeaStatus">,
): Promise<void> {
  if (!slot.reusedIdea) {
    await tx.idea.updateMany({
      where: { id: slot.ideaId, projectId, status: "PLANNING" },
      data: { status: "ARCHIVED" },
    });
    return;
  }
  const idea = await tx.idea.findFirst({
    where: { id: slot.ideaId, projectId, status: "PLANNING" },
    select: { concept: true },
  });
  if (!idea) return;
  const concept = parseIdeaConcept(idea.concept);
  const stripped =
    concept?.module === "seo"
      ? {
          ...concept,
          evidence: (concept.evidence ?? []).filter((entry) => !isOurEvidence(entry)),
        }
      : null;
  await tx.idea.updateMany({
    where: { id: slot.ideaId, projectId, status: "PLANNING" },
    data: {
      status: poolStatusOf(slot.prevIdeaStatus),
      ...(stripped ? { concept: json(stripped) } : {}),
    },
  });
}

// --- Plan verisi ---

function pillarsOf(
  slots: readonly PlanSlot[],
  input: LoadedOk["input"],
  strongClusterIds: readonly string[],
): PillarEntry[] {
  const byCluster = new Map<string, PlanSlot[]>();
  for (const slot of slots) {
    if (slot.status !== "PLANNED" || slot.clusterId === null) continue;
    byCluster.set(slot.clusterId, [...(byCluster.get(slot.clusterId) ?? []), slot]);
  }
  const entries: PillarEntry[] = [];
  for (const [clusterId, clusterSlots] of byCluster) {
    const cluster = input.clusters.find((item) => item.id === clusterId);
    const page = input.pages.find(
      (item) => cluster?.pillarPageId != null && item.pageId === cluster.pillarPageId,
    );
    const impressions = cluster?.impressions ?? clusterSlots[0]!.impressions;
    entries.push({
      clusterId,
      name: clip(cluster?.name ?? clusterSlots[0]!.clusterName ?? "", 120),
      impressions,
      share: Math.min(1, impressions / Math.max(1, input.nonBrandImpressions)),
      pillarUrl: page?.url ?? null,
      pillarPath: page?.path ?? null,
      weak: !strongClusterIds.includes(clusterId),
      slotIds: clusterSlots.map((slot) => slot.id),
    });
  }
  return entries
    .sort((a, b) => b.impressions - a.impressions || a.clusterId.localeCompare(b.clusterId))
    .slice(0, PLAN_MAX_PILLARS);
}

function planNotes(composed: Extract<Composed, { kind: "slots" }>, created: number): string[] {
  const notes: string[] = [];
  if (composed.relaxed) notes.push(PLAN_COPY.relaxedNote);
  if (created < composed.capacity) {
    notes.push(created === composed.drafts.length ? FEWER_NOTE : DAYS_NOTE);
  }
  return notes;
}

function withRejected(rejected: readonly string[], key: string): string[] {
  const unique = [...new Set([...rejected, key])];
  return unique.slice(-PLAN_MAX_REJECTED);
}

// --- EMPTY satırları ---

async function upsertEmptyRow(
  db: Pick<Tx, "seoContentPlan">,
  input: {
    link: Pick<GscSiteLink, "id" | "projectId" | "workspaceId" | "isMock" | "lastWeeklyWeek">;
    month: string;
    now: Date;
    reason: PlanEmptyReason;
    cap: number;
    existing: number;
    nonBrandImpressions?: number;
    considered?: number;
    filtered?: SeoContentPlanData["filtered"];
    week?: string | null;
  },
  tolerateRace: boolean,
): Promise<void> {
  const row = await db.seoContentPlan.findUnique({
    where: { linkId_month: { linkId: input.link.id, month: input.month } },
  });
  if (row && row.status === "ACTIVE") return;
  const previous = row ? parseContentPlanData(row.data, input.now) : null;
  const data: SeoContentPlanData = {
    ...emptyPlanData(input.now, input.reason),
    // Önceki slotlar (REMOVED/SKIPPED) forget için, reddedilenler de kalır.
    slots: previous?.slots ?? [],
    nextSlot: previous?.nextSlot ?? 1,
    rejected: previous?.rejected ?? [],
    totals: { nonBrandImpressions: input.nonBrandImpressions ?? 0 },
    considered: input.considered ?? 0,
    filtered: input.filtered ?? [],
  };
  const common = {
    cap: input.cap,
    existingAtPlan: input.existing,
    basedOnWeek: input.week ?? input.link.lastWeeklyWeek ?? "",
    wording: "BASIC",
    data: json(data),
  };
  if (row) {
    await db.seoContentPlan.update({
      where: { id: row.id },
      data: { status: "EMPTY", ...common },
    });
    return;
  }
  try {
    await db.seoContentPlan.create({
      data: {
        workspaceId: input.link.workspaceId,
        projectId: input.link.projectId,
        linkId: input.link.id,
        isMock: input.link.isMock,
        month: input.month,
        status: "EMPTY",
        ...common,
      },
    });
  } catch (error) {
    if (!(tolerateRace && isUniqueViolation(error))) throw error;
  }
}

// --- Oluşturma ---

type CreateTxResult =
  | { kind: "exists" }
  | { kind: "empty"; reason: PlanEmptyReason }
  | { kind: "created"; planId: string; slots: number; wording: PlanWording; cap: number };

export async function createMonthlyPlan(input: {
  link: GscSiteLink;
  month: string;
  timezone: string;
  now: Date;
  trigger: PlanTrigger;
  userId?: string;
}): Promise<PlanOutcome> {
  const { link, month, timezone, now, trigger } = input;
  if (gatedOff(link)) return { status: "off" };

  const existingRow = await readPlanRow(link.id, month);
  if (existingRow?.status === "ACTIVE") return { status: "exists" };

  const settings = await readPlanSettings(link.projectId);
  const clock = localClock(timezone, now);
  const empty = async (
    reason: PlanEmptyReason,
    extras: {
      existing?: number;
      nonBrandImpressions?: number;
      considered?: number;
      filtered?: SeoContentPlanData["filtered"];
      week?: string | null;
    } = {},
  ): Promise<PlanOutcome> => {
    await upsertEmptyRow(
      prisma,
      {
        link,
        month,
        now,
        reason,
        cap: settings.monthlyCap,
        existing: extras.existing ?? 0,
        nonBrandImpressions: extras.nonBrandImpressions,
        considered: extras.considered,
        filtered: extras.filtered,
        week: extras.week,
      },
      true,
    );
    return { status: "empty", reason };
  };

  const loaded = await loadPlanInput({ link, month, timezone, now });
  if (!loaded.ok) {
    if ("retry" in loaded) return { status: "retry", reason: loaded.retry };
    return empty(loaded.empty);
  }
  const week = loaded.input.week;
  const common = {
    existing: loaded.existingInMonth,
    nonBrandImpressions: loaded.input.nonBrandImpressions,
    week,
  };

  const composed = await composeSlots({
    loaded,
    month,
    today: clock.today,
    timezone,
    now,
    cap: settings.monthlyCap,
    capacity: capacityOf(settings.monthlyCap, loaded.existingInMonth),
  });
  if (composed.kind === "empty") {
    return empty(composed.reason, {
      ...common,
      considered: composed.considered,
      filtered: composed.filtered,
    });
  }

  // Bütçe: otomatik planda ayın ilk 5 gününde plan yarına bırakılır; sonra
  // (ya da elle/sohbetle) temel başlıklarla devam edilir.
  const dayOfMonth = Number(clock.today.slice(8, 10));
  if (
    composed.budgetHit &&
    trigger === "auto" &&
    dayOfMonth <= BUDGET_RETRY_LAST_DAY
  ) {
    await empty("AI_LIMIT", common);
    return { status: "retry", reason: "BUDGET" };
  }

  const scope = loaded.scope;
  const run = (): Promise<CreateTxResult> =>
    prisma.$transaction(async (tx): Promise<CreateTxResult> => {
      const row = await tx.seoContentPlan.findUnique({
        where: { linkId_month: { linkId: link.id, month } },
      });
      if (row?.status === "ACTIVE") return { kind: "exists" };
      const setting = parseSettings(
        await tx.seoContentSetting.findUnique({
          where: { projectId: link.projectId },
          select: { monthlyCap: true, autoPlan: true },
        }),
      );
      // İkinci sayım: planlama sırasında bir makale eklenmiş olabilir.
      const count = await countSeoPiecesInMonth(tx, {
        projectId: link.projectId,
        month,
        timezone,
      });
      const drafts = composed.drafts.slice(0, capacityOf(setting.monthlyCap, count));
      if (drafts.length === 0) {
        await upsertEmptyRow(
          tx,
          {
            link,
            month,
            now,
            reason: "CAP_FULL",
            cap: setting.monthlyCap,
            existing: count,
            nonBrandImpressions: loaded.input.nonBrandImpressions,
            considered: composed.considered,
            filtered: composed.filtered,
            week,
          },
          false,
        );
        return { kind: "empty", reason: "CAP_FULL" };
      }
      const previous = row ? parseContentPlanData(row.data, now) : null;
      const firstSlotNumber = previous?.nextSlot ?? 1;
      const slots = await writeSlotsInTx(tx, {
        scope,
        isMock: link.isMock,
        timezone,
        drafts,
        firstSlotNumber,
      });
      const allSlots = [...(previous?.slots ?? []), ...slots];
      const data: SeoContentPlanData = {
        v: 1,
        slots: allSlots,
        nextSlot: firstSlotNumber + slots.length,
        rejected: previous?.rejected ?? [],
        reason: null,
        notes: planNotes(composed, slots.length),
        pillars: pillarsOf(allSlots, loaded.input, composed.strongPillarClusterIds),
        totals: { nonBrandImpressions: loaded.input.nonBrandImpressions },
        considered: composed.considered,
        filtered: composed.filtered,
        checkedAt: now.toISOString(),
        regeneratedAt: null,
        wordingNote: composed.budgetHit ? "budget" : null,
      };
      const fields = {
        status: "ACTIVE",
        cap: setting.monthlyCap,
        existingAtPlan: count,
        basedOnWeek: week,
        wording: composed.wording,
        data: json(data),
      };
      const saved = row
        ? await tx.seoContentPlan.update({
            where: { id: row.id },
            data: fields,
            select: { id: true },
          })
        : await tx.seoContentPlan.create({
            data: {
              workspaceId: link.workspaceId,
              projectId: link.projectId,
              linkId: link.id,
              isMock: link.isMock,
              month,
              ...fields,
            },
            select: { id: true },
          });
      return {
        kind: "created",
        planId: saved.id,
        slots: slots.length,
        wording: composed.wording,
        cap: setting.monthlyCap,
      };
    }, TX_OPTIONS);

  let result: CreateTxResult;
  try {
    result = await withSerializableRetry(run);
  } catch (error) {
    // Aynı (bağ, ay) için iki süreç yarıştı: kazanan plan zaten yazıldı.
    if (isUniqueViolation(error)) return { status: "exists" };
    if (isSerializationFailure(error)) {
      const after = await readPlanRow(link.id, month);
      return after?.status === "ACTIVE"
        ? { status: "exists" }
        : { status: "retry", reason: "BUSY" };
    }
    throw error;
  }
  if (result.kind === "exists") return { status: "exists" };
  if (result.kind === "empty") return { status: "empty", reason: result.reason };
  await audit({
    link,
    planId: result.planId,
    trigger,
    userId: input.userId,
    action: "seo_content_plan.created",
    metadata: {
      month,
      slots: result.slots,
      cap: result.cap,
      wording: result.wording,
    },
  });
  return { status: "created", planId: result.planId, slots: result.slots };
}

// --- Slot bulma ve ortak okuma ---

async function currentPlan(
  projectId: string,
  now: Date,
  monthOverride?: string,
): Promise<{
  link: GscSiteLink;
  row: SeoContentPlan;
  timezone: string;
  month: string;
  today: string;
} | null> {
  const link = await primaryGscLink(projectId);
  if (!link) return null;
  const timezone = await projectTimezone(projectId);
  const clock = localClock(timezone, now);
  const month = monthOverride ?? clock.month;
  const row = await readPlanRow(link.id, month);
  return row ? { link, row, timezone, month, today: clock.today } : null;
}

// --- Atlama ---

export async function skipSlot(input: {
  projectId: string;
  slotId: string;
  userId: string;
  now?: Date;
  month?: string;
}): Promise<SkipResult> {
  const { projectId, slotId } = input;
  const now = input.now ?? new Date();
  if (!seoContentPlanActiveFor(projectId)) return { ok: false, reason: "off" };
  const plan = await currentPlan(projectId, now, input.month);
  if (!plan || gatedOff(plan.link)) return { ok: false, reason: "not_found" };

  const run = async (): Promise<
    { ok: true; planId: string; kind: PlanSlot["kind"] } | { ok: false; reason: "not_found" | "written" }
  > =>
    prisma.$transaction(async (tx) => {
      const row = await tx.seoContentPlan.findUnique({ where: { id: plan.row.id } });
      if (!row) return { ok: false, reason: "not_found" } as const;
      const data = parseContentPlanData(row.data, now);
      const slot = data.slots.find((item) => item.id === slotId && item.status === "PLANNED");
      if (!slot) return { ok: false, reason: "not_found" } as const;
      const cards = await activeSeoCards(tx, projectId, [slot.ideaId]);
      if (cards.has(slot.ideaId)) return { ok: false, reason: "written" } as const;
      const archived = await archiveSlotPiecesInTx(
        tx,
        projectId,
        [{ postId: slot.postId, creativeId: slot.creativeId }],
        now,
      );
      // Yazılmış (ya da dokunulmuş) makale atlanamaz.
      if (!archived.archived.includes(slot.creativeId)) {
        return { ok: false, reason: "written" } as const;
      }
      await releaseIdeaInTx(tx, projectId, slot);
      const slots = data.slots.map((item) =>
        item.id === slot.id ? { ...item, status: "SKIPPED" as const } : item,
      );
      const next: SeoContentPlanData = {
        ...data,
        slots,
        rejected: withRejected(data.rejected, keywordKey(slot.keyword)),
      };
      await tx.seoContentPlan.update({
        where: { id: row.id },
        data: { data: json(next) },
      });
      return { ok: true, planId: row.id, kind: slot.kind } as const;
    }, TX_OPTIONS);

  try {
    const result = await withSerializableRetry(run);
    if (!result.ok) return result;
    await audit({
      link: plan.link,
      planId: result.planId,
      trigger: "user",
      userId: input.userId,
      action: "seo_content_plan.slot_skipped",
      metadata: { kind: result.kind },
    });
    return { ok: true };
  } catch (error) {
    if (isSerializationFailure(error)) return { ok: false, reason: "written" };
    throw error;
  }
}

// --- Taşıma ---

export async function moveSlot(input: {
  projectId: string;
  slotId: string;
  date: string;
  userId: string;
  now?: Date;
  month?: string;
}): Promise<MoveResult> {
  const { projectId, slotId, date } = input;
  const now = input.now ?? new Date();
  if (!seoContentPlanActiveFor(projectId)) return { ok: false, reason: "off" };
  const plan = await currentPlan(projectId, now, input.month);
  if (!plan || gatedOff(plan.link)) return { ok: false, reason: "not_found" };
  // Geçmişe taşınmaz; yalnız aynı ay içinde.
  if (!isDayKey(date) || date <= plan.today) return { ok: false, reason: "past" };
  if (monthOf(date) !== plan.month) return { ok: false, reason: "other_month" };
  const scheduledFor = zonedDateTimeToUtc(`${date}T${SLOT_TIME}`, plan.timezone);

  const run = async (): Promise<
    { ok: true; planId: string } | { ok: false; reason: "not_found" | "written" }
  > =>
    prisma.$transaction(async (tx) => {
      const row = await tx.seoContentPlan.findUnique({ where: { id: plan.row.id } });
      if (!row) return { ok: false, reason: "not_found" } as const;
      const data = parseContentPlanData(row.data, now);
      const slot = data.slots.find((item) => item.id === slotId && item.status === "PLANNED");
      if (!slot) return { ok: false, reason: "not_found" } as const;
      const cards = await activeSeoCards(tx, projectId, [slot.ideaId]);
      if (cards.has(slot.ideaId)) return { ok: false, reason: "written" } as const;
      const untouched = await findUntouchedSlotCreatives(tx, projectId, [slot.creativeId]);
      if (untouched.length === 0) return { ok: false, reason: "written" } as const;
      await tx.creative.update({
        where: { id: slot.creativeId },
        data: { scheduledFor },
      });
      await tx.post.updateMany({
        where: { id: slot.postId, projectId },
        data: { scheduledFor, timezone: plan.timezone },
      });
      return { ok: true, planId: row.id } as const;
    }, TX_OPTIONS);

  try {
    const result = await withSerializableRetry(run);
    if (!result.ok) return result;
    await audit({
      link: plan.link,
      planId: result.planId,
      trigger: "user",
      userId: input.userId,
      action: "seo_content_plan.slot_moved",
    });
    return { ok: true };
  } catch (error) {
    if (isSerializationFailure(error)) return { ok: false, reason: "written" };
    throw error;
  }
}

// --- Yenileme (Refresh plan / Replace) ---

// İşlem içinde yazılacak yeni slot kalmadıysa işlemi geri almak için.
class RegenerateRollback extends Error {}

type RegenTxResult =
  | { ok: true; planId: string; replaced: number; kept: number }
  | { ok: false; reason: "no_plan" | "limit" | "nothing_to_replace" };

export async function regenerateContentPlan(input: {
  projectId: string;
  userId: string;
  slotId?: string;
  now?: Date;
  trigger: PlanTrigger;
}): Promise<RegenerateResult> {
  const { projectId, slotId, trigger } = input;
  const now = input.now ?? new Date();
  if (!seoContentPlanActiveFor(projectId) || !isModulesEnabled()) {
    return { ok: false, reason: "off" };
  }
  try {
    const plan = await currentPlan(projectId, now);
    if (!plan) return { ok: false, reason: "no_plan" };
    const { link, row, timezone, month, today } = plan;
    if (gatedOff(link)) return { ok: false, reason: "off" };
    if (row.status !== "ACTIVE") return { ok: false, reason: "no_plan" };
    if (!slotId && row.regenerations >= PLAN_MAX_REGENERATIONS) {
      return { ok: false, reason: "limit" };
    }

    const data = parseContentPlanData(row.data, now);
    const target = data.slots.filter(
      (slot) => slot.status === "PLANNED" && (!slotId || slot.id === slotId),
    );
    if (slotId && target.length === 0) {
      return { ok: false, reason: "nothing_to_replace" };
    }
    const replaceable = await replaceableSlots(prisma, projectId, timezone, target);
    if (slotId && replaceable.length === 0) {
      return { ok: false, reason: "nothing_to_replace" };
    }

    const settings = await readPlanSettings(projectId);
    const loaded = await loadPlanInput({
      link,
      month,
      timezone,
      now,
      ignore: {
        ideaIds: replaceable.map((entry) => entry.slot.ideaId),
        creativeIds: replaceable.map((entry) => entry.slot.creativeId),
      },
    });
    // Motor yeni haftayı bitirmediyse ya da veri okunamıyorsa hiçbir şey
    // değişmez.
    if (!loaded.ok) return { ok: false, reason: "behind" };

    const removedKeys = replaceable.map((entry) => keywordKey(entry.slot.keyword));
    let capacity = capacityOf(settings.monthlyCap, loaded.existingInMonth);
    if (slotId) capacity = Math.min(capacity, 1);
    // Replace eski günü tutar (hâlâ gelecekteyse ve ay içindeyse).
    const oldDay = replaceable[0]?.day ?? null;
    const fixedDates =
      slotId && oldDay && oldDay > today && monthOf(oldDay) === month
        ? [oldDay]
        : undefined;

    const composed =
      capacity > 0
        ? await composeSlots({
            loaded,
            month,
            today,
            timezone,
            now,
            cap: settings.monthlyCap,
            capacity,
            fixedDates,
            rejectedExtra: slotId ? removedKeys : [],
            deprioritized: slotId ? [] : removedKeys,
          })
        : null;
    // Yerine konacak yeni konu yoksa eski slotlar olduğu gibi kalır (yenileme
    // elindekini kaybettirmez).
    if (!composed || composed.kind !== "slots") {
      return { ok: false, reason: "nothing_to_replace" };
    }
    const slotsComposed = composed;

    const replaceableIds = new Set(replaceable.map((entry) => entry.slot.id));
    const run = (): Promise<RegenTxResult> =>
      prisma.$transaction(async (tx): Promise<RegenTxResult> => {
        const fresh = await tx.seoContentPlan.findUnique({ where: { id: row.id } });
        if (!fresh || fresh.status !== "ACTIVE") return { ok: false, reason: "no_plan" };
        if (!slotId && fresh.regenerations >= PLAN_MAX_REGENERATIONS) {
          return { ok: false, reason: "limit" };
        }
        const prev = parseContentPlanData(fresh.data, now);
        const setting = parseSettings(
          await tx.seoContentSetting.findUnique({
            where: { projectId },
            select: { monthlyCap: true, autoPlan: true },
          }),
        );
        // İşlem içinde yeniden doğrula: bu arada yazılmaya başlanan slot kalır.
        const candidates = prev.slots.filter(
          (slot) => slot.status === "PLANNED" && replaceableIds.has(slot.id),
        );
        const cards = await activeSeoCards(
          tx,
          projectId,
          candidates.map((slot) => slot.ideaId),
        );
        const archivable = candidates.filter((slot) => !cards.has(slot.ideaId));
        const archived = await archiveSlotPiecesInTx(
          tx,
          projectId,
          archivable.map((slot) => ({ postId: slot.postId, creativeId: slot.creativeId })),
          now,
        );
        const removed = archivable.filter((slot) =>
          archived.archived.includes(slot.creativeId),
        );
        for (const slot of removed) await releaseIdeaInTx(tx, projectId, slot);
        const removedIds = new Set(removed.map((slot) => slot.id));

        const count = await countSeoPiecesInMonth(tx, { projectId, month, timezone });
        let room = capacityOf(setting.monthlyCap, count);
        if (slotId) room = Math.min(room, 1);
        const drafts = slotsComposed.drafts.slice(0, room);
        // Yeni slot yazılamıyorsa arşivlemeler de geri alınır.
        if (drafts.length === 0) throw new RegenerateRollback();
        const firstSlotNumber = prev.nextSlot;
        const created = await writeSlotsInTx(tx, {
          scope: loaded.scope,
          isMock: link.isMock,
          timezone,
          drafts,
          firstSlotNumber,
        });
        const slots: PlanSlot[] = [
          ...prev.slots.map((slot) =>
            removedIds.has(slot.id) ? { ...slot, status: "REMOVED" as const } : slot,
          ),
          ...created,
        ];
        const planned = slots.filter((slot) => slot.status === "PLANNED");
        const nextData: SeoContentPlanData = {
          ...prev,
          slots,
          nextSlot: firstSlotNumber + created.length,
          rejected: slotId
            ? removed.reduce(
                (acc, slot) => withRejected(acc, keywordKey(slot.keyword)),
                prev.rejected,
              )
            : prev.rejected,
          reason: null,
          notes: planNotes(slotsComposed, created.length),
          pillars: pillarsOf(slots, loaded.input, slotsComposed.strongPillarClusterIds),
          totals: { nonBrandImpressions: loaded.input.nonBrandImpressions },
          considered: slotsComposed.considered,
          filtered: slotsComposed.filtered,
          checkedAt: now.toISOString(),
          regeneratedAt: now.toISOString(),
          wordingNote: slotsComposed.budgetHit ? "budget" : null,
        };
        await tx.seoContentPlan.update({
          where: { id: fresh.id },
          data: {
            status: "ACTIVE",
            cap: setting.monthlyCap,
            basedOnWeek: loaded.input.week,
            regenerations: slotId ? fresh.regenerations : fresh.regenerations + 1,
            wording: slotsComposed.wording,
            data: json(nextData),
          },
        });
        return {
          ok: true,
          planId: fresh.id,
          replaced: removed.length,
          kept: planned.length - created.length,
        };
      }, TX_OPTIONS);

    let result: RegenTxResult;
    try {
      result = await withSerializableRetry(run);
    } catch (error) {
      if (error instanceof RegenerateRollback) {
        return { ok: false, reason: "nothing_to_replace" };
      }
      throw error;
    }
    if (!result.ok) return result;
    await audit({
      link,
      planId: result.planId,
      trigger,
      userId: input.userId,
      action: "seo_content_plan.regenerated",
      metadata: { replaced: result.replaced, kept: result.kept },
    });
    return { ok: true, replaced: result.replaced, kept: result.kept };
  } catch (error) {
    if (isSerializationFailure(error)) return { ok: false, reason: "busy" };
    logFailure("regenerate failed", error);
    return { ok: false, reason: "failed" };
  }
}

// Yerine konabilecek slotlar: parçası hâlâ dokunulmamış (DRAFT, sürümsüz,
// planId'siz) ve etkin SEO kartı olmayanlar; canlı günü de taşır.
async function replaceableSlots(
  client: Pick<Tx, "creative" | "command">,
  projectId: string,
  timezone: string,
  slots: readonly PlanSlot[],
): Promise<{ slot: PlanSlot; day: string | null }[]> {
  if (slots.length === 0) return [];
  const [untouched, cards] = await Promise.all([
    findUntouchedSlotCreatives(
      client,
      projectId,
      slots.map((slot) => slot.creativeId),
    ),
    activeSeoCards(
      client,
      projectId,
      slots.map((slot) => slot.ideaId),
    ),
  ]);
  const byCreative = new Map(untouched.map((row) => [row.id, row]));
  return slots.flatMap((slot) => {
    const creative = byCreative.get(slot.creativeId);
    if (!creative || cards.has(slot.ideaId)) return [];
    return [
      {
        slot,
        day: creative.scheduledFor
          ? dayKeyInTimezone(creative.scheduledFor, timezone)
          : null,
      },
    ];
  });
}
