import {
  addDays,
  addMonths,
  addWeeks,
  firstMonthStartOnOrAfter,
  firstWeekStartOnOrAfter,
  googleWindowStart,
  lastCompleteMonthStart,
  lastCompleteWeekStart,
  maxDay,
  monthEnd,
  weekEndOf,
} from "./dates";
import { GSC_DAILY_WINDOW_DAYS } from "./schedule";

// Search Console geri doldurma planı (docs/google-search-console-plan.md
// §3.3 "Geri doldurma"; docs/search-analytics.md "Senkron"): bağ başına tek,
// kaldığı yerden süren durum (GscSiteLink.backfill). Önce boşluklar (bağ bir
// süre senkronlanamadıysa kaybolan günler), sonra ana geçmiş: web toplamları,
// marka serisi, isteğe bağlı türler, aylar, kırılımlar, haftalar. Her anahtar
// yeniden eskiye ilerler; `next` tabanın altına inince anahtar biter. Ağır
// istek (90 günü aşan aralık) hiç üretilmez; yalnız sorgu×sayfa ağırdır ve
// ağır blok sürerken kuyruğa (heavyPending) girer. Saf modül.

export const GSC_BACKFILL_ORDER: readonly string[] = [
  "totals:web",
  "brand",
  "totals:image",
  "totals:video",
  "totals:news",
  "totals:discover",
  "totals:googleNews",
  "monthly",
  "slice:country",
  "slice:device",
  "slice:appearance",
  "weekly",
];

// Boşluklarda doldurulan günlük anahtarlar (haftalık/aylık özetlerde boşluk
// olmaz: bekleyen dönemler her zaman yürünür).
export const GSC_GAP_KEYS: readonly string[] = GSC_BACKFILL_ORDER.filter(
  (key) => key !== "monthly" && key !== "weekly",
);

export const GSC_CHUNK_DAYS = { totals: 90, brand: 90, slice: 30 } as const;

// Marka isteği Google'da geçersiz sayıldığında (RE2 düzenli ifadesi) durumdaki
// özet: aynı terimlerle her turda yeniden denenmesin, terimler değişince
// yeniden açılsın.
const BRAND_ERROR_PREFIX = "error:";

export type GscGap = {
  start: string;
  end: string;
  next: Record<string, string>;
};

export type GscBackfillState = {
  v: 1;
  // Anahtar başına sıradaki parçanın son günü (dönem anahtarlarında dönemin
  // ilk günü); geriye doğru ilerler.
  next: Record<string, string>;
  // Anahtar başına en eski gün (dahil).
  floor: Record<string, string>;
  startedAt: string;
  doneAt?: string;
  // Ağır blok yüzünden bekleyen sorgu×sayfa haftaları (Pazartesi).
  heavyPending: string[];
  gaps: GscGap[];
  // 'brand' anahtarının hangi terim özetiyle çekildiği ("none", "error:…" ya
  // da brandTermsHash).
  brandHash: string | null;
  // İsteğe bağlı türlerde satır hiç geldi mi / kaç parça bitti.
  rowsSeen: Record<string, boolean>;
  chunksDone: Record<string, number>;
  // Anahtar başına sıfır sayılmayı bekleyen aralığın son günü (bkz.
  // backfillWriteDays): ana geçmişte satırsız kalan yeni taraftaki günler.
  zeroPendingTo: Record<string, string>;
};

export type GscBackfillChunk = {
  key: string;
  start: string;
  end: string;
  // En az istek sayısı (bütçe yetmiyorsa parça başlatılmaz).
  requests: number;
  // Boşluk parçasıysa boşluğun ilk günü; ana geçmişte null.
  gapStart: string | null;
};

type KeyKind = "totals" | "brand" | "slice" | "monthly" | "weekly";

function kindOf(key: string): KeyKind {
  if (key === "brand") return "brand";
  if (key === "monthly") return "monthly";
  if (key === "weekly") return "weekly";
  if (key.startsWith("slice:")) return "slice";
  return "totals";
}

function requestsFor(kind: KeyKind): number {
  if (kind === "monthly") return 2;
  if (kind === "weekly") return 3;
  return 1;
}

function isOptionalTotals(key: string): boolean {
  return kindOf(key) === "totals" && key !== "totals:web";
}

export function brandErrorHash(hash: string): string {
  return `${BRAND_ERROR_PREFIX}${hash}`;
}

