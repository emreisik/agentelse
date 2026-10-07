import { describe, expect, it } from "vitest";

import {
  defaultExportDataset,
  isValidGaEventName,
  keyEventNamesOf,
  parseBigQueryConfigInput,
} from "./config";

// Bu dosyanın kanıtladığı: veri kümesi yalnız analytics_<mülk kimliği> olabilir
// (bağlama kuralı), tek proje kimliği vardır (ayrı faturalama/veri kümesi projesi
// yok, fazladan alan sonuca giremez), konum doğrulanır, enjeksiyon denemeleri reddedilir.

const PROPERTY = "424242";

function parse(input: Record<string, unknown>) {
  return parseBigQueryConfigInput(
    input as { gcpProjectId: string; datasetId: string; location?: string },
    PROPERTY,
  );
}

describe("defaultExportDataset", () => {
  it("names the GA4 export dataset after the property id", () => {
    expect(defaultExportDataset(PROPERTY)).toBe("analytics_424242");
  });
});

describe("parseBigQueryConfigInput", () => {
  it("accepts the bound dataset and trims fields", () => {
    expect(
      parse({
        gcpProjectId: " my-company-123456 ",
        datasetId: " analytics_424242 ",
        location: " EU ",
      }),
    ).toEqual({
      ok: true,
      value: {
        gcpProjectId: "my-company-123456",
        datasetId: "analytics_424242",
        location: "EU",
      },
    });
  });

  it("uses a null location when none is given", () => {
    const result = parse({
      gcpProjectId: "my-company-123456",
      datasetId: "analytics_424242",
    });
    expect(result).toMatchObject({ ok: true, value: { location: null } });
  });

  it.each([
    "analytics_999999",
    "analytics_4242421",
    "analytics_",
    "events",
    "",
    "analytics_424242; DROP TABLE x",
    "analytics_424242 ",
  ])("refuses the dataset %j with the fixed binding message", (datasetId) => {
    const result = parse({ gcpProjectId: "my-company-123456", datasetId });
    if (datasetId === "analytics_424242 ") {
      // Boşluklar kırpılır: bu değer geçerlidir.
      expect(result.ok).toBe(true);
      return;
    }
    expect(result).toEqual({
      ok: false,
      message: "The export dataset of this property is analytics_424242.",
    });
  });

  it.each([
    "",
    "ab",
    "My-Project-123",
    "1project-123456",
    "project-123456-",
    "proj`ect-123456",
    "project 123456",
    "project-123456.dataset",
    "a".repeat(31),
  ])("refuses the project id %j", (gcpProjectId) => {
    const result = parse({ gcpProjectId, datasetId: "analytics_424242" });
    expect(result.ok).toBe(false);
  });

  it("validates the location", () => {
    for (const location of ["US", "europe-west1", "eu"]) {
      expect(
        parse({
          gcpProjectId: "my-company-123456",
          datasetId: "analytics_424242",
          location,
        }).ok,
      ).toBe(true);
    }
    for (const location of ["a", "US;", "eu west", "x".repeat(31)]) {
      expect(
        parse({
          gcpProjectId: "my-company-123456",
          datasetId: "analytics_424242",
          location,
        }).ok,
      ).toBe(false);
    }
  });

  it("refuses a property id that is not numeric", () => {
    expect(
      parseBigQueryConfigInput(
        { gcpProjectId: "my-company-123456", datasetId: "analytics_x" },
        "x",
      ).ok,
    ).toBe(false);
  });

  it("has no billing or dataset project split: extra fields never reach the result", () => {
    const result = parse({
      gcpProjectId: "my-company-123456",
      datasetId: "analytics_424242",
      billingProjectId: "victim-project-999999",
      datasetProjectId: "victim-project-999999",
      projectId: "victim-project-999999",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(Object.keys(result.value).sort()).toEqual([
      "datasetId",
      "gcpProjectId",
      "location",
    ]);
    expect(JSON.stringify(result.value)).not.toContain("victim");
  });
});

describe("keyEventNamesOf", () => {
  it("reads valid event names and drops the rest", () => {
    expect(
      keyEventNamesOf([
        { eventName: "purchase", countingMethod: "ONCE_PER_EVENT" },
        { eventName: "purchase" },
        { eventName: "a,b" },
        { eventName: "1bad" },
        { eventName: "sign_up" },
        { eventName: 4 },
        null,
        "x",
      ]),
    ).toEqual(["purchase", "sign_up"]);
    expect(keyEventNamesOf(null)).toEqual([]);
    expect(keyEventNamesOf({})).toEqual([]);
  });

  it("validates single event names", () => {
    expect(isValidGaEventName("generate_lead")).toBe(true);
    expect(isValidGaEventName("a b")).toBe(false);
  });
});
