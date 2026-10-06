import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("@/lib/prisma", () => ({ prisma: {} }));
vi.mock("./insights", () => ({ upsertDailyRows: vi.fn() }));

import { asyncStateOf, dailyRunCap } from "./async-insights";

describe("async insights (F8)", () => {
  it("caps reports per account and day at min(10, active ads), at least one", () => {
    expect(dailyRunCap(0)).toBe(1);
    expect(dailyRunCap(3)).toBe(3);
    expect(dailyRunCap(40)).toBe(10);
  });

  it("reads its stored state defensively", () => {
    expect(asyncStateOf(null)).toEqual({ day: "", started: 0, runs: [] });
    expect(
      asyncStateOf({
        day: "2026-10-06",
        started: 2,
        runs: [{ id: "r1", level: "ad", since: "2026-10-01", until: "2026-10-01", createdAt: "x" }, { bad: 1 }],
      }),
    ).toEqual({
      day: "2026-10-06",
      started: 2,
      runs: [{ id: "r1", level: "ad", since: "2026-10-01", until: "2026-10-01", createdAt: "x" }],
    });
  });
});
