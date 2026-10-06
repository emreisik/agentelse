import { describe, expect, it } from "vitest";

import {
  GSC_BACKFILL_ORDER,
  GSC_GAP_KEYS,
  addGscGap,
  advanceGscBackfill,
  brandErrorHash,
  brandKeyDone,
  gscBackfillComplete,
  initialGscBackfill,
  nextGscBackfillChunk,
  noteTotalsChunk,
  parseGscBackfillState,
  queueHeavy,
  retargetBrand,
  setZeroPending,
  skipGscBackfillKey,
  takeHeavy,
  type GscBackfillState,
} from "./backfill";
import { GSC_HEAVY_RANGE_DAYS } from "./catalog";
import { addWeeks, daysInRange } from "./dates";

// Bu dosyanın kanıtladığı: geri doldurma Google'ın 16 aylık penceresinde ve
// en çok 70 haftada durur; önce boşluklar, sonra web, marka, isteğe bağlı
// türler, aylar, kırılımlar, haftalar gelir; hiçbir parça 90 günü aşmaz;
// boşluklar birleşir ve bitince düşer; boş tür iki boş parçadan sonra kapanır;
// marka terimi değişince marka anahtarı yeniden açılır.

const TODAY = "2026-10-06";
const WINDOW = "2025-06-06";

function fresh(overrides: Partial<GscBackfillState> = {}): GscBackfillState {
  return {
    ...initialGscBackfill({
      today: TODAY,
      finalThrough: "2026-10-03",
      lastWeeklyWeek: null,
      lastMonthlyMonth: null,
      brandHash: "abc",
      now: new Date("2026-10-06T15:00:00Z"),
    }),
    ...overrides,
  };
}

// Anahtarı bitene kadar ilerletir.
function drain(state: GscBackfillState, key: string): GscBackfillState {
  let current = state;
  for (let guard = 0; guard < 200; guard += 1) {
    const chunk = nextGscBackfillChunk(
      current,
      new Set(GSC_BACKFILL_ORDER.filter((other) => other !== key)),
    );
    if (!chunk) return current;
    current = advanceGscBackfill(current, chunk);
  }
  throw new Error("did not finish");
}

describe("initialGscBackfill", () => {
  it("floors daily keys at Google's 16-month window and starts below the daily window", () => {
    const state = fresh();
    for (const key of GSC_GAP_KEYS) {
      expect(state.floor[key]).toBe(WINDOW);
      expect(state.next[key]).toBe("2026-09-25");
    }
    expect(state.next.monthly).toBe("2026-08-01");
    expect(state.floor.monthly).toBe("2025-07-01");
    expect(state.next.weekly).toBe("2026-09-14");
    expect(state.floor.weekly).toBe("2025-06-09");
    expect(state.brandHash).toBe("abc");
  });

  it("caps the weekly history at 70 weeks", () => {
    const state = fresh();
    expect(state.floor.weekly! >= addWeeks("2026-09-21", -69)).toBe(true);
    let weeks = 0;
    let current = state;
    for (;;) {
      const chunk = nextGscBackfillChunk(
        current,
        new Set(GSC_BACKFILL_ORDER.filter((key) => key !== "weekly")),
      );
      if (!chunk) break;
      weeks += 1;
      current = advanceGscBackfill(current, chunk);
    }
    // + the latest week the weekly stage fetches.
    expect(weeks + 1).toBeLessThanOrEqual(70);
  });
});

describe("nextGscBackfillChunk", () => {
  it("serves gaps first, then the main keys in priority order", () => {
    let state = addGscGap(fresh(), { start: "2026-08-01", end: "2026-08-20" });
    const first = nextGscBackfillChunk(state)!;
    expect(first).toMatchObject({
      key: "totals:web",
      start: "2026-08-01",
      end: "2026-08-20",
      gapStart: "2026-08-01",
      requests: 1,
    });
    for (const key of GSC_GAP_KEYS) state = skipGscBackfillKey(state, key);
    expect(state.gaps).toEqual([]);

    const order: string[] = [];
    let current = fresh();
    for (const key of GSC_BACKFILL_ORDER) {
      const chunk = nextGscBackfillChunk(current)!;
      order.push(chunk.key);
      current = skipGscBackfillKey(current, key);
    }
    expect(order).toEqual([...GSC_BACKFILL_ORDER]);
    expect(nextGscBackfillChunk(current)).toBeNull();
  });

  it("never builds a daily chunk longer than 90 days (slices 30)", () => {
    const state = fresh();
    for (const key of GSC_GAP_KEYS) {
      let current = state;
      for (;;) {
        const chunk = nextGscBackfillChunk(
          current,
          new Set(GSC_BACKFILL_ORDER.filter((other) => other !== key)),
        );
        if (!chunk) break;
        const days = daysInRange(chunk.start, chunk.end);
        expect(days).toBeLessThanOrEqual(GSC_HEAVY_RANGE_DAYS);
        if (key.startsWith("slice:")) expect(days).toBeLessThanOrEqual(30);
        expect(chunk.start >= WINDOW).toBe(true);
        current = advanceGscBackfill(current, chunk);
      }
    }
  });

  it("asks for a month, then a week, with their minimum request counts", () => {
    let state = fresh();
    for (const key of GSC_GAP_KEYS) state = skipGscBackfillKey(state, key);
    expect(nextGscBackfillChunk(state)).toEqual({
      key: "monthly",
      start: "2026-08-01",
      end: "2026-08-31",
      requests: 2,
      gapStart: null,
    });
    state = skipGscBackfillKey(state, "monthly");
    expect(nextGscBackfillChunk(state)).toEqual({
      key: "weekly",
      start: "2026-09-14",
      end: "2026-09-20",
      requests: 3,
      gapStart: null,
    });
  });
});

