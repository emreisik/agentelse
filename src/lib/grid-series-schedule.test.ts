import { describe, expect, it } from "vitest";

import { computeGridSeriesSchedule } from "@/lib/grid-series-schedule";

describe("computeGridSeriesSchedule", () => {
  it("publishes the HIGHEST gridPosition first, so the grid reassembles correctly", () => {
    // Instagram shows newest-first, left-to-right/top-to-bottom. For a
    // 3-tile row (positions 1=left, 2=middle, 3=right) to read correctly,
    // position 3 must go out first (oldest -> ends up rightmost once
    // newer posts land on top of it), position 1 last (newest -> ends up
    // leftmost).
    const start = new Date("2026-10-01T09:00:00.000Z");
    const plan = computeGridSeriesSchedule(
      [
        { id: "left", gridPosition: 1 },
        { id: "middle", gridPosition: 2 },
        { id: "right", gridPosition: 3 },
      ],
      start,
      30,
    );

    expect(plan.map((p) => p.id)).toEqual(["right", "middle", "left"]);
    expect(plan.find((p) => p.id === "right")!.scheduledFor).toEqual(start);
    expect(plan.find((p) => p.id === "middle")!.scheduledFor).toEqual(
      new Date("2026-10-01T09:30:00.000Z"),
    );
    expect(plan.find((p) => p.id === "left")!.scheduledFor).toEqual(
      new Date("2026-10-01T10:00:00.000Z"),
    );
  });

  it("handles a 3x3 group (9 tiles) in strict descending position order", () => {
    const start = new Date("2026-10-01T09:00:00.000Z");
    const tiles = Array.from({ length: 9 }, (_, i) => ({
      id: `t${i + 1}`,
      gridPosition: i + 1,
    }));

    const plan = computeGridSeriesSchedule(tiles, start, 15);

    expect(plan.map((p) => p.id)).toEqual([
      "t9",
      "t8",
      "t7",
      "t6",
      "t5",
      "t4",
      "t3",
      "t2",
      "t1",
    ]);
    // Strictly increasing timestamps, 15 minutes apart.
    for (let i = 1; i < plan.length; i++) {
      expect(
        plan[i]!.scheduledFor.getTime() - plan[i - 1]!.scheduledFor.getTime(),
      ).toBe(15 * 60_000);
    }
  });

  it("treats a null gridPosition as 0 (publishes last, alongside/after real positions)", () => {
    const start = new Date("2026-10-01T09:00:00.000Z");
    const plan = computeGridSeriesSchedule(
      [
        { id: "a", gridPosition: 2 },
        { id: "b", gridPosition: null },
      ],
      start,
      10,
    );

    expect(plan.map((p) => p.id)).toEqual(["a", "b"]);
  });
});
