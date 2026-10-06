import { gaReportSpec } from "./catalog";
import { addDays } from "./days";
import {
  GA_WEEKLY_REPORTS,
  GA_WINDOW_REPORTS,
  gaWeeklySpec,
  weeklyDisableKey,
} from "./weekly";
import { latestCompleteWeek, weeklyFloor } from "./weeks";

// Eklenti geçmişi (docs/google-analytics-plan.md §3.3 "Geri doldurma", GA-F2
// bölüm 2): haftalık dilimler (week:<rapor>), google_ads (day:google_ads) ve
// search_console penceresi (window:search_console) temel geri doldurma
// bittikten sonra GaPropertyLink.backfill.addons'ta izlenir; backfillDoneAt'e
// dokunulmaz, bağlantıyı sıfırlamadan eski bağlar da geçmişi alır.
// Haftalık anahtarlar ileri (yeni kesinleşen haftalar, P2) ve geri (eskiye
// doğru, P2_BACKFILL) yürür; günlük anahtar yalnız geri yürür (ileriyi günlük
// çekim yapar); pencere anahtarı yalnız son kesinleşen haftayı çeker.
// Buradaki anahtarlar durum defteridir; katalogdaki düşürme anahtarları
// ayrıdır (weeklyDisableKey). Saf modül.

export type GaAddonKind = "week" | "day" | "window";

const KINDS: readonly GaAddonKind[] = ["week", "day", "window"];

export function addonKey(kind: GaAddonKind, reportKey: string): string {
  return `${kind}:${reportKey}`;
}

export function parseAddonKey(
  key: string,
): { kind: GaAddonKind; reportKey: string } | null {
  const at = key.indexOf(":");
  if (at <= 0) return null;
  const kind = KINDS.find((candidate) => candidate === key.slice(0, at));
  const reportKey = key.slice(at + 1);
  return kind && reportKey ? { kind, reportKey } : null;
}

export type GaAddonState = {
  v: 1;
  // week/day: sıradaki geri parçanın son günü (Pazartesi ya da gün).
  next: Record<string, string>;
  // week/day: en eski hafta ya da gün (dahil).
  floor: Record<string, string>;
  // week: çekilen en yeni hafta; window: son çekilen pencerenin haftası.
  through: Record<string, string>;
  // week/day: geri doldurmanın bittiği an.
  doneAt: Record<string, string>;
};

function objectOf(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function stringRecord(value: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, item] of Object.entries(objectOf(value) ?? {})) {
    if (typeof item === "string") out[key] = item;
  }
  return out;
}

function emptyState(): GaAddonState {
  return { v: 1, next: {}, floor: {}, through: {}, doneAt: {} };
}

// Eksik ya da bozuk durum boş sayılır.
export function readAddonState(backfillJson: unknown): GaAddonState {
  const addons = objectOf(objectOf(backfillJson)?.addons);
  if (!addons || addons.v !== 1) return emptyState();
  return {
    v: 1,
    next: stringRecord(addons.next),
    floor: stringRecord(addons.floor),
    through: stringRecord(addons.through),
    doneAt: stringRecord(addons.doneAt),
  };
}

// Temel geri doldurma durumunun (v, next, floor, startedAt, doneAt) bütün
// alanları korunur.
export function writeAddonState(
  backfillJson: unknown,
  state: GaAddonState,
): Record<string, unknown> {
  return { ...(objectOf(backfillJson) ?? {}), addons: state };
}

// Bu turda yürüyecek anahtarlar: bayrağı açık ve katalogdan düşmemiş olanlar.
export function activeAddonKeys(input: {
  weekly: boolean;
  googleAds: boolean;
  searchConsole: boolean;
  disabled: ReadonlySet<string>;
}): string[] {
  const keys: string[] = [];
  if (input.weekly) {
    for (const spec of GA_WEEKLY_REPORTS) {
      if (
        input.disabled.has(spec.key) ||
        input.disabled.has(weeklyDisableKey(spec))
      ) {
        continue;
      }
      keys.push(addonKey("week", spec.key));
    }
  }
  if (input.googleAds && !input.disabled.has("google_ads")) {
    keys.push(addonKey("day", "google_ads"));
  }
  if (input.searchConsole && !input.disabled.has("search_console")) {
    keys.push(addonKey("window", "search_console"));
  }
  return keys;
}

// Yalnız eksik anahtarları kurar; kurulu olanlara dokunmaz. Taban zemininden
// eskiyse (çok yeni mülk) geri doldurma baştan bitmiş sayılır.
export function ensureAddonKeys(
  state: GaAddonState,
  keys: string[],
  input: { today: string; propertyCreated: string | null },
): GaAddonState {
  const next = { ...state.next };
  const floor = { ...state.floor };
  const through = { ...state.through };
  const doneAt = { ...state.doneAt };
  for (const key of keys) {
    const parsed = parseAddonKey(key);
    if (!parsed || parsed.kind === "window") continue;
    if (next[key] === undefined) {
      if (parsed.kind === "week") {
        const spec = gaWeeklySpec(parsed.reportKey);
        if (!spec) continue;
        const target = latestCompleteWeek(input.today, spec.lagDays);
        through[key] = target;
        next[key] = target;
        floor[key] = weeklyFloor(
          input.today,
          spec.retentionDays,
          input.propertyCreated,
        );
      } else {
        const spec = gaReportSpec(parsed.reportKey);
        if (!spec) continue;
        const oldest = addDays(input.today, -spec.backfillDays);
        next[key] = addDays(input.today, -(spec.revisionDays + 1));
        floor[key] =
          input.propertyCreated && input.propertyCreated > oldest
            ? input.propertyCreated
            : oldest;
      }
    }
    if (doneAt[key] === undefined && next[key]! < (floor[key] ?? "")) {
      doneAt[key] = `${input.today}T00:00:00.000Z`;
    }
  }
  return { v: 1, next, floor, through, doneAt };
}

