import { describe, expect, it } from "vitest";

import {
  INTELLIGENCE_SECTIONS,
  intelligenceIsEmpty,
  intelligenceTotal,
  sectionOfEntity,
  sectionOpenedFirst,
  type IntelligenceCounts,
} from "./intelligence-state";

const counts = (over: Partial<IntelligenceCounts> = {}): IntelligenceCounts => ({
  findings: 0,
  insights: 0,
  opportunities: 0,
  signals: 0,
  ...over,
});

describe("intelligence tab state", () => {
  it("is empty only when every section is", () => {
    expect(intelligenceIsEmpty(counts())).toBe(true);
    for (const key of INTELLIGENCE_SECTIONS) {
      expect(intelligenceIsEmpty(counts({ [key]: 1 }))).toBe(false);
    }
    expect(intelligenceTotal(counts({ findings: 2, signals: 3 }))).toBe(5);
  });

  it("opens the first section that has anything, in the order it is derived", () => {
    expect(sectionOpenedFirst(counts())).toBeNull();
    expect(sectionOpenedFirst(counts({ signals: 9 }))).toBe("signals");
    expect(sectionOpenedFirst(counts({ signals: 9, insights: 1 }))).toBe("insights");
    expect(sectionOpenedFirst(counts({ signals: 9, findings: 1, opportunities: 4 }))).toBe(
      "findings",
    );
  });

  it("knows which section owns a record, and nothing else", () => {
    expect(sectionOfEntity("finding")).toBe("findings");
    expect(sectionOfEntity("insight")).toBe("insights");
    expect(sectionOfEntity("opportunity")).toBe("opportunities");
    expect(sectionOfEntity("signal")).toBe("signals");
    for (const other of ["goal", "idea", "task", "constitution", "department"] as const) {
      expect(sectionOfEntity(other)).toBeNull();
    }
  });
});
