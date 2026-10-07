import "server-only";

import type { Prisma } from "@prisma/client";

import { creativeFieldsOfPlanItem } from "@/lib/works/plan-item-fields";
import {
  dayKeyInTimezone,
  utcToZonedDateTimeLocal,
  zonedDateTimeToUtc,
} from "@/lib/timezone";

// SC-F7 slot parçalarının TEK yazıcısı (docs/search-content-plan.md "Slotlar ve
// takvim"). Slot = bir Post + bir DRAFT seo.article Creative: planId YOK (planId
// "kaydedilmiş plan kartının Command'ı" demektir; sentetik bir planId yolculuk
// ve plan panelini bozardı), sürüm YOK, onay YOK. Bu dosyada APPROVED yazan,
// Post.approvedAt dolduran ya da CreativeVersion üreten kod yoktur ve olmamalı
// (rails.test.ts yazma kalıplarını tarar). Makale ancak mevcut SEO Manager
// Review → Deliver yolundan (placeSeoArticle) onaylanır.

const SEO_CHANNEL = "seo";
const SEO_FORMAT_KEY = "seo.article";
const SEO_GOAL = "traffic";

type Client = Prisma.TransactionClient;

export type SlotScope = {
  workspaceId: string;
  projectId: string;
  brandId: string;
};

export type SlotPieceInput = {
  // "YYYY-MM-DD" ve "HH:mm" (projenin yerel saati)
  date: string;
  time: string;
  title: string;
  brief: string;
  ideaId: string;
};

export type SlotPieceRef = { postId: string; creativeId: string };

function monthParts(month: string): { year: number; monthIndex: number } {
  const [year, monthNumber] = month.split("-").map(Number);
  return { year: year!, monthIndex: monthNumber! - 1 };
}

// Yerel gece yarısının UTC anı; tek geçişli zonedDateTimeToUtc DST kenarında
// sapabileceği için sonuç geri okunur ve fark kadar bir kez düzeltilir.
function localMidnightUtc(day: string, timezone: string): Date {
  const wanted = `${day}T00:00`;
  const guess = zonedDateTimeToUtc(wanted, timezone);
  const actual = utcToZonedDateTimeLocal(guess, timezone);
  if (actual === wanted) return guess;
  const drift = Date.parse(`${wanted}:00Z`) - Date.parse(`${actual}:00Z`);
  return new Date(guess.getTime() + drift);
}

// Ayın [from, to) UTC aralığı (to = sonraki ayın ilk yerel gece yarısı).
export function monthRangeUtc(
  month: string,
  timezone: string,
): { from: Date; to: Date } {
  const { year, monthIndex } = monthParts(month);
  const next = new Date(Date.UTC(year, monthIndex + 1, 1));
  const nextMonth = `${next.getUTCFullYear()}-${String(next.getUTCMonth() + 1).padStart(2, "0")}`;
  return {
    from: localMidnightUtc(`${month}-01`, timezone),
    to: localMidnightUtc(`${nextMonth}-01`, timezone),
  };
}

export async function createSlotPiecesInTx(
  tx: Client,
  scope: SlotScope,
  input: { timezone: string; items: readonly SlotPieceInput[] },
): Promise<SlotPieceRef[]> {
  const out: SlotPieceRef[] = [];
  for (const item of input.items) {
    const scheduledFor = zonedDateTimeToUtc(
      `${item.date}T${item.time}`,
      input.timezone,
    );
    const fields = creativeFieldsOfPlanItem({
      date: item.date,
      time: item.time,
      channel: SEO_CHANNEL,
      formatKey: SEO_FORMAT_KEY,
      topic: item.title,
      captionIdea: item.brief,
    });
    const post = await tx.post.create({
      data: {
        workspaceId: scope.workspaceId,
        projectId: scope.projectId,
        brandId: scope.brandId,
        workId: null,
        planId: null,
        ideaId: item.ideaId,
        topic: item.title,
        idea: item.brief,
        goal: SEO_GOAL,
        scheduledFor,
        timezone: input.timezone,
      },
      select: { id: true },
    });
    const creative = await tx.creative.create({
      data: {
        workspaceId: scope.workspaceId,
        projectId: scope.projectId,
        brandId: scope.brandId,
        type: fields.type,
        platform: fields.platform,
        channel: fields.channel,
        formatKey: fields.formatKey,
        goal: SEO_GOAL,
        planId: null,
        postId: post.id,
        title: fields.title,
        brief: fields.brief,
        status: "DRAFT",
        scheduledFor,
      },
      select: { id: true },
    });
    out.push({ postId: post.id, creativeId: creative.id });
  }
  return out;
}

// Dokunulmamış slot parçası: DRAFT, sürümsüz, planId'siz (yazılmış ya da
// kartla bağlanmış makale buna girmez).
function untouchedWhere(
  projectId: string,
  creativeIds: readonly string[],
  // Silme, atlanan/değiştirilen yuvanın arşivlenmiş parçasını da kapsar.
  statuses: readonly ("DRAFT" | "ARCHIVED")[] = ["DRAFT"],
): Prisma.CreativeWhereInput {
  return {
    id: { in: [...creativeIds] },
    projectId,
    status: statuses.length === 1 ? statuses[0] : { in: [...statuses] },
    planId: null,
    versions: { none: {} },
  };
}

function uniq(values: readonly (string | null | undefined)[]): string[] {
  return [...new Set(values.filter((v): v is string => !!v))];
}

