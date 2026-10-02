import { describe, expect, it } from "vitest";

import { MAX_META_DETAIL_LENGTH, visibleMetaDetail } from "@/lib/meta-error-detail";

// The detail comes from an unsigned URL parameter, so it is shown only for the one
// error the OAuth callback attaches it to, and capped.
describe("visibleMetaDetail", () => {
  it("shows Meta's wording for a failed exchange", () => {
    expect(visibleMetaDetail("exchange_failed", "long-lived token: Invalid client secret")).toBe(
      "long-lived token: Invalid client secret",
    );
  });

  it("shows nothing for any other error, however it was crafted", () => {
    for (const error of ["denied", "state_invalid", "not_configured", "x", "", null]) {
      expect(visibleMetaDetail(error, "Call +90 000 to unlock your account")).toBeNull();
    }
  });

  it("caps the length", () => {
    const shown = visibleMetaDetail("exchange_failed", "a".repeat(5000));
    expect(shown).toHaveLength(MAX_META_DETAIL_LENGTH);
  });

  it("ignores values that are not text, or only whitespace", () => {
    for (const bad of [undefined, null, 5, ["a"], {}, "", "   "]) {
      expect(visibleMetaDetail("exchange_failed", bad)).toBeNull();
    }
  });
});
