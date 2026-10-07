import { describe, expect, it } from "vitest";

import { isTrackedLinkCode, newTrackedLinkCode, TRACKED_LINK_CODE_LENGTH } from "./codes";

describe("tracked link codes", () => {
  it("makes 6 characters from [a-z0-9]", () => {
    for (let i = 0; i < 50; i += 1) {
      const code = newTrackedLinkCode();
      expect(code).toHaveLength(TRACKED_LINK_CODE_LENGTH);
      expect(code).toMatch(/^[a-z0-9]{6}$/);
    }
  });

  it("is deterministic with an injected random and covers both ends of the alphabet", () => {
    expect(newTrackedLinkCode(() => 0)).toBe("aaaaaa");
    expect(newTrackedLinkCode(() => 0.999999)).toBe("999999");
    const values = [0, 0.03, 0.06, 0.5, 0.75, 0.97];
    let at = 0;
    const first = newTrackedLinkCode(() => values[at++ % values.length] ?? 0);
    at = 0;
    expect(newTrackedLinkCode(() => values[at++ % values.length] ?? 0)).toBe(first);
  });

  it("validates codes", () => {
    expect(isTrackedLinkCode("ab12cd")).toBe(true);
    expect(isTrackedLinkCode("AB12CD")).toBe(false);
    expect(isTrackedLinkCode("ab12c")).toBe(false);
    expect(isTrackedLinkCode(123456)).toBe(false);
  });
});