export type GaAddonChunk = {
  key: string;
  kind: GaAddonKind;
  reportKey: string;
  start: string;
  end: string;
  lane: "P2" | "P2_BACKFILL";
  forward: boolean;
};

function forwardChunk(
  state: GaAddonState,
  key: string,
  today: string,
): GaAddonChunk | null {
  const parsed = parseAddonKey(key);
  if (!parsed) return null;
  if (parsed.kind === "week") {
    const spec = gaWeeklySpec(parsed.reportKey);
    const through = state.through[key];
    if (!spec || state.next[key] === undefined || !through) return null;
    const target = latestCompleteWeek(today, spec.lagDays);
    if (through >= target) return null;
    const start = addDays(through, 7);
    const last = addDays(start, 7 * (spec.chunkWeeks - 1));
    return {
      key,
      ...parsed,
      start,
      end: last < target ? last : target,
      lane: "P2",
      forward: true,
    };
  }
  if (parsed.kind === "window") {
    const spec = GA_WINDOW_REPORTS.find(
      (candidate) => candidate.key === parsed.reportKey,
    );
    if (!spec) return null;
    const target = latestCompleteWeek(today, spec.lagDays);
    const through = state.through[key];
    if (through && through >= target) return null;
    return {
      key,
      ...parsed,
      start: target,
      end: target,
      lane: "P2",
      forward: true,
    };
  }
  return null;
}

function backfillChunk(state: GaAddonState, key: string): GaAddonChunk | null {
  const parsed = parseAddonKey(key);
  if (!parsed || parsed.kind === "window") return null;
  const end = state.next[key];
  const floor = state.floor[key];
  if (!end || !floor || state.doneAt[key] !== undefined || end < floor) {
    return null;
  }
  let start: string;
  if (parsed.kind === "week") {
    const spec = gaWeeklySpec(parsed.reportKey);
    if (!spec) return null;
    start = addDays(end, -7 * (spec.chunkWeeks - 1));
  } else {
    const spec = gaReportSpec(parsed.reportKey);
    if (!spec) return null;
    start = addDays(end, -(spec.chunkDays - 1));
  }
  return {
    key,
    ...parsed,
    start: start < floor ? floor : start,
    end,
    lane: "P2_BACKFILL",
    forward: false,
  };
}

// Önce vadesi gelen ileri parçalar (P2); yoksa geri parçalar (P2_BACKFILL),
// en yeni önce. Şeritler hiç karışmaz. Kurulmamış week/day anahtarları
// atlanır (çağıran önce ensureAddonKeys'i çalıştırır).
export function nextAddonChunks(
  state: GaAddonState,
  keys: string[],
  today: string,
  max: number,
): GaAddonChunk[] {
  if (max <= 0) return [];
  const forward = keys
    .map((key) => forwardChunk(state, key, today))
    .filter((chunk): chunk is GaAddonChunk => chunk !== null);
  if (forward.length > 0) return forward.slice(0, max);
  return keys
    .map((key) => backfillChunk(state, key))
    .filter((chunk): chunk is GaAddonChunk => chunk !== null)
    .sort((a, b) => b.end.localeCompare(a.end))
    .slice(0, max);
}

export function advanceAddon(
  state: GaAddonState,
  chunk: GaAddonChunk,
  now: Date,
): GaAddonState {
  if (chunk.forward) {
    return {
      ...state,
      through: {
        ...state.through,
        [chunk.key]: chunk.kind === "window" ? chunk.start : chunk.end,
      },
    };
  }
  const next =
    chunk.kind === "week" ? addDays(chunk.start, -7) : addDays(chunk.start, -1);
  const done = next < (state.floor[chunk.key] ?? "");
  return {
    ...state,
    next: { ...state.next, [chunk.key]: next },
    doneAt: done
      ? { ...state.doneAt, [chunk.key]: now.toISOString() }
      : state.doneAt,
  };
}

// Eklenti aşaması bu turda gerekli mi: kurulmamış anahtar (week/day: next
// yok; window: through yok), vadesi gelen ileri parça ya da bitmemiş geri
// doldurma (doneAt yok).
export function addonStageDue(
  state: GaAddonState,
  keys: string[],
  today: string,
): boolean {
  return keys.some((key) => {
    const parsed = parseAddonKey(key);
    if (!parsed) return false;
    if (parsed.kind === "window") {
      return (
        state.through[key] === undefined ||
        forwardChunk(state, key, today) !== null
      );
    }
    if (state.next[key] === undefined) return true;
    if (forwardChunk(state, key, today) !== null) return true;
    return state.doneAt[key] === undefined;
  });
}

// Kurulmamış ya da hiç bilinmeyen anahtar bitmemiş sayılır; pencere anahtarı
// ilk pencere çekilince biter.
export function addonBackfillDone(state: GaAddonState, key: string): boolean {
  if (parseAddonKey(key)?.kind === "window") {
    return state.through[key] !== undefined;
  }
  return state.doneAt[key] !== undefined;
}