describe("advanceGscBackfill", () => {
  it("moves each key type below its chunk", () => {
    const state = fresh();
    const web = nextGscBackfillChunk(state)!;
    expect(web).toMatchObject({ start: "2026-06-28", end: "2026-09-25" });
    expect(advanceGscBackfill(state, web).next["totals:web"]).toBe(
      "2026-06-27",
    );
    const month = { ...web, key: "monthly", start: "2026-08-01" };
    expect(advanceGscBackfill(state, month).next.monthly).toBe("2026-07-01");
    const week = { ...web, key: "weekly", start: "2026-09-14" };
    expect(advanceGscBackfill(state, week).next.weekly).toBe("2026-09-07");
  });

  it("finishes a key at its floor", () => {
    const state = drain(fresh(), "totals:web");
    expect(state.next["totals:web"]! < WINDOW).toBe(true);
    expect(
      nextGscBackfillChunk(
        state,
        new Set(GSC_BACKFILL_ORDER.filter((key) => key !== "totals:web")),
      ),
    ).toBeNull();
  });
});

describe("gaps", () => {
  it("merges overlapping and adjacent gaps", () => {
    let state = addGscGap(fresh(), { start: "2026-08-01", end: "2026-08-10" });
    state = addGscGap(state, { start: "2026-08-05", end: "2026-08-20" });
    state = addGscGap(state, { start: "2026-08-21", end: "2026-08-25" });
    state = addGscGap(state, { start: "2026-07-01", end: "2026-07-02" });
    expect(state.gaps.map((gap) => [gap.start, gap.end])).toEqual([
      ["2026-07-01", "2026-07-02"],
      ["2026-08-01", "2026-08-25"],
    ]);
  });

  it("disappears once all its keys are done", () => {
    let state = addGscGap(fresh(), { start: "2026-08-01", end: "2026-08-20" });
    for (let guard = 0; guard < 20 && state.gaps.length > 0; guard += 1) {
      const chunk = nextGscBackfillChunk(state)!;
      expect(chunk.gapStart).toBe("2026-08-01");
      state = advanceGscBackfill(state, chunk);
    }
    expect(state.gaps).toEqual([]);
    expect(nextGscBackfillChunk(state)?.gapStart).toBeNull();
  });

  it("drops a gap whose remaining keys are all skipped", () => {
    let state = addGscGap(fresh(), { start: "2026-08-01", end: "2026-08-20" });
    const skip = new Set(GSC_GAP_KEYS.filter((key) => key !== "totals:web"));
    const chunk = nextGscBackfillChunk(state, skip)!;
    state = advanceGscBackfill(state, chunk, skip);
    expect(state.gaps).toEqual([]);
  });

  it("starts with the brand cursor closed when there is no brand series", () => {
    const state = addGscGap(fresh({ brandHash: "none" }), {
      start: "2026-08-01",
      end: "2026-08-20",
    });
    expect(state.gaps[0]!.next.brand! < "2026-08-01").toBe(true);
  });
});

describe("skipGscBackfillKey", () => {
  it("marks the key done in the main history and every gap", () => {
    let state = addGscGap(fresh(), { start: "2026-08-01", end: "2026-08-20" });
    state = skipGscBackfillKey(state, "slice:appearance");
    expect(state.next["slice:appearance"]! < WINDOW).toBe(true);
    expect(state.gaps[0]!.next["slice:appearance"]! < "2026-08-01").toBe(true);
  });
});

describe("noteTotalsChunk", () => {
  it("marks an optional type empty after two empty chunks", () => {
    let state = fresh();
    let noted = noteTotalsChunk(state, "totals:news", false);
    expect(noted.empty).toBe(false);
    state = noted.state;
    noted = noteTotalsChunk(state, "totals:news", false);
    expect(noted.empty).toBe(true);
  });

  it("never marks web, nor a type that returned rows once", () => {
    let state = fresh();
    for (let index = 0; index < 3; index += 1) {
      const noted = noteTotalsChunk(state, "totals:web", false);
      expect(noted.empty).toBe(false);
      state = noted.state;
    }
    let image = noteTotalsChunk(fresh(), "totals:image", true);
    image = noteTotalsChunk(image.state, "totals:image", false);
    image = noteTotalsChunk(image.state, "totals:image", false);
    expect(image.empty).toBe(false);
  });
});

