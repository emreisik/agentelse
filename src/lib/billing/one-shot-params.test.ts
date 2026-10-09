import { describe, expect, it } from "vitest";

import { withoutOneShotParams } from "./one-shot-params";

describe("withoutOneShotParams", () => {
  it("drops the one-time notice and Checkout return parameters and keeps the rest", () => {
    expect(
      withoutOneShotParams(
        "https://app.test/billing?tab=subscription&checkout=success&session_id=cs_test_abc12345#top",
      ),
    ).toBe("/billing?tab=subscription#top");
    expect(
      withoutOneShotParams("/billing?tab=subscription&notice=canceled"),
    ).toBe("/billing?tab=subscription");
    expect(withoutOneShotParams("/billing?purchase=success&tab=usage")).toBe(
      "/billing?tab=usage",
    );
  });

  it("leaves a clean address alone", () => {
    expect(withoutOneShotParams("/billing?tab=plans")).toBeNull();
    expect(withoutOneShotParams("/billing")).toBeNull();
  });
});
