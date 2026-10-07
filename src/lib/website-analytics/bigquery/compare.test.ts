import { describe, expect, it } from "vitest";

import { compareExportToApi, type ExportDayCounts } from "./compare";

function days(count: number, make: (index: number) => Omit<ExportDayCounts, "day">) {
  return Array.from({ length: count }, (_, index) => ({
    day: `2026-09-${String(index + 1).padStart(2, "0")}`,
    ...make(index),
  }));
}

describe("compareExportToApi", () => {
  it("is unknown with fewer than 7 shared days", () => {
    const rows = days(6, () => ({ sessions: 100, users: 80 }));
    expect(compareExportToApi({ exported: rows, api: rows })).toEqual({
      level: "unknown",
      days: 6,
      sessionsDiffPct: null,
      usersDiffPct: null,
    });
  });

  it("counts only days present on both sides", () => {
    const exported = days(10, () => ({ sessions: 100, users: 80 }));
    const api = days(5, () => ({ sessions: 100, users: 80 }));
    expect(compareExportToApi({ exported, api }).level).toBe("unknown");
    expect(compareExportToApi({ exported, api }).days).toBe(5);
  });

  it("is close when both are within 10%", () => {
    const api = days(28, () => ({ sessions: 100, users: 80 }));
    const exported = days(28, () => ({ sessions: 105, users: 76 }));
    expect(compareExportToApi({ exported, api })).toEqual({
      level: "close",
      days: 28,
      sessionsDiffPct: 5,
      usersDiffPct: 5,
    });
  });

  it("is close when the numbers are identical", () => {
    const rows = days(7, () => ({ sessions: 50, users: 40 }));
    expect(compareExportToApi({ exported: rows, api: rows })).toMatchObject({
      level: "close",
      sessionsDiffPct: 0,
      usersDiffPct: 0,
    });
  });

  it("differs when either metric is off by more than 10%", () => {
    const api = days(14, () => ({ sessions: 100, users: 80 }));
    const sessionsOff = days(14, () => ({ sessions: 125, users: 80 }));
    const usersOff = days(14, () => ({ sessions: 100, users: 60 }));
    expect(compareExportToApi({ exported: sessionsOff, api }).level).toBe("differs");
    expect(compareExportToApi({ exported: usersOff, api }).level).toBe("differs");
    expect(compareExportToApi({ exported: sessionsOff, api }).sessionsDiffPct).toBe(25);
  });

  it("treats exactly 10% as close and just over as differs", () => {
    const api = days(7, () => ({ sessions: 100, users: 100 }));
    expect(
      compareExportToApi({ exported: days(7, () => ({ sessions: 110, users: 100 })), api })
        .level,
    ).toBe("close");
    expect(
      compareExportToApi({ exported: days(7, () => ({ sessions: 111, users: 100 })), api })
        .level,
    ).toBe("differs");
  });

  it("handles zero API totals", () => {
    const zero = days(7, () => ({ sessions: 0, users: 0 }));
    expect(compareExportToApi({ exported: zero, api: zero }).level).toBe("close");
    const some = days(7, () => ({ sessions: 5, users: 5 }));
    expect(compareExportToApi({ exported: some, api: zero }).level).toBe("differs");
  });

  it("ignores repeated days in the export list", () => {
    const api = days(7, () => ({ sessions: 10, users: 10 }));
    const exported = [...api, ...api];
    expect(compareExportToApi({ exported, api }).days).toBe(7);
  });
});