export function isBrandErrorHash(hash: string | null | undefined): boolean {
  return typeof hash === "string" && hash.startsWith(BRAND_ERROR_PREFIX);
}

function done(next: string | undefined, floor: string | undefined): boolean {
  return !next || !floor || next < floor;
}

function mainKeyDone(state: GscBackfillState, key: string): boolean {
  return done(state.next[key], state.floor[key]);
}

function gapKeyDone(gap: GscGap, key: string): boolean {
  return done(gap.next[key], gap.start);
}

function gapFinished(gap: GscGap, skipKeys?: ReadonlySet<string>): boolean {
  return GSC_GAP_KEYS.every(
    (key) => skipKeys?.has(key) || gapKeyDone(gap, key),
  );
}

function clone(state: GscBackfillState): GscBackfillState {
  return {
    ...state,
    next: { ...state.next },
    floor: { ...state.floor },
    heavyPending: [...state.heavyPending],
    gaps: state.gaps.map((gap) => ({ ...gap, next: { ...gap.next } })),
    rowsSeen: { ...state.rowsSeen },
    chunksDone: { ...state.chunksDone },
    zeroPendingTo: { ...state.zeroPendingTo },
  };
}

// Parçadan sonra anahtarın bekleyen sıfır aralığı (null: yok).
export function setZeroPending(
  state: GscBackfillState,
  key: string,
  pendingTo: string | null,
): GscBackfillState {
  if ((state.zeroPendingTo[key] ?? null) === pendingTo) return state;
  const next = clone(state);
  if (pendingTo === null) delete next.zeroPendingTo[key];
  else next.zeroPendingTo[key] = pendingTo;
  return next;
}

export function initialGscBackfill(input: {
  today: string;
  finalThrough: string;
  lastWeeklyWeek: string | null;
  lastMonthlyMonth: string | null;
  brandHash: string | null;
  now: Date;
}): GscBackfillState {
  const window = googleWindowStart(input.today);
  const dailyNext = addDays(input.today, -GSC_DAILY_WINDOW_DAYS - 1);
  const next: Record<string, string> = {};
  const floor: Record<string, string> = {};
  for (const key of GSC_GAP_KEYS) {
    next[key] = dailyNext;
    floor[key] = window;
  }
  const latestMonth =
    input.lastMonthlyMonth ?? lastCompleteMonthStart(input.finalThrough);
  next.monthly = addMonths(latestMonth, -1);
  floor.monthly = firstMonthStartOnOrAfter(window);
  // En çok 70 hafta (son tam hafta dahil; onu haftalık aşama çeker).
  const latestWeek =
    input.lastWeeklyWeek ?? lastCompleteWeekStart(input.finalThrough);
  next.weekly = addWeeks(latestWeek, -1);
  floor.weekly =
    maxDay(firstWeekStartOnOrAfter(window), addWeeks(latestWeek, -69)) ??
    firstWeekStartOnOrAfter(window);
  return {
    v: 1,
    next,
    floor,
    startedAt: input.now.toISOString(),
    heavyPending: [],
    gaps: [],
    brandHash: input.brandHash,
    rowsSeen: {},
    chunksDone: {},
    zeroPendingTo: {},
  };
}

function chunkFor(
  key: string,
  next: string,
  floor: string,
  gapStart: string | null,
): GscBackfillChunk {
  const kind = kindOf(key);
  if (kind === "monthly") {
    return { key, start: next, end: monthEnd(next), requests: 2, gapStart };
  }
  if (kind === "weekly") {
    return { key, start: next, end: weekEndOf(next), requests: 3, gapStart };
  }
  const days = GSC_CHUNK_DAYS[kind];
  const start = maxDay(floor, addDays(next, -days + 1)) ?? floor;
  return { key, start, end: next, requests: requestsFor(kind), gapStart };
}

// Sıradaki parça: önce en eski boşluk (GSC_GAP_KEYS sırasıyla), sonra ana
// anahtarlar GSC_BACKFILL_ORDER sırasıyla. `skipKeys` (kapalı kırılım, boş
// tür, marka bağlamı yok) atlanır. İş yoksa null.
export function nextGscBackfillChunk(
  state: GscBackfillState,
  skipKeys?: ReadonlySet<string>,
): GscBackfillChunk | null {
  const gaps = [...state.gaps].sort((a, b) => a.start.localeCompare(b.start));
  for (const gap of gaps) {
    for (const key of GSC_GAP_KEYS) {
      if (skipKeys?.has(key) || gapKeyDone(gap, key)) continue;
      return chunkFor(key, gap.next[key]!, gap.start, gap.start);
    }
  }
  for (const key of GSC_BACKFILL_ORDER) {
    if (skipKeys?.has(key) || mainKeyDone(state, key)) continue;
    return chunkFor(key, state.next[key]!, state.floor[key]!, null);
  }
  return null;
}

