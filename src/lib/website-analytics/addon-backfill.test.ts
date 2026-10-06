import { describe, expect, it } from "vitest";

import {
  activeAddonKeys,
  addonBackfillDone,
  addonKey,
  addonStageDue,
  advanceAddon,
  ensureAddonKeys,
  nextAddonChunks,
  parseAddonKey,
  readAddonState,
  writeAddonState,
  type GaAddonChunk,
  type GaAddonState,
} from "./addon-backfill";
import { addDays } from "./days";
import { mondaysBetween } from "./weeks";

// Bu dosyanın kanıtladığı: eklenti anahtarları yalnız eksikken kurulur;
// kurulmamış anahtar aşamayı vadeli, geçmişi bitmemiş sayar; ileri parçalar
// (P2) geri parçalardan (P2_BACKFILL) önce gelir ve şeritler karışmaz; geri
// yürüyüş boşluksuz ve çakışmasız zemine iner ve doneAt'i yazar; Search
// Console penceresi yalnız yeni kesinleşen haftada vadelidir; katalogdan
// düşen raporların anahtarı yürümez; temel geri doldurma alanları korunur.

const TODAY = "2026-10-06";
const NOW = new Date("2026-10-06T12:00:00.000Z");
const WEEK_LP = "week:landing_page";
const DAY_ADS = "day:google_ads";
const WINDOW_SC = "window:search_console";
const ALL = [WEEK_LP, DAY_ADS, WINDOW_SC];

function empty(): GaAddonState {
  return readAddonState(null);
}

function init(keys: string[] = ALL, today = TODAY): GaAddonState {
  return ensureAddonKeys(empty(), keys, { today, propertyCreated: null });
}

describe("addon keys", () => {
  it("formats and parses keys", () => {
    expect(addonKey("week", "landing_page")).toBe(WEEK_LP);
    expect(parseAddonKey("window:search_console")).toEqual({
      kind: "window",
      reportKey: "search_console",
    });
    expect(parseAddonKey("landing_page")).toBeNull();
    expect(parseAddonKey("month:x")).toBeNull();
  });

  it("follows the flags and the disabled reports", () => {
    const none = new Set<string>();
    expect(
      activeAddonKeys({
        weekly: true,
        googleAds: true,
        searchConsole: true,
        disabled: none,
      }),
    ).toEqual([
      "week:source_medium",
      "week:campaign",
      "week:landing_page",
      "week:page",
      "week:device_country",
      "week:site_search",
      DAY_ADS,
      WINDOW_SC,
    ]);
    const without = (disabled: string[]) =>
      activeAddonKeys({
        weekly: true,
        googleAds: true,
        searchConsole: true,
        disabled: new Set(disabled),
      });
    expect(without(["landing_page"])).not.toContain(WEEK_LP);
    expect(without(["week:landing_page"])).not.toContain(WEEK_LP);
    expect(without(["week:landing_page"])).toContain("week:page");
    expect(without(["site_search"])).not.toContain("week:site_search");
    expect(without(["google_ads", "search_console"])).not.toContain(DAY_ADS);
    expect(without(["search_console"])).not.toContain(WINDOW_SC);
    expect(
      activeAddonKeys({
        weekly: false,
        googleAds: false,
        searchConsole: false,
        disabled: none,
      }),
    ).toEqual([]);
  });
});

describe("ensureAddonKeys", () => {
  it("initialises each kind and never overwrites", () => {
    const state = init();
    expect(state.next[WEEK_LP]).toBe("2026-09-21");
    expect(state.through[WEEK_LP]).toBe("2026-09-21");
    expect(state.floor[WEEK_LP]).toBe("2025-09-01");
    expect(state.next[DAY_ADS]).toBe("2026-09-28");
    expect(state.floor[DAY_ADS]).toBe(addDays(TODAY, -400));
    expect(state.through[DAY_ADS]).toBeUndefined();
    // Pencere anahtarında kurulacak bir şey yok.
    expect(state.through[WINDOW_SC]).toBeUndefined();
    expect(state.next[WINDOW_SC]).toBeUndefined();

    const moved = {
      ...state,
      next: { ...state.next, [WEEK_LP]: "2026-01-05" },
    };
    const again = ensureAddonKeys(moved, ALL, {
      today: "2026-11-30",
      propertyCreated: "2026-01-01",
    });
    expect(again.next[WEEK_LP]).toBe("2026-01-05");
    expect(again.floor[WEEK_LP]).toBe("2025-09-01");
    expect(again.floor[DAY_ADS]).toBe(state.floor[DAY_ADS]);
  });

  it("limits the floor to a young property and finishes at once when nothing is older", () => {
    const young = ensureAddonKeys(empty(), [WEEK_LP, DAY_ADS], {
      today: TODAY,
      propertyCreated: "2026-09-30",
    });
    expect(young.floor[DAY_ADS]).toBe("2026-09-30");
    expect(young.floor[WEEK_LP]).toBe("2026-09-28");
    // Kesinleşmiş hafta mülkten eski: geçmiş baştan bitmiş.
    expect(addonBackfillDone(young, WEEK_LP)).toBe(true);
    expect(addonBackfillDone(young, DAY_ADS)).toBe(true);
    expect(nextAddonChunks(young, [WEEK_LP, DAY_ADS], TODAY, 5)).toEqual([]);
    expect(addonStageDue(young, [WEEK_LP, DAY_ADS], TODAY)).toBe(false);
  });
});

