import { describe, expect, it } from "vitest";

import {
  dimensionOf,
  mergeQuality,
  metricOf,
  parseGaReport,
  qualityNotes,
} from "./response";

describe("parseGaReport", () => {
  const report = parseGaReport({
    dimensionHeaders: [{ name: "date" }, { name: "landingPage" }],
    metricHeaders: [{ name: "sessions" }, { name: "keyEvents" }],
    rows: [
      {
        dimensionValues: [{ value: "20261005" }, { value: "/" }],
        metricValues: [{ value: "120" }, { value: "3.5" }],
      },
      {
        dimensionValues: [{ value: "20261005" }, { value: "/pricing" }],
        metricValues: [{ value: "not a number" }],
      },
    ],
    rowCount: 9,
    metadata: {
      subjectToThresholding: true,
      dataLossFromOtherRow: true,
      samplingMetadatas: [{ samplesReadCount: "1" }],
      dataTruncationReasons: ["DATA_RETENTION"],
      currencyCode: "EUR",
      timeZone: "Europe/Berlin",
    },
    propertyQuota: {
      tokensPerDay: { consumed: 12, remaining: 199_988 },
      tokensPerHour: { consumed: 12 },
    },
  });

  it("reads rows, headers and the total row count", () => {
    expect(report.rows[0]).toEqual({
      dimensions: ["20261005", "/"],
      metrics: [120, 3.5],
    });
    expect(report.rows[1]?.metrics).toEqual([0]);
    expect(report.rowCount).toBe(9);
    expect(metricOf(report, report.rows[0]!, "keyEvents")).toBe(3.5);
    expect(metricOf(report, report.rows[0]!, "missing")).toBe(0);
    expect(dimensionOf(report, report.rows[0]!, "landingPage")).toBe("/");
  });

  it("keeps the quality flags and the property quota", () => {
    expect(report.quality).toEqual({
      thresholded: true,
      otherRow: true,
      sampled: true,
      truncationReasons: ["DATA_RETENTION"],
      currencyCode: "EUR",
      timeZone: "Europe/Berlin",
    });
    expect(report.propertyQuota).toEqual({
      tokensPerDay: { consumed: 12, remaining: 199_988 },
      tokensPerHour: { consumed: 12, remaining: 0 },
    });
  });

  it("survives an empty response", () => {
    const empty = parseGaReport(null);
    expect(empty.rows).toEqual([]);
    expect(empty.rowCount).toBe(0);
    expect(empty.propertyQuota).toBeNull();
  });
});

describe("quality notes", () => {
  it("says in plain words what Google did to the data", () => {
    expect(qualityNotes({ thresholded: true, otherRow: true })).toEqual([
      "Google hid some small values to protect privacy.",
      "Some rows are grouped as (other) by Google.",
    ]);
    expect(qualityNotes({})).toEqual([]);
  });

  it("merges flags from many slices", () => {
    expect(
      mergeQuality([
        { thresholded: true },
        { truncated: true, truncationReasons: ["A"] },
        { truncationReasons: ["A", "B"] },
      ]),
    ).toEqual({
      thresholded: true,
      truncated: true,
      truncationReasons: ["A", "B"],
    });
  });
});
