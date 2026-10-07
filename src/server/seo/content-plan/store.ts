import "server-only";

import type { Prisma, SeoContentPlan } from "@prisma/client";

import { prisma } from "@/lib/prisma";
import {
  parseSettings,
  clampCap,
  type SeoPlanSettings,
} from "@/lib/seo/content-plan/cap";
import { PLAN_COPY, STATE_LABEL } from "@/lib/seo/content-plan/copy";
import { seoContentPlanActiveFor } from "@/lib/seo/content-plan/flags";
import { manualPlanAllowed, planWindow } from "@/lib/seo/content-plan/schedule";
import {
  PLAN_MAX_REGENERATIONS,
  parseContentPlanData,
  type PlanEmptyReason,
  type PlanLink,
  type PlanSlot,
  type PlanSlotKind,
  type PlanWording,
  type SeoContentPlanData,
} from "@/lib/seo/content-plan/types";
import {
  EMPTY_COPY,
  monthLabel,
  seoWriteHref,
  slotStateOf,
  whyLines,
  type SlotState,
} from "@/lib/seo/content-plan/view";
import { utcToZonedDateTimeLocal } from "@/lib/timezone";
import { getProjectTimezone } from "@/server/chat/content-plan";
import { AuditLogRepository } from "@/server/repositories/audit-log.repository";
import { readEngineState } from "@/server/seo/opportunities/state";
import { primaryGscLink } from "@/server/seo/store";

import { countSeoPiecesInMonth } from "./pieces";

// Planın okuma yüzü (docs/search-content-plan.md "Arayüz"): ayarlar, proje
// yerel saati, plan satırı ve Search sayfasının/sohbetin gördüğü görünüm. Slotun
// canlı durumu ve tarihi HER ZAMAN Creative'den okunur; plan JSON'u yalnız
// gerekçeyi ve slotun kaldırılıp kaldırılmadığını söyler.

const FALLBACK_TIMEZONE = "Europe/Istanbul";
const MONTH_PATTERN = /^\d{4}-(0[1-9]|1[0-2])$/;
const PILLARS_SHOWN = 6;
const CARD_SCAN_LIMIT = 50;

export function isMonthKey(value: unknown): value is string {
  return typeof value === "string" && MONTH_PATTERN.test(value);
}

// Projenin saat dilimi serbest metin olabilir; geçersizse Intl fırlatır.
function safeTimezone(timezone: string): string {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: timezone });
    return timezone;
  } catch {
    return FALLBACK_TIMEZONE;
  }
}

export async function projectTimezone(projectId: string): Promise<string> {
  return safeTimezone(await getProjectTimezone(projectId));
}

// Projenin şu anki yerel zamanı ("YYYY-MM-DDTHH:mm"), günü ve ayı.
export function localClock(
  timezone: string,
  now: Date,
): { local: string; today: string; month: string } {
  const local = utcToZonedDateTimeLocal(now, timezone);
  return { local, today: local.slice(0, 10), month: local.slice(0, 7) };
}

export async function currentLocalMonth(
  projectId: string,
  now: Date = new Date(),
): Promise<string> {
  return localClock(await projectTimezone(projectId), now).month;
}

// --- Ayarlar ---

// Satır yoksa varsayılanlar; asla yazmaz.
export async function readPlanSettings(
  projectId: string,
): Promise<SeoPlanSettings> {
  const row = await prisma.seoContentSetting.findUnique({
    where: { projectId },
    select: { monthlyCap: true, autoPlan: true },
  });
  return parseSettings(row);
}

export async function savePlanSettings(input: {
  workspaceId: string;
  projectId: string;
  userId: string;
  monthlyCap: unknown;
  autoPlan: boolean;
}): Promise<SeoPlanSettings> {
  const monthlyCap = clampCap(input.monthlyCap);
  const row = await prisma.seoContentSetting.upsert({
    where: { projectId: input.projectId },
    create: {
      workspaceId: input.workspaceId,
      projectId: input.projectId,
      monthlyCap,
      autoPlan: input.autoPlan,
      updatedByUserId: input.userId,
    },
    update: {
      monthlyCap,
      autoPlan: input.autoPlan,
      updatedByUserId: input.userId,
    },
    select: { id: true, monthlyCap: true, autoPlan: true },
  });
  await AuditLogRepository.record({
    workspaceId: input.workspaceId,
    projectId: input.projectId,
    actorType: "USER",
    actorId: input.userId,
    action: "seo_content_plan.settings_saved",
    entityType: "SeoContentSetting",
    entityId: row.id,
    metadata: { cap: row.monthlyCap, autoPlan: row.autoPlan },
  });
  return parseSettings(row);
}