function before(key: string, start: string): string {
  const kind = kindOf(key);
  if (kind === "monthly") return addMonths(start, -1);
  if (kind === "weekly") return addWeeks(start, -1);
  return addDays(start, -1);
}

// Biten (ya da yalnız atlanan anahtarları kalan) boşluklar düşer.
export function dropFinishedGaps(
  state: GscBackfillState,
  skipKeys?: ReadonlySet<string>,
): GscBackfillState {
  if (!state.gaps.some((gap) => gapFinished(gap, skipKeys))) return state;
  return {
    ...state,
    gaps: state.gaps.filter((gap) => !gapFinished(gap, skipKeys)),
  };
}

// Parça yazıldı: imleç parçanın başının altına iner. `skipKeys` verilirse
// yalnız atlanan anahtarları kalan boşluk da düşer.
export function advanceGscBackfill(
  state: GscBackfillState,
  chunk: GscBackfillChunk,
  skipKeys?: ReadonlySet<string>,
): GscBackfillState {
  const next = clone(state);
  const cursor = before(chunk.key, chunk.start);
  if (chunk.gapStart !== null) {
    const gap = next.gaps.find(
      (candidate) => candidate.start === chunk.gapStart,
    );
    if (gap) gap.next[chunk.key] = cursor;
    return dropFinishedGaps(next, skipKeys);
  }
  next.next[chunk.key] = cursor;
  return next;
}

// Anahtar bitti sayılır: ana geçmişte ve her boşlukta.
export function skipGscBackfillKey(
  state: GscBackfillState,
  key: string,
): GscBackfillState {
  const next = clone(state);
  const floor = next.floor[key];
  if (floor) next.next[key] = before(key, floor);
  for (const gap of next.gaps) {
    if (key in gap.next) gap.next[key] = addDays(gap.start, -1);
  }
  return dropFinishedGaps(next);
}

// İsteğe bağlı tür (image, news, ...) en yeni iki parçada hiç satır
// döndürmediyse boştur: anahtar biter, tür ayda bir yeniden yoklanır.
export function noteTotalsChunk(
  state: GscBackfillState,
  key: string,
  hadRows: boolean,
): { state: GscBackfillState; empty: boolean } {
  const next = clone(state);
  next.rowsSeen[key] = Boolean(next.rowsSeen[key]) || hadRows;
  next.chunksDone[key] = (next.chunksDone[key] ?? 0) + 1;
  const empty =
    isOptionalTotals(key) &&
    !next.rowsSeen[key] &&
    (next.chunksDone[key] ?? 0) >= 2;
  return { state: next, empty };
}

// Boşluk eklenir; çakışan ya da bitişik boşluklar birleşir (birleşen boşluk
// baştan çekilir: yazım idempotenttir). Marka serisi yoksa ya da Google'da
// geçersizse boşluğun marka imleci baştan kapalıdır.
export function addGscGap(
  state: GscBackfillState,
  gap: { start: string; end: string },
): GscBackfillState {
  if (gap.start > gap.end) return state;
  let start = gap.start;
  let end = gap.end;
  const kept: GscGap[] = [];
  for (const existing of state.gaps) {
    const touches =
      existing.start <= addDays(end, 1) && addDays(existing.end, 1) >= start;
    if (touches) {
      start = existing.start < start ? existing.start : start;
      end = existing.end > end ? existing.end : end;
    } else {
      kept.push({ ...existing, next: { ...existing.next } });
    }
  }
  const brandClosed =
    state.brandHash === "none" || isBrandErrorHash(state.brandHash);
  const next: Record<string, string> = {};
  for (const key of GSC_GAP_KEYS) {
    next[key] = key === "brand" && brandClosed ? addDays(start, -1) : end;
  }
  kept.push({ start, end, next });
  kept.sort((a, b) => a.start.localeCompare(b.start));
  return { ...clone(state), gaps: kept };
}

