import { describe, expect, it } from "vitest";

import { isLowData, readSeoReportSnapshot, reportNotes } from "./snapshot";
import { sampleSnapshot } from "./test-support";
import { SEO_REPORT_KINDS, type SeoReportSnapshot } from "./types";

// Saklanan Json gibi: serileştirilip geri okunur.
function stored(snapshot: SeoReportSnapshot): Record<string, unknown> {
  return JSON.parse(JSON.stringify(snapshot)) as Record<string, unknown>;
}

describe("readSeoReportSnapshot", () => {
  it.each(SEO_REPORT_KINDS)("round-trips the %s sample", (kind) => {
    const snapshot = sampleSnapshot(kind);
    expect(readSeoReportSnapshot(stored(snapshot))).toEqual(snapshot);
  });

  it("has every section type valid for the kind in the sample", () => {
    const types = (kind: (typeof SEO_REPORT_KINDS)[number]) =>
      sampleSnapshot(kind).sections.map((section) => section.type);
    expect(types("WEEKLY")).toEqual(
      expect.arrayContaining([
        "kpis",
        "diagnosis",
        "table",
        "health",
        "opportunities",
        "actions",
        "updates",
      ]),
    );
    expect(types("MONTHLY")).toEqual(
      expect.arrayContaining(["goals", "forecast", "content"]),
    );
    expect(types("ROADMAP")).toEqual(
      expect.arrayContaining(["roadmap", "content", "goals", "forecast"]),
    );
    expect(types("PULSE")).toEqual(expect.arrayContaining(["pulse", "health"]));
  });

  it("drops an invalid section and keeps the rest", () => {
    const raw = stored(sampleSnapshot("WEEKLY"));
    const sections = raw.sections as unknown[];
    const before = sections.length;
    sections[0] = { type: "kpis", kpis: "nope" };
    sections.push({ type: "mystery" }, "junk");
    const read = readSeoReportSnapshot(raw);
    expect(read).not.toBeNull();
    expect(read!.sections.length).toBe(before - 1);
    expect(read!.sections.map((section) => section.type)).not.toContain("kpis");
    expect(read!.sections.map((section) => section.type)).toContain("health");
  });

  it("drops invalid rows and caps the lists", () => {
    const snapshot = sampleSnapshot("WEEKLY");
    const raw = stored(snapshot);
    const sections = raw.sections as { type: string; table?: { rows: unknown[] } }[];
    const table = sections.find((section) => section.type === "table")!;
    const row = table.table!.rows[0] as Record<string, unknown>;
    table.table!.rows = [
      { label: 3 },
      ...Array.from({ length: 9 }, (_, index) => ({
        ...row,
        label: `query ${index}`,
      })),
    ];
    const read = readSeoReportSnapshot(raw)!;
    const readTable = read.sections.find((section) => section.type === "table");
    expect(readTable?.type === "table" && readTable.table.rows).toHaveLength(5);
  });

  it("returns null for an unknown version or kind", () => {
    const raw = stored(sampleSnapshot("WEEKLY"));
    expect(readSeoReportSnapshot({ ...raw, v: 2 })).toBeNull();
    expect(readSeoReportSnapshot({ ...raw, kind: "DAILY" })).toBeNull();
  });

  it("returns null for a broken header or a non-object", () => {
    const raw = stored(sampleSnapshot("WEEKLY"));
    expect(readSeoReportSnapshot({ ...raw, period: null })).toBeNull();
    expect(readSeoReportSnapshot({ ...raw, periodKey: 4 })).toBeNull();
    expect(readSeoReportSnapshot(null)).toBeNull();
    expect(readSeoReportSnapshot("snapshot")).toBeNull();
    expect(readSeoReportSnapshot([])).toBeNull();
  });

  it("reads a roadmap item without findingId as null", () => {
    const raw = stored(sampleSnapshot("ROADMAP"));
    const sections = raw.sections as {
      type: string;
      actions?: Record<string, unknown>[];
    }[];
    const roadmap = sections.find((section) => section.type === "roadmap")!;
    for (const item of roadmap.actions!) delete item.findingId;
    const read = readSeoReportSnapshot(raw)!;
    const section = read.sections.find((entry) => entry.type === "roadmap");
    expect(section?.type === "roadmap" && section.actions.map((a) => a.findingId))
      .toEqual([null, null]);
  });

  it("defaults diagnosis metrics and actions evaluated for older reports", () => {
    const raw = stored(sampleSnapshot("WEEKLY"));
    const sections = raw.sections as {
      type: string;
      actions?: Record<string, unknown>;
      diagnosis?: { steps: Record<string, unknown>[] };
    }[];
    delete sections.find((section) => section.type === "actions")!.actions!
      .evaluated;
    for (const step of sections.find((section) => section.type === "diagnosis")!
      .diagnosis!.steps) {
      delete step.metrics;
    }
    const read = readSeoReportSnapshot(raw)!;
    const actions = read.sections.find((section) => section.type === "actions");
    const diagnosis = read.sections.find(
      (section) => section.type === "diagnosis",
    );
    expect(actions?.type === "actions" && actions.actions.evaluated).toBe(0);
    expect(
      diagnosis?.type === "diagnosis" &&
        diagnosis.diagnosis.steps.every(
          (step) => Object.keys(step.metrics).length === 0,
        ),
    ).toBe(true);
  });
});

describe("reportNotes", () => {
  const base = {
    finalThrough: "2026-10-05",
    anonymousShare: null,
    brandSplit: true,
    truncated: false,
    lowData: false,
    isMock: false,
  };

  it("always names Pacific Time and the position caveat", () => {
    const notes = reportNotes(base);
    expect(notes[0]).toBe(
      "Search Console days (Pacific Time). Final data through Oct 5.",
    );
    expect(notes.at(-1)).toBe(
      "Position is Google's average top position, not a rank.",
    );
    expect(notes).toHaveLength(2);
  });

  it("mentions the anonymous share only from one percent", () => {
    expect(reportNotes({ ...base, anonymousShare: 0.009 })).toHaveLength(2);
    const notes = reportNotes({ ...base, anonymousShare: 0.124 });
    expect(notes[1]).toBe("12% of clicks come from searches Google doesn't show.");
    expect(reportNotes({ ...base, anonymousShare: 0.01 })[1]).toBe(
      "1% of clicks come from searches Google doesn't show.",
    );
  });

  it("adds the other notes in contract order", () => {
    const notes = reportNotes({
      ...base,
      anonymousShare: 0.2,
      brandSplit: false,
      truncated: true,
      lowData: true,
      isMock: true,
    });
    expect(notes).toEqual([
      "Search Console days (Pacific Time). Final data through Oct 5.",
      "20% of clicks come from searches Google doesn't show.",
      "Brand and non-brand split isn't ready yet, so totals are shown.",
      "Google returned only the top rows for part of this period.",
      "Low search data: indexing, technical health and new content matter most right now.",
      "Sample data.",
      "Position is Google's average top position, not a rank.",
    ]);
  });
});

describe("isLowData", () => {
  it("uses the weekly and monthly thresholds", () => {
    expect(isLowData("WEEKLY", 249)).toBe(true);
    expect(isLowData("WEEKLY", 250)).toBe(false);
    expect(isLowData("MONTHLY", 999)).toBe(true);
    expect(isLowData("MONTHLY", 1000)).toBe(false);
    expect(isLowData("PULSE", 0)).toBe(false);
    expect(isLowData("ROADMAP", 0)).toBe(false);
  });
});
