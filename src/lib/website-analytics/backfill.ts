import {
  GA_REPORTS,
  GA_TOTALS_SCHEDULE,
  gaReportSpec,
} from "@/lib/website-analytics/catalog";
import { addDays } from "@/lib/website-analytics/days";

// Geri doldurma planı (docs/google-analytics-plan.md §3.3 "Geri doldurma"):
// bağlanınca her rapor, günlük çekimin revizyon penceresinin hemen öncesinden
// başlayıp geriye doğru (yeniden eskiye) parça parça doldurulur. Önce bütün
// raporların yakın geçmişi gelir. Durum GaPropertyLink.backfill'de saklanır;
// kesilirse kaldığı yerden sürer.

export const TOTALS_KEY = "totals";
export const BACKFILL_KEYS = [
  TOTALS_KEY,
  ...GA_REPORTS.map((spec) => spec.key),
] as const;

export type GaBackfillState = {
  v: 1;
  // Rapor başına sıradaki parçanın son günü (geriye doğru ilerler).
  next: Record<string, string>;
  // Rapor başına en eski gün (dahil).
  floor: Record<string, string>;
  startedAt: string;
  doneAt?: string;
};

export type GaBackfillChunk = { key: string; start: string; end: string };

function schedule(key: string) {
  return key === TOTALS_KEY ? GA_TOTALS_SCHEDULE : gaReportSpec(key);
}

export function initialBackfill(input: {
  today: string;
  // Mülkün oluşturulduğu gün; ondan önce veri yoktur.
  propertyCreated: string | null;
  now: Date;
}): GaBackfillState {
  const next: Record<string, string> = {};
  const floor: Record<string, string> = {};
  for (const key of BACKFILL_KEYS) {
    const spec = schedule(key);
    if (!spec) continue;
    const oldest = addDays(input.today, -spec.backfillDays);
    next[key] = addDays(input.today, -(spec.revisionDays + 1));
    floor[key] =
      input.propertyCreated && input.propertyCreated > oldest
        ? input.propertyCreated
        : oldest;
  }
  return { v: 1, next, floor, startedAt: input.now.toISOString() };
}

// Sıradaki en çok `max` parça: en yeni `next`'e sahip raporlar önce.
// `skip` (katalogdan düşmüş raporlar) atlanır.
export function nextBackfillChunks(
  state: GaBackfillState,
  max: number,
  skip: ReadonlySet<string> = new Set(),
): GaBackfillChunk[] {
  return Object.keys(state.next)
    .filter((key) => !skip.has(key))
    .filter((key) => state.next[key]! >= (state.floor[key] ?? ""))
    .sort((a, b) => state.next[b]!.localeCompare(state.next[a]!))
    .slice(0, max)
    .map((key) => {
      const spec = schedule(key);
      const end = state.next[key]!;
      const floor = state.floor[key]!;
      const start = addDays(end, -((spec?.chunkDays ?? 30) - 1));
      return { key, start: start < floor ? floor : start, end };
    });
}

export function advanceBackfill(
  state: GaBackfillState,
  chunk: GaBackfillChunk,
): GaBackfillState {
  return {
    ...state,
    next: { ...state.next, [chunk.key]: addDays(chunk.start, -1) },
  };
}

export function backfillComplete(
  state: GaBackfillState,
  skip: ReadonlySet<string> = new Set(),
): boolean {
  return Object.keys(state.next)
    .filter((key) => !skip.has(key))
    .every((key) => state.next[key]! < (state.floor[key] ?? ""));
}

export function parseBackfillState(value: unknown): GaBackfillState | null {
  if (!value || typeof value !== "object") return null;
  const state = value as Partial<GaBackfillState>;
  if (state.v !== 1 || !state.next || !state.floor || !state.startedAt) {
    return null;
  }
  return state as GaBackfillState;
}