// Marka terimleri değişti: 'brand' anahtarı yeni özetle Google penceresinin
// başından yeniden açılır (90 günlük parçalarla); boşlukların marka imleçleri
// kapanır (ana anahtar onları da kapsar). Düzenli ifade yoksa (terim yok ya da
// geçersiz) anahtar biter. Aynı özet (ya da aynı özetin hatası) değişiklik
// değildir.
export function retargetBrand(
  state: GscBackfillState,
  input: { hash: string; hasRegex: boolean; floor: string; end: string },
): { state: GscBackfillState; changed: boolean } {
  if (
    state.brandHash === input.hash ||
    state.brandHash === brandErrorHash(input.hash)
  ) {
    return { state, changed: false };
  }
  const next = clone(state);
  next.brandHash = input.hash;
  next.floor.brand = input.floor;
  next.next.brand = input.hasRegex ? input.end : addDays(input.floor, -1);
  for (const gap of next.gaps) gap.next.brand = addDays(gap.start, -1);
  return { state: dropFinishedGaps(next), changed: true };
}

export function brandKeyDone(state: GscBackfillState): boolean {
  return mainKeyDone(state, "brand");
}

// Ana geçmiş bitti mi (boşluklar ve ağır kuyruk sayılmaz).
export function gscBackfillComplete(
  state: GscBackfillState,
  skipKeys?: ReadonlySet<string>,
): boolean {
  return GSC_BACKFILL_ORDER.every(
    (key) => skipKeys?.has(key) || mainKeyDone(state, key),
  );
}

export function queueHeavy(
  state: GscBackfillState,
  weekStart: string,
): GscBackfillState {
  if (state.heavyPending.includes(weekStart)) return state;
  return { ...clone(state), heavyPending: [...state.heavyPending, weekStart] };
}

export function takeHeavy(state: GscBackfillState): {
  week: string | null;
  state: GscBackfillState;
} {
  const [week, ...rest] = state.heavyPending;
  if (!week) return { week: null, state };
  return { week, state: { ...clone(state), heavyPending: rest } };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringRecord(value: unknown): Record<string, string> | null {
  if (!isRecord(value)) return null;
  const out: Record<string, string> = {};
  for (const [key, item] of Object.entries(value)) {
    if (typeof item !== "string") return null;
    out[key] = item;
  }
  return out;
}

function typedRecord<T>(
  value: unknown,
  check: (item: unknown) => item is T,
): Record<string, T> {
  if (!isRecord(value)) return {};
  const out: Record<string, T> = {};
  for (const [key, item] of Object.entries(value)) {
    if (check(item)) out[key] = item;
  }
  return out;
}

const isBoolean = (item: unknown): item is boolean => typeof item === "boolean";
const isString = (item: unknown): item is string => typeof item === "string";
const isNumber = (item: unknown): item is number =>
  typeof item === "number" && Number.isFinite(item);

function parseGap(value: unknown): GscGap | null {
  if (!isRecord(value)) return null;
  const next = stringRecord(value.next);
  if (
    typeof value.start !== "string" ||
    typeof value.end !== "string" ||
    !next
  ) {
    return null;
  }
  return { start: value.start, end: value.end, next };
}

export function parseGscBackfillState(value: unknown): GscBackfillState | null {
  if (!isRecord(value) || value.v !== 1) return null;
  const next = stringRecord(value.next);
  const floor = stringRecord(value.floor);
  if (!next || !floor || typeof value.startedAt !== "string") return null;
  const heavy = value.heavyPending ?? [];
  if (
    !Array.isArray(heavy) ||
    !heavy.every((item) => typeof item === "string")
  ) {
    return null;
  }
  const rawGaps = value.gaps ?? [];
  if (!Array.isArray(rawGaps)) return null;
  const gaps = rawGaps.map(parseGap);
  if (gaps.some((gap) => gap === null)) return null;
  const brandHash = value.brandHash ?? null;
  if (brandHash !== null && typeof brandHash !== "string") return null;
  return {
    v: 1,
    next,
    floor,
    startedAt: value.startedAt,
    ...(typeof value.doneAt === "string" ? { doneAt: value.doneAt } : {}),
    heavyPending: heavy as string[],
    gaps: gaps as GscGap[],
    brandHash,
    rowsSeen: typedRecord(value.rowsSeen, isBoolean),
    chunksDone: typedRecord(value.chunksDone, isNumber),
    zeroPendingTo: typedRecord(value.zeroPendingTo, isString),
  };
}
