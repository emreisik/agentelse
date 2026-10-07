import { describe, expect, it } from "vitest";

import { parseBrandingSnapshot, validateBrandingInput } from "./branding";

const VALID = {
  displayName: "Acme Agency",
  accent: "blue",
  footer: "Prepared by Acme.",
  logoAssetId: "cmasset123",
};

describe("validateBrandingInput", () => {
  it("accepts a valid input and normalizes empties to null", () => {
    expect(validateBrandingInput(VALID)).toEqual({
      ok: true,
      value: {
        displayName: "Acme Agency",
        accent: "blue",
        footer: "Prepared by Acme.",
        logoAssetId: "cmasset123",
      },
    });
    const bare = validateBrandingInput({ ...VALID, footer: "  ", logoAssetId: "" });
    expect(bare).toEqual({
      ok: true,
      value: {
        displayName: "Acme Agency",
        accent: "blue",
        footer: null,
        logoAssetId: null,
      },
    });
  });

  it("trims the name and enforces 1..60 characters", () => {
    const trimmed = validateBrandingInput({ ...VALID, displayName: "  Acme  " });
    expect(trimmed.ok && trimmed.value.displayName).toBe("Acme");
    expect(validateBrandingInput({ ...VALID, displayName: "   " }).ok).toBe(false);
    expect(validateBrandingInput({ ...VALID, displayName: "a".repeat(60) }).ok).toBe(true);
    expect(validateBrandingInput({ ...VALID, displayName: "a".repeat(61) }).ok).toBe(false);
  });

  it("enforces the footer bound", () => {
    expect(validateBrandingInput({ ...VALID, footer: "f".repeat(160) }).ok).toBe(true);
    expect(validateBrandingInput({ ...VALID, footer: "f".repeat(161) }).ok).toBe(false);
  });

  it("rejects control characters in name and footer", () => {
    expect(validateBrandingInput({ ...VALID, displayName: "Ac\u0000me" }).ok).toBe(false);
    expect(validateBrandingInput({ ...VALID, displayName: "Ac\nme" }).ok).toBe(false);
    expect(validateBrandingInput({ ...VALID, displayName: "Ac\u2028me" }).ok).toBe(false);
    expect(validateBrandingInput({ ...VALID, footer: "a\tb" }).ok).toBe(false);
    expect(validateBrandingInput({ ...VALID, footer: "a\u007fb" }).ok).toBe(false);
  });

  it("only accepts whitelisted accents", () => {
    for (const accent of ["slate", "blue", "green", "violet", "orange", "rose"]) {
      expect(validateBrandingInput({ ...VALID, accent }).ok).toBe(true);
    }
    expect(validateBrandingInput({ ...VALID, accent: "#ff0000" }).ok).toBe(false);
    expect(validateBrandingInput({ ...VALID, accent: "red" }).ok).toBe(false);
    expect(validateBrandingInput({ ...VALID, accent: "" }).ok).toBe(false);
  });

  it("rejects a logo id that is not a plain id", () => {
    expect(validateBrandingInput({ ...VALID, logoAssetId: "../etc/passwd" }).ok).toBe(false);
    expect(validateBrandingInput({ ...VALID, logoAssetId: "a b" }).ok).toBe(false);
    expect(validateBrandingInput({ ...VALID, logoAssetId: "x".repeat(65) }).ok).toBe(false);
  });
});

describe("parseBrandingSnapshot", () => {
  it("reads a stored snapshot", () => {
    expect(parseBrandingSnapshot(VALID, "Fallback")).toEqual({
      displayName: "Acme Agency",
      accent: "blue",
      footer: "Prepared by Acme.",
      logoAssetId: "cmasset123",
    });
  });

  it("falls back for missing or malformed fields", () => {
    expect(parseBrandingSnapshot(null, "Workspace Inc")).toEqual({
      displayName: "Workspace Inc",
      accent: "slate",
      footer: null,
      logoAssetId: null,
    });
    expect(
      parseBrandingSnapshot(
        { displayName: 42, accent: "pink", footer: "x\ny", logoAssetId: "../x" },
        "WS",
      ),
    ).toEqual({ displayName: "WS", accent: "slate", footer: null, logoAssetId: null });
    expect(parseBrandingSnapshot([], "")).toEqual({
      displayName: "Report",
      accent: "slate",
      footer: null,
      logoAssetId: null,
    });
  });

  it("drops an over-long stored name", () => {
    const parsed = parseBrandingSnapshot({ displayName: "a".repeat(80) }, "WS");
    expect(parsed.displayName).toBe("WS");
  });
});