describe("uninitialised keys", () => {
  it("are due and never done", () => {
    const state = empty();
    for (const key of ALL) {
      expect(addonStageDue(state, [key], TODAY)).toBe(true);
      expect(addonBackfillDone(state, key)).toBe(false);
    }
    // Hiç bilinmeyen anahtar da bitmemiş sayılır.
    expect(addonBackfillDone(init(), "week:page")).toBe(false);
    // Kurulmamış week/day anahtarı parça üretmez.
    expect(nextAddonChunks(state, [WEEK_LP, DAY_ADS], TODAY, 5)).toEqual([]);
  });
});

describe("nextAddonChunks", () => {
  it("runs forward chunks first and never mixes lanes", () => {
    const state = init();
    const later = "2026-10-20";
    const forward = nextAddonChunks(state, ALL, later, 5);
    expect(forward.map((chunk) => chunk.lane)).toEqual(["P2", "P2"]);
    expect(forward).toEqual([
      {
        key: WEEK_LP,
        kind: "week",
        reportKey: "landing_page",
        start: "2026-09-28",
        end: "2026-10-05",
        lane: "P2",
        forward: true,
      },
      {
        key: WINDOW_SC,
        kind: "window",
        reportKey: "search_console",
        start: "2026-10-05",
        end: "2026-10-05",
        lane: "P2",
        forward: true,
      },
    ]);
    let next = state;
    for (const chunk of forward) next = advanceAddon(next, chunk, NOW);
    expect(next.through[WEEK_LP]).toBe("2026-10-05");
    expect(next.through[WINDOW_SC]).toBe("2026-10-05");
    const backfill = nextAddonChunks(next, ALL, later, 5);
    expect(backfill.length).toBeGreaterThan(0);
    expect(backfill.every((chunk) => chunk.lane === "P2_BACKFILL")).toBe(true);
    // En yeni önce.
    expect(backfill.map((chunk) => chunk.key)).toEqual([DAY_ADS, WEEK_LP]);
    expect(nextAddonChunks(next, ALL, later, 1)).toHaveLength(1);
  });

  it("walks back to the floor without gaps or overlaps and sets doneAt", () => {
    let state = init([WEEK_LP, DAY_ADS]);
    const weeks: string[] = [];
    const days: string[] = [];
    for (let round = 0; round < 50; round += 1) {
      const chunks: GaAddonChunk[] = nextAddonChunks(
        state,
        [WEEK_LP, DAY_ADS],
        TODAY,
        5,
      );
      if (chunks.length === 0) break;
      for (const chunk of chunks) {
        expect(chunk.start <= chunk.end).toBe(true);
        if (chunk.kind === "week") {
          weeks.push(...mondaysBetween(chunk.start, chunk.end));
        } else {
          for (let day = chunk.start; day <= chunk.end; day = addDays(day, 1)) {
            days.push(day);
          }
        }
        state = advanceAddon(state, chunk, NOW);
      }
    }
    expect([...weeks].sort()).toEqual(
      mondaysBetween("2025-09-01", "2026-09-21"),
    );
    expect(new Set(days).size).toBe(days.length);
    expect(days.length).toBe(
      Math.round(
        (Date.parse("2026-09-28") - Date.parse(addDays(TODAY, -400))) /
          86_400_000,
      ) + 1,
    );
    expect(state.doneAt[WEEK_LP]).toBe(NOW.toISOString());
    expect(addonBackfillDone(state, WEEK_LP)).toBe(true);
    expect(addonBackfillDone(state, DAY_ADS)).toBe(true);
    expect(addonStageDue(state, [WEEK_LP, DAY_ADS], TODAY)).toBe(false);
    // Yeni bir hafta kesinleşince ileri parça yeniden vadeli olur.
    expect(addonStageDue(state, [WEEK_LP], "2026-10-13")).toBe(true);
  });

  it("asks the Search Console window only when a new week is final", () => {
    let state = init([WINDOW_SC]);
    expect(addonStageDue(state, [WINDOW_SC], TODAY)).toBe(true);
    const [chunk] = nextAddonChunks(state, [WINDOW_SC], TODAY, 5);
    // 2026-10-06 - 3 = 2026-10-03 (Cumartesi): son tam hafta 21 Eylül.
    expect(chunk?.start).toBe("2026-09-21");
    state = advanceAddon(state, chunk!, NOW);
    expect(addonBackfillDone(state, WINDOW_SC)).toBe(true);
    expect(addonStageDue(state, [WINDOW_SC], TODAY)).toBe(false);
    expect(nextAddonChunks(state, [WINDOW_SC], TODAY, 5)).toEqual([]);
    expect(addonStageDue(state, [WINDOW_SC], "2026-10-07")).toBe(true);
  });
});

describe("addon state in the backfill JSON", () => {
  it("keeps the base backfill fields", () => {
    const base = {
      v: 1,
      next: { totals: "2025-09-01" },
      floor: { totals: "2025-09-01" },
      startedAt: "2026-09-01T00:00:00.000Z",
      doneAt: "2026-09-02T00:00:00.000Z",
    };
    const state = init();
    const written = writeAddonState(base, state);
    expect(written).toEqual({ ...base, addons: state });
    expect(readAddonState(written)).toEqual(state);
    expect(readAddonState({ ...base, addons: { v: 9 } })).toEqual(empty());
    expect(writeAddonState(null, state)).toEqual({ addons: state });
  });
});