// --- Satır ---

export async function readPlanRow(
  linkId: string,
  month: string,
): Promise<SeoContentPlan | null> {
  return prisma.seoContentPlan.findUnique({
    where: { linkId_month: { linkId, month } },
  });
}

// --- Etkin SEO kartları ---

type CommandClient = Pick<Prisma.TransactionClient, "command">;

function recordOf(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

// Tek Command sorgusu: ipucu (hint.ideaId) bu slot fikirlerinden biri olan,
// henüz teslim edilmemiş (data.delivery yok) SEO Manager kartları. Dönen harita
// fikir kimliği -> kartın bulunduğu Work (yoksa null). Boş girdi sorgu atmaz.
export async function activeSeoCards(
  client: CommandClient,
  projectId: string,
  ideaIds: readonly string[],
): Promise<Map<string, string | null>> {
  const ids = [...new Set(ideaIds)].slice(0, 12);
  const out = new Map<string, string | null>();
  if (ids.length === 0) return out;
  const rows = await client.command.findMany({
    where: {
      projectId,
      AND: [
        { parsedIntent: { path: ["card", "kind"], equals: "module-flow" } },
        { parsedIntent: { path: ["card", "module"], equals: "seo" } },
        {
          OR: ids.map((id) => ({
            parsedIntent: {
              path: ["card", "data", "hint", "ideaId"],
              equals: id,
            },
          })),
        },
      ],
    },
    orderBy: { createdAt: "desc" },
    take: CARD_SCAN_LIMIT,
    select: { workId: true, parsedIntent: true },
  });
  for (const row of rows) {
    const card = recordOf(recordOf(row.parsedIntent)?.card);
    const data = recordOf(card?.data);
    if (!data || data.delivery) continue;
    const ideaId = recordOf(data.hint)?.ideaId;
    if (typeof ideaId !== "string" || out.has(ideaId)) continue;
    out.set(ideaId, row.workId);
  }
  return out;
}

// workHref (components/layout/work-list.tsx) istemci modülündedir; sunucudan
// çağrılamaz, aynı adres burada kurulur.
function workLink(projectId: string, workId: string): string {
  return `/projects/${projectId}?work=${encodeURIComponent(workId)}`;
}

// --- Görünüm ---

export type SlotView = {
  id: string;
  state: SlotState;
  stateLabel: string;
  kind: PlanSlotKind;
  title: string;
  keyword: string;
  // Canlı, projenin yerel günü (Creative'den); parça yoksa null
  date: string | null;
  time: string | null;
  dateLabel: string | null;
  why: string[];
  linkFrom: PlanLink[];
  linkTo: PlanLink[];
  linksVerified: boolean;
  ideaId: string;
  creativeId: string;
  postId: string;
  writeHref: string | null;
  continueHref: string | null;
  canWrite: boolean;
  canContinue: boolean;
  canSkip: boolean;
  canMove: boolean;
  canReplace: boolean;
};

export type PillarView = {
  clusterId: string;
  name: string;
  sharePct: number;
  pillarPath: string | null;
  weak: boolean;
  articles: number;
};

export type ContentPlanViewState = "waiting" | "needs_data" | "empty" | "ready";

export type ContentPlanView = {
  projectId: string;
  month: string;
  monthLabel: string;
  settings: SeoPlanSettings;
  state: ContentPlanViewState;
  emptyReason: PlanEmptyReason | null;
  emptyText: string | null;
  cap: number;
  used: number;
  planned: number;
  slots: SlotView[];
  pillars: PillarView[];
  basedOnWeek: string | null;
  wording: PlanWording | null;
  wordingNote: "budget" | null;
  regenerationsLeft: number;
  notes: string[];
  isMock: boolean;
  canPlanNow: boolean;
  canRefresh: boolean;
};

function dateLabelOf(date: Date, timezone: string): string {
  return new Intl.DateTimeFormat("en-US", {
    weekday: "short",
    month: "short",
    day: "numeric",
    timeZone: timezone,
  }).format(date);
}

type CreativeFacts = {
  id: string;
  status: string;
  scheduledFor: Date | null;
  versions: number;
};

function slotViewOf(input: {
  projectId: string;
  slot: PlanSlot;
  creative: CreativeFacts | null;
  cardWorkId: string | null | undefined;
  timezone: string;
  now: Date;
}): SlotView {
  const { projectId, slot, creative, timezone, now } = input;
  const hasActiveCard = input.cardWorkId !== undefined;
  const scheduledFor = creative?.scheduledFor ?? null;
  const state = slotStateOf({
    creativeStatus: creative?.status ?? null,
    scheduledFor,
    hasActiveCard,
    slotStatus: slot.status,
    now,
  });
  const draftLike =
    creative !== null &&
    (creative.status === "DRAFT" || creative.status === "IN_REVIEW") &&
    creative.versions === 0;
  const live = slot.status === "PLANNED" && draftLike;
  const canWrite = live && !hasActiveCard;
  const canContinue = live && hasActiveCard;
  const local = scheduledFor ? utcToZonedDateTimeLocal(scheduledFor, timezone) : null;
  return {
    id: slot.id,
    state,
    stateLabel: STATE_LABEL[state],
    kind: slot.kind,
    title: slot.title,
    keyword: slot.keyword,
    date: local ? local.slice(0, 10) : null,
    time: local ? local.slice(11, 16) : null,
    dateLabel: scheduledFor ? dateLabelOf(scheduledFor, timezone) : null,
    why: whyLines(slot),
    linkFrom: slot.linkFrom,
    linkTo: slot.linkTo,
    linksVerified: slot.linksVerified,
    ideaId: slot.ideaId,
    creativeId: slot.creativeId,
    postId: slot.postId,
    writeHref: canWrite ? seoWriteHref(projectId, slot.ideaId) : null,
    continueHref: canContinue
      ? input.cardWorkId
        ? workLink(projectId, input.cardWorkId)
        : seoWriteHref(projectId, slot.ideaId)
      : null,
    canWrite,
    canContinue,
    canSkip: canWrite,
    canMove: canWrite,
    canReplace: canWrite,
  };
}

function baseView(input: {
  projectId: string;
  month: string;
  settings: SeoPlanSettings;
  used: number;
  isMock: boolean;
}): ContentPlanView {
  return {
    projectId: input.projectId,
    month: input.month,
    monthLabel: monthLabel(input.month),
    settings: input.settings,
    state: "needs_data",
    emptyReason: null,
    emptyText: null,
    cap: input.settings.monthlyCap,
    used: input.used,
    planned: 0,
    slots: [],
    pillars: [],
    basedOnWeek: null,
    wording: null,
    wordingNote: null,
    regenerationsLeft: PLAN_MAX_REGENERATIONS,
    notes: [],
    isMock: input.isMock,
    canPlanNow: false,
    canRefresh: false,
  };
}

// Search sayfasının, API'nin ve sohbetin okuduğu görünüm. Bayrak/izin listesi
// kapalıyken hiçbir veritabanı okuması yapmadan null döner.
export async function loadContentPlanView(
  projectId: string,
  options: { month?: string; now?: Date } = {},
): Promise<ContentPlanView | null> {
  if (!seoContentPlanActiveFor(projectId)) return null;
  const now = options.now ?? new Date();
  const timezone = await projectTimezone(projectId);
  const clock = localClock(timezone, now);
  const month = isMonthKey(options.month) ? options.month : clock.month;
  const isCurrent = month === clock.month;

  const [link, settings] = await Promise.all([
    primaryGscLink(projectId),
    readPlanSettings(projectId),
  ]);
  const used = await countSeoPiecesInMonth(prisma, {
    projectId,
    month,
    timezone,
  });
  const view = baseView({ projectId, month, settings, used, isMock: link?.isMock ?? false });
  if (!link || !link.lastWeeklyWeek) return view;
  const engine = await readEngineState(link.id);
  if (!engine?.lastWeek) return view;

  const row = await readPlanRow(link.id, month);
  const data: SeoContentPlanData | null = row
    ? parseContentPlanData(row.data, now)
    : null;
  const visible = data?.slots.filter((slot) => slot.status !== "REMOVED") ?? [];
  const regenerationsLeft = Math.max(
    0,
    PLAN_MAX_REGENERATIONS - (row?.regenerations ?? 0),
  );
  const base = {
    ...view,
    isMock: row?.isMock ?? link.isMock,
    basedOnWeek: row?.basedOnWeek ?? null,
    wording: (row?.wording as PlanWording | undefined) ?? null,
    wordingNote: data?.wordingNote ?? null,
    regenerationsLeft,
  };

  if (!row || !data) {
    // Plan henüz yok: pencere açılmadıysa bekler, kapandıysa boştur.
    const window = planWindow(clock.local);
    const closed = isCurrent
      ? window.state === "closed"
      : month < clock.month;
    return {
      ...base,
      state: closed ? "empty" : "waiting",
      emptyReason: closed ? "NO_ROOM" : null,
      emptyText: closed ? EMPTY_COPY.NO_ROOM : null,
      canPlanNow: isCurrent && manualPlanAllowed(clock.local),
    };
  }

  if (row.status === "EMPTY" || visible.length === 0) {
    const reason: PlanEmptyReason = data.reason ?? "NO_GAPS";
    return {
      ...base,
      state: "empty",
      emptyReason: reason,
      emptyText: EMPTY_COPY[reason],
      notes: data.notes,
      canPlanNow:
        isCurrent && row.status === "EMPTY" && manualPlanAllowed(clock.local),
    };
  }

  const ids = visible.map((slot) => slot.creativeId);
  const [creatives, cards] = await Promise.all([
    prisma.creative.findMany({
      where: { id: { in: ids }, projectId },
      select: {
        id: true,
        status: true,
        scheduledFor: true,
        _count: { select: { versions: true } },
      },
    }),
    activeSeoCards(
      prisma,
      projectId,
      visible.filter((slot) => slot.status === "PLANNED").map((slot) => slot.ideaId),
    ),
  ]);
  const creativeById = new Map<string, CreativeFacts>(
    creatives.map((creative) => [
      creative.id,
      {
        id: creative.id,
        status: creative.status,
        scheduledFor: creative.scheduledFor,
        versions: creative._count.versions,
      },
    ]),
  );
  const slots = visible
    .map((slot) =>
      slotViewOf({
        projectId,
        slot,
        creative: creativeById.get(slot.creativeId) ?? null,
        cardWorkId: cards.get(slot.ideaId),
        timezone,
        now,
      }),
    )
    .sort(
      (a, b) =>
        (a.date ?? "9999").localeCompare(b.date ?? "9999") ||
        a.id.localeCompare(b.id, "en", { numeric: true }),
    );

  const plannedSlots = visible.filter((slot) => slot.status === "PLANNED");
  const replaceable = slots.filter((slot) => slot.canReplace).length;
  const articlesOf = (slotIds: readonly string[]) =>
    slotIds.filter((id) => plannedSlots.some((slot) => slot.id === id)).length;
  const notes = [...data.notes];
  const verifiedAny = slots.some((slot) => slot.linksVerified);
  if (slots.length > 0 && !verifiedAny && !notes.includes(PLAN_COPY.noCrawlNote)) {
    notes.push(PLAN_COPY.noCrawlNote);
  }
  return {
    ...base,
    state: "ready",
    planned: plannedSlots.length,
    slots,
    pillars: data.pillars.slice(0, PILLARS_SHOWN).map((pillar) => ({
      clusterId: pillar.clusterId,
      name: pillar.name,
      sharePct: Math.round(pillar.share * 100),
      pillarPath: pillar.weak ? null : pillar.pillarPath,
      weak: pillar.weak,
      articles: articlesOf(pillar.slotIds),
    })),
    notes,
    canRefresh:
      isCurrent &&
      regenerationsLeft > 0 &&
      (replaceable > 0 || plannedSlots.length === 0),
  };
}
