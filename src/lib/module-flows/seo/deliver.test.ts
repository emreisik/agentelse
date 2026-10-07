import { describe, expect, it } from "vitest";

import { plannedPublishAt } from "./deliver";

const NOW = new Date("2026-10-05T10:00:00.000Z");

// SC-F7: planlı slot tarihi seçicinin ilk değeri olur; geçmişte kaldıysa olmaz.
describe("plannedPublishAt", () => {
  it("returns the slot's wall clock in the project's timezone", () => {
    expect(
      plannedPublishAt("2026-10-09T07:00:00.000Z", "Europe/Istanbul", NOW),
    ).toBe("2026-10-09T10:00");
  });

  it("is null without a hint, without a timezone, for garbage or a past date", () => {
    expect(plannedPublishAt(undefined, "UTC", NOW)).toBeNull();
    expect(plannedPublishAt("2026-10-09T07:00:00.000Z", undefined, NOW)).toBeNull();
    expect(plannedPublishAt("nope", "UTC", NOW)).toBeNull();
    expect(plannedPublishAt("2026-10-01T07:00:00.000Z", "UTC", NOW)).toBeNull();
  });
});