// Verilen Creative'lerden hâlâ dokunulmamış olanlar (DRAFT, sürümsüz,
// planId'siz); "yazıldı mı" kararı (taşıma, atlama, değiştirme) buna bakar.
export async function findUntouchedSlotCreatives(
  client: Pick<Client, "creative">,
  projectId: string,
  creativeIds: readonly string[],
): Promise<{ id: string; postId: string | null; scheduledFor: Date | null }[]> {
  const ids = uniq(creativeIds);
  if (ids.length === 0) return [];
  return client.creative.findMany({
    where: untouchedWhere(projectId, ids),
    select: { id: true, postId: true, scheduledFor: true },
  });
}

// Yalnız dokunulmamış parçaları arşivler ve tam olarak hangilerini
// arşivlediğini bildirir; Post.archivedAt yalnız arşivlenen Creative'lerin
// Post'larına yazılır.
export async function archiveSlotPiecesInTx(
  tx: Client,
  projectId: string,
  pieces: readonly SlotPieceRef[],
  now: Date,
): Promise<{ archived: string[] }> {
  const creativeIds = uniq(pieces.map((piece) => piece.creativeId));
  if (creativeIds.length === 0) return { archived: [] };
  const where = untouchedWhere(projectId, creativeIds);
  const rows = await tx.creative.findMany({
    where,
    select: { id: true, postId: true },
  });
  if (rows.length === 0) return { archived: [] };
  const ids = rows.map((row) => row.id);
  await tx.creative.updateMany({
    where: untouchedWhere(projectId, ids),
    data: { status: "ARCHIVED" },
  });
  const postIds = uniq(rows.map((row) => row.postId));
  if (postIds.length > 0) {
    await tx.post.updateMany({
      where: { id: { in: postIds }, projectId, archivedAt: null },
      data: { archivedAt: now },
    });
  }
  return { archived: ids };
}

// Kalıcı silme (yalnız forget.ts çağırır): önce Creative (Creative.post
// SetNull), sonra artık teslimatı kalmayan Post'lar. Post.ideaId düz bir
// string'dir; FK yoktur.
export async function deleteSlotPiecesInTx(
  tx: Client,
  projectId: string,
  pieces: readonly SlotPieceRef[],
): Promise<{ deleted: string[] }> {
  const creativeIds = uniq(pieces.map((piece) => piece.creativeId));
  if (creativeIds.length === 0) return { deleted: [] };
  // Skip / Replace / süpürme parçayı ARCHIVED yapar; Google'dan türeyen başlık
  // ve konu silmede onlarla birlikte gitmeli.
  const where = untouchedWhere(projectId, creativeIds, ["DRAFT", "ARCHIVED"]);
  const rows = await tx.creative.findMany({
    where,
    select: { id: true, postId: true },
  });
  if (rows.length === 0) return { deleted: [] };
  const ids = rows.map((row) => row.id);
  await tx.creative.deleteMany({
    where: untouchedWhere(projectId, ids, ["DRAFT", "ARCHIVED"]),
  });
  const postIds = uniq([
    ...rows.map((row) => row.postId),
    ...pieces.map((piece) => piece.postId),
  ]);
  if (postIds.length > 0) {
    await tx.post.deleteMany({
      where: { id: { in: postIds }, projectId, deliveries: { none: {} } },
    });
  }
  return { deleted: ids };
}

export type MonthQuery = {
  projectId: string;
  month: string;
  timezone: string;
  excludeCreativeId?: string;
};

function monthWhere(query: MonthQuery): Prisma.CreativeWhereInput {
  const { from, to } = monthRangeUtc(query.month, query.timezone);
  return {
    projectId: query.projectId,
    formatKey: SEO_FORMAT_KEY,
    status: { notIn: ["ARCHIVED", "REJECTED"] },
    excludedAt: null,
    scheduledFor: { gte: from, lt: to },
    ...(query.excludeCreativeId
      ? { id: { not: query.excludeCreativeId } }
      : {}),
  };
}

// Ay içindeki canlı seo.article parçaları (kimlik + an); sayaç, gün seçimi ve
// yeniden planlama (kendi parçalarını sayıdan çıkarmak) bunu paylaşır.
export async function listSeoPiecesInMonth(
  client: Pick<Client, "creative">,
  query: MonthQuery,
): Promise<{ id: string; scheduledFor: Date | null }[]> {
  return client.creative.findMany({
    where: monthWhere(query),
    select: { id: true, scheduledFor: true },
  });
}

// Aylık sınırın sayacı: o yerel aya düşen bütün seo.article parçaları, kökeni
// ne olursa olsun (slotlar ve elle yazılanlar tek bütçeyi paylaşır).
export async function countSeoPiecesInMonth(
  client: Pick<Client, "creative">,
  query: MonthQuery,
): Promise<number> {
  return client.creative.count({ where: monthWhere(query) });
}

// O ayda seo.article parçası olan yerel gün anahtarları (slot günü seçimi
// bunları atlar).
export async function seoPieceDaysInMonth(
  client: Pick<Client, "creative">,
  query: MonthQuery,
): Promise<string[]> {
  const rows = await listSeoPiecesInMonth(client, query);
  return uniq(
    rows.map((row) =>
      row.scheduledFor
        ? dayKeyInTimezone(row.scheduledFor, query.timezone)
        : null,
    ),
  );
}
