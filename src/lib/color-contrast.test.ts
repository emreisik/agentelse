import { describe, expect, it } from "vitest";

import {
  contrastRatio,
  DARK_INK,
  isDarkColor,
  LIGHT_INK,
  readableOn,
  relativeLuminance,
} from "./color-contrast";

describe("color-contrast", () => {
  it("computes WCAG luminance for the extremes", () => {
    expect(relativeLuminance("#000000")).toBe(0);
    expect(relativeLuminance("#ffffff")).toBeCloseTo(1, 5);
    expect(relativeLuminance("#fff")).toBeCloseTo(1, 5);
  });

  it("matches the WCAG contrast ratio reference values", () => {
    expect(contrastRatio("#000000", "#ffffff")).toBeCloseTo(21, 1);
    expect(contrastRatio("#777777", "#ffffff")).toBeCloseTo(4.48, 1);
    expect(contrastRatio("#ffffff", "#ffffff")).toBe(1);
  });

  it("picks readable text for real brand colours", () => {
    expect(readableOn("#0b1f3a")).toBe(LIGHT_INK); // navy
    expect(readableOn("#0f766e")).toBe(LIGHT_INK); // deep teal
    // A mid-tone teal is one of the cases where WCAG says black text wins
    // (5.6:1 vs 3.75:1), even though white "feels" more natural.
    expect(readableOn("#0d9488")).toBe(DARK_INK);
    expect(readableOn("#2dd4bf")).toBe(DARK_INK); // bright teal accent
    expect(readableOn("#fde68a")).toBe(DARK_INK); // pale yellow
    expect(readableOn("#ffffff")).toBe(DARK_INK);
    expect(readableOn("#000000")).toBe(LIGHT_INK);
  });

  it("classifies dark vs light backgrounds", () => {
    expect(isDarkColor("#1f2937")).toBe(true);
    expect(isDarkColor("#f3f4f6")).toBe(false);
  });

  it("never throws on junk and treats it as light", () => {
    expect(relativeLuminance("not-a-colour")).toBe(1);
    expect(readableOn("")).toBe(DARK_INK);
  });

  it("ignores an alpha channel", () => {
    expect(relativeLuminance("#0b1f3a80")).toBeCloseTo(relativeLuminance("#0b1f3a"), 6);
  });
});
