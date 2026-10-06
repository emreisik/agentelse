import { describe, expect, it } from "vitest";

import {
  BACKFILL_KEYS,
  advanceBackfill,
  backfillComplete,
  initialBackfill,
  nextBackfillChunks,
  parseBackfillState,
} from "./backfill";

// Bu dosyanın kanıtladığı: geri doldurma revizyon penceresinin hemen
// öncesinden başlayıp geriye gider, mülkün oluşturulduğu günden eskiye
// inmez, önce bütün raporların yakın geçmişini getirir ve bittiğini bilir.

const now = new Date("2026-10-06T10:00:00.000Z");

describe("backfill plan", () => {
  it("starts right before each report's revision window", () => {
    const state = initialBackfill({
      today: "2026-10-06",
      propertyCreated: null,
      now,
    });
    expect(Object.keys(state.next).sort()).toEqual([...BACKFILL_KEYS].sort());
    expect(state.next.totals).toBe("2026-09-28");
    expect(state.next.attribution).toBe("2026-09-22");
    expect(state.floor.totals).toBe("2025-09-01");
    expect(state.floor.landing_page).toBe("2026-07-03");
  });

  it("never goes before the property existed", () => {
    const state = initialBackfill({
      today: "2026-10-06",
      propertyCreated: "2026-09-01",
      now,
    });
    expect(state.floor.totals).toBe("2026-09-01");
    expect(state.floor.landing_page).toBe("2026-09-01");
  });

  it("brings the recent past of every report first, in report-sized chunks", () => {
    const state = initialBackfill({
      today: "2026-10-06",
      propertyCreated: null,
      now,
    });
    const chunks = nextBackfillChunks(state, 5);
    expect(chunks).toHaveLength(5);
    // En yeni `next` önce: önce 7 günlük pencereli raporlar (09-28).
    expect(chunks.every((chunk) => chunk.end === "2026-09-28")).toBe(true);
    const totals = nextBackfillChunks(state, 20).find(
      (c) => c.key === "totals",
    );
    expect(totals).toEqual({
      key: "totals",
      start: "2026-07-01",
      end: "2026-09-28",
    });
    const landing = nextBackfillChunks(state, 20).find(
      (c) => c.key === "landing_page",
    );
    expect(landing?.start).toBe("2026-08-30");
  });

  it("walks back to the floor and then is done", () => {
    let state = initialBackfill({
      today: "2026-10-06",
      propertyCreated: "2026-09-20",
      now,
    });
    for (let round = 0; round < 10; round += 1) {
      for (const chunk of nextBackfillChunks(state, 20)) {
        expect(chunk.start >= "2026-09-20").toBe(true);
        state = advanceBackfill(state, chunk);
      }
    }
    expect(nextBackfillChunks(state, 20)).toEqual([]);
    expect(backfillComplete(state)).toBe(true);
  });

  it("skips reports dropped from the catalog", () => {
    const state = initialBackfill({
      today: "2026-10-06",
      propertyCreated: null,
      now,
    });
    const skip = new Set(BACKFILL_KEYS.filter((key) => key !== "totals"));
    expect(nextBackfillChunks(state, 20, skip).map((c) => c.key)).toEqual([
      "totals",
    ]);
    expect(backfillComplete(state, new Set(BACKFILL_KEYS))).toBe(true);
  });

  it("reads back only its own saved shape", () => {
    const state = initialBackfill({
      today: "2026-10-06",
      propertyCreated: null,
      now,
    });
    expect(parseBackfillState(JSON.parse(JSON.stringify(state)))).toEqual(
      state,
    );
    expect(parseBackfillState({ v: 2 })).toBeNull();
    expect(parseBackfillState(null)).toBeNull();
  });
});
