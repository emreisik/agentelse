import { describe, expect, it } from "vitest";

import { mergeSuspectDays, parseSuspectDays, suspectDaysIn } from "./suspect";
import type { GaCheckResult } from "./types";

// Şüpheli günler: yalnız [today-7, today-1] yeniden kurulur, eski günler
// donar, 400 günden eskisi düşer; MH1 yalnız FAIL'de, MH6 WARN'da da
// işaretler.

const today = "2026-10-06";

function result(
  key: GaCheckResult["key"],
  status: GaCheckResult["status"],
  days: string[],
): GaCheckResult {
  return { key, status, severity: "WARN", evidence: { reason: "x" }, days };
}

describe("suspect days", () => {
  it("rebuilds only the last seven days", () => {
    const existing = {
      "2026-09-28": ["MH1"], // pencere dışında: donmuş
      "2026-09-29": ["MH20"], // pencere başı: yeniden kurulur
      "2026-10-04": ["MH1"], // pencere içinde, artık işaretlenmiyor
    };
    const merged = mergeSuspectDays(
      existing,
      [
        result("MH1", "FAIL", ["2026-10-05", "2026-09-20", "2026-10-06"]),
        result("MH6", "WARN", ["2026-10-05", "2026-09-30"]),
      ],
      { today },
    );
    expect(merged).toEqual({
      "2026-09-28": ["MH1"],
      "2026-09-30": ["MH6"],
      "2026-10-05": ["MH1", "MH6"],
    });
    expect(Object.keys(merged)).toEqual([...Object.keys(merged)].sort());
  });

  it("keeps frozen older days untouched", () => {
    const existing = { "2026-03-01": ["MH20", "MH4"] };
    expect(mergeSuspectDays(existing, [], { today })).toEqual(existing);
  });

  it("drops days older than 400 days", () => {
    const merged = mergeSuspectDays(
      { "2025-09-01": ["MH1"], "2025-09-02": ["MH4"] },
      [],
      { today },
    );
    // today-400 = 2025-09-01; daha eskisi yok, sınır gün kalır.
    expect(merged["2025-09-01"]).toEqual(["MH1"]);
    expect(mergeSuspectDays({ "2025-08-31": ["MH1"] }, [], { today })).toEqual(
      {},
    );
  });

  it("MH1 WARN does not mark, MH6 WARN does", () => {
    const merged = mergeSuspectDays(
      {},
      [
        result("MH1", "WARN", ["2026-10-04"]),
        result("MH6", "WARN", ["2026-10-03"]),
        result("MH7", "FAIL", ["2026-10-02"]),
        result("MH20", "PASS", ["2026-10-01"]),
      ],
      { today },
    );
    expect(merged).toEqual({ "2026-10-03": ["MH6"] });
  });

  it("parses stored values tolerantly and lists days in a range", () => {
    const parsed = parseSuspectDays({
      "2026-10-01": ["MH6", "MH1", "MH1", "bad", 4],
      "2026-10-02": [],
      today: ["MH1"],
      "2026-10-03": "MH1",
    });
    expect(parsed).toEqual({ "2026-10-01": ["MH1", "MH6"] });
    expect(parseSuspectDays(null)).toEqual({});
    expect(parseSuspectDays([1])).toEqual({});
    expect(
      suspectDaysIn(
        {
          "2026-10-03": ["MH1"],
          "2026-10-01": ["MH4"],
          "2026-09-01": ["MH1"],
          "2026-10-02": [],
        },
        "2026-10-01",
        "2026-10-05",
      ),
    ).toEqual(["2026-10-01", "2026-10-03"]);
  });
});
