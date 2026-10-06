import "server-only";

import type { GscSiteLink, Prisma } from "@prisma/client";

import { isBrandErrorHash, type GscBackfillState } from "@/lib/seo/backfill";
import {
  GSC_SEARCH_TYPES,
  GSC_SLICE_KINDS,
  type GscSearchType,
  type GscSliceKind,
} from "@/lib/seo/catalog";
import type { GscQuotaState } from "@/lib/seo/governor";
import { prisma } from "@/lib/prisma";
import type { GscBrandContext } from "@/server/seo/brand-terms";

// Bir bağın senkron turu boyunca taşınan durum. Kota durumu ve istek bütçesi
// turda bellekte güncellenir; kota hataları aynı sitenin birincil bağlarına
// da yazılır (requests.ts).

export type GscSearchTypesState = {
  // Satır döndürmeyen isteğe bağlı türler (ayda bir yeniden yoklanır).
  empty: Set<GscSearchType>;
  // Google'ın geçersiz saydığı kırılımlar.
  disabledSlices: Set<GscSliceKind>;
  // ["date","searchAppearance"] reddedildi: görünüm gün gün çekilir.
  appearancePerDay: boolean;
};

export type GscSyncContext = {
  link: GscSiteLink;
  accessToken: string;
  now: Date;
  // PT günü (YYYY-MM-DD).
  today: string;
  lane: "P1" | "P2";
  // Turun duvar saati sınırı (ms epoch).
  deadline: number;
  quota: GscQuotaState;
  requestsLeft: number;
  // Marka terimleri; okunamadıysa null (marka işi bu tur atlanır).
  brand: GscBrandContext | null;
  searchTypes: GscSearchTypesState;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function members<T extends string>(
  value: unknown,
  allowed: readonly T[],
): Set<T> {
  if (!Array.isArray(value)) return new Set();
  return new Set(
    value.filter((item): item is T => allowed.includes(item as T)),
  );
}

export function parseSearchTypes(value: unknown): GscSearchTypesState {
  const raw = isRecord(value) ? value : {};
  return {
    empty: members(raw.empty, GSC_SEARCH_TYPES),
    disabledSlices: members(raw.disabledSlices, GSC_SLICE_KINDS),
    appearancePerDay: raw.appearancePerDay === true,
  };
}

export function serializeSearchTypes(
  state: GscSearchTypesState,
  now: Date,
): Prisma.InputJsonValue {
  return {
    empty: [...state.empty],
    disabledSlices: [...state.disabledSlices],
    appearancePerDay: state.appearancePerDay,
    checkedAt: now.toISOString(),
  };
}

export async function saveSearchTypes(ctx: GscSyncContext): Promise<void> {
  ctx.link = await prisma.gscSiteLink.update({
    where: { id: ctx.link.id },
    data: { searchTypes: serializeSearchTypes(ctx.searchTypes, ctx.now) },
  });
}

// Geri doldurmanın tek atlama kümesi (günlük aşama, geri doldurma ve
// tamamlanma hep bunu kullanır): boş türler, kapalı kırılımlar, gün gün
// çekilen görünüm; marka bağlamı yoksa ya da marka isteği Google'da geçersizse
// marka.
export function gscBackfillSkipKeys(
  ctx: GscSyncContext,
  state: GscBackfillState,
): Set<string> {
  const skip = new Set<string>();
  for (const type of ctx.searchTypes.empty) skip.add(`totals:${type}`);
  for (const kind of ctx.searchTypes.disabledSlices) skip.add(`slice:${kind}`);
  if (ctx.searchTypes.appearancePerDay) skip.add("slice:appearance");
  if (!ctx.brand || isBrandErrorHash(state.brandHash)) skip.add("brand");
  return skip;
}