describe("retargetBrand", () => {
  const input = { floor: WINDOW, end: "2026-09-25" };

  it("does nothing for the same hash (or that hash's error)", () => {
    const state = fresh();
    expect(
      retargetBrand(state, { ...input, hash: "abc", hasRegex: true }).changed,
    ).toBe(false);
    const failed = fresh({ brandHash: brandErrorHash("abc") });
    expect(
      retargetBrand(failed, { ...input, hash: "abc", hasRegex: true }).changed,
    ).toBe(false);
  });

  it("reopens the brand key for new terms and closes the gap brand cursors", () => {
    let state = drain(fresh(), "brand");
    state = addGscGap(state, { start: "2026-08-01", end: "2026-08-20" });
    expect(brandKeyDone(state)).toBe(true);
    const result = retargetBrand(state, {
      ...input,
      hash: "def",
      hasRegex: true,
    });
    expect(result.changed).toBe(true);
    expect(result.state.brandHash).toBe("def");
    expect(result.state.next.brand).toBe("2026-09-25");
    expect(brandKeyDone(result.state)).toBe(false);
    expect(result.state.gaps[0]!.next.brand! < "2026-08-01").toBe(true);
  });

  it("marks the brand key done when there is no regex", () => {
    const result = retargetBrand(fresh(), {
      ...input,
      hash: "none",
      hasRegex: false,
    });
    expect(result.changed).toBe(true);
    expect(result.state.brandHash).toBe("none");
    expect(brandKeyDone(result.state)).toBe(true);
  });
});

describe("gscBackfillComplete", () => {
  it("counts only the main keys, not gaps or the heavy queue", () => {
    let state = fresh();
    expect(gscBackfillComplete(state)).toBe(false);
    for (const key of GSC_BACKFILL_ORDER) {
      state = skipGscBackfillKey(state, key);
    }
    state = addGscGap(state, { start: "2026-08-01", end: "2026-08-20" });
    state = queueHeavy(state, "2026-09-14");
    expect(gscBackfillComplete(state)).toBe(true);
  });

  it("treats skipped keys as done", () => {
    let state = fresh();
    for (const key of GSC_BACKFILL_ORDER) {
      if (key !== "slice:appearance") state = skipGscBackfillKey(state, key);
    }
    expect(gscBackfillComplete(state)).toBe(false);
    expect(gscBackfillComplete(state, new Set(["slice:appearance"]))).toBe(
      true,
    );
  });
});

describe("heavy queue", () => {
  it("dedupes and pops in order", () => {
    let state = queueHeavy(fresh(), "2026-09-14");
    state = queueHeavy(state, "2026-09-14");
    state = queueHeavy(state, "2026-09-21");
    expect(state.heavyPending).toEqual(["2026-09-14", "2026-09-21"]);
    const taken = takeHeavy(state);
    expect(taken.week).toBe("2026-09-14");
    expect(taken.state.heavyPending).toEqual(["2026-09-21"]);
    expect(takeHeavy(fresh()).week).toBeNull();
  });
});

describe("parseGscBackfillState", () => {
  it("round-trips a state through JSON", () => {
    const state = setZeroPending(
      addGscGap(queueHeavy(fresh(), "2026-09-14"), {
        start: "2026-08-01",
        end: "2026-08-20",
      }),
      "totals:web",
      "2026-07-01",
    );
    expect(state.zeroPendingTo).toEqual({ "totals:web": "2026-07-01" });
    expect(parseGscBackfillState(JSON.parse(JSON.stringify(state)))).toEqual(
      state,
    );
    expect(setZeroPending(state, "totals:web", null).zeroPendingTo).toEqual(
      {},
    );
  });

  it("reads an older state without pending zeros", () => {
    const { zeroPendingTo, ...older } = fresh();
    expect(zeroPendingTo).toEqual({});
    expect(parseGscBackfillState(older)?.zeroPendingTo).toEqual({});
  });

  it("rejects bad shapes", () => {
    expect(parseGscBackfillState(null)).toBeNull();
    expect(parseGscBackfillState({ v: 2 })).toBeNull();
    expect(parseGscBackfillState({ ...fresh(), next: { a: 1 } })).toBeNull();
    expect(
      parseGscBackfillState({ ...fresh(), gaps: [{ start: 1 }] }),
    ).toBeNull();
    expect(parseGscBackfillState({ ...fresh(), heavyPending: [3] })).toBeNull();
    expect(parseGscBackfillState({ ...fresh(), brandHash: 4 })).toBeNull();
  });
});
