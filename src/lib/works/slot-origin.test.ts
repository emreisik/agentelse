import { describe, expect, it } from "vitest";

import { isSlotOrigin, slotOriginKey } from "./slot-origin";

describe("slotOriginKey", () => {
  it("joins kind, ref, channel and format", () => {
    expect(
      slotOriginKey({ kind: "idea", ref: "i1" }, "instagram", "instagram.post"),
    ).toBe("idea:i1:instagram:instagram.post");
  });
});

describe("isSlotOrigin", () => {
  it("accepts every known kind", () => {
    for (const kind of ["idea", "master", "brief", "creative"]) {
      expect(isSlotOrigin({ kind, ref: "x" })).toBe(true);
    }
  });
  it("rejects unknown kinds, bad refs and non-objects", () => {
    expect(isSlotOrigin({ kind: "plan", ref: "x" })).toBe(false);
    expect(isSlotOrigin({ kind: "idea", ref: "" })).toBe(false);
    expect(isSlotOrigin({ kind: "idea", ref: "a".repeat(65) })).toBe(false);
    expect(isSlotOrigin({ kind: "idea", ref: "a".repeat(64) })).toBe(true);
    expect(isSlotOrigin({ kind: "idea", ref: 5 })).toBe(false);
    expect(isSlotOrigin({ kind: "idea" })).toBe(false);
    expect(isSlotOrigin(null)).toBe(false);
    expect(isSlotOrigin("idea")).toBe(false);
  });
});
