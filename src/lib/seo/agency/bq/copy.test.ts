import { describe, expect, it } from "vitest";

import {
  BQ_REMOVE_NOTE,
  BQ_SETUP_STEPS,
  BQ_SOURCE_ERROR_TEXT,
  BQ_VERIFY_STEP_KEYS,
  BQ_VERIFY_STEP_LABEL,
  isBqSourceErrorCode,
} from "./copy";

describe("BigQuery copy", () => {
  it("has fixed text for every source error code", () => {
    for (const [code, text] of Object.entries(BQ_SOURCE_ERROR_TEXT)) {
      expect(text.length, code).toBeGreaterThan(10);
    }
    expect(BQ_SOURCE_ERROR_TEXT.NOT_OWNER).toBe(
      "Only the Search Console property owner can connect a BigQuery export.",
    );
    expect(BQ_SOURCE_ERROR_TEXT.SITE_MISMATCH).toBe(
      "The export tables don't contain this Search Console property.",
    );
    expect(BQ_SOURCE_ERROR_TEXT.PERIOD_TOO_BIG).toContain("Raise the cap");
    expect(BQ_SOURCE_ERROR_TEXT.NO_ACCESS).toContain("BigQuery Data Viewer");
  });

  it("recognises source error codes", () => {
    expect(isBqSourceErrorCode("NOT_OWNER")).toBe(true);
    expect(isBqSourceErrorCode("NO_ACCESS")).toBe(true);
    expect(isBqSourceErrorCode("nope")).toBe(false);
    expect(isBqSourceErrorCode(null)).toBe(false);
  });

  it("explains the setup in four steps", () => {
    expect(BQ_SETUP_STEPS).toHaveLength(4);
    expect(BQ_SETUP_STEPS[1]).toContain("BigQuery Job User");
    expect(BQ_REMOVE_NOTE).toContain("delete stored data");
  });

  it("labels every verification step", () => {
    for (const key of BQ_VERIFY_STEP_KEYS) {
      expect(BQ_VERIFY_STEP_LABEL[key]).toBeTruthy();
    }
    expect(BQ_VERIFY_STEP_KEYS[0]).toBe("ownership");
  });
});
