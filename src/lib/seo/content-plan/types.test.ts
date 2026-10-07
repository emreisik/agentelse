import { describe, expect, it } from "vitest";

import { planDataFixture, slotFixture } from "./test-support";
import {
  emptyPlanData,
  isDayKey,
  parseContentPlanData,
  PLAN_MAX_NOTES,
  PLAN_MAX_PILLARS,
  PLAN_MAX_SLOTS,
} from "./types";

const NOW = new Date("2026-10-02T09:00:00.000Z");

describe("emptyPlanData", () => {
  it("starts with no slots and the reason", () => {
    const data = emptyPlanData(NOW, "NO_DATA");
    expect(data).toMatchObject({
      v: 1,
      slots: [],
      nextSlot: 1,
      reason: "NO_DATA",
      checkedAt: NOW.toISOString(),
      regeneratedAt: null,
      wordingNote: null,
    });
  });
});

describe("parseContentPlanData", () => {
  it("round-trips a valid plan", () => {
    const data = planDataFixture();
    expect(parseContentPlanData(JSON.parse(JSON.stringify(data)))).toEqual(data);
  });

  it("turns garbage into an empty plan", () => {
    for (const garbage of [null, undefined, 5, "x", [], {}, { v: 2 }]) {
      const data = parseContentPlanData(garbage, NOW);
      expect(data.slots).toEqual([]);
      expect(data.v).toBe(1);
      expect(data.checkedAt).toBe(NOW.toISOString());
    }
  });

  it("drops only the bad slot", () => {
    const good = slotFixture();
    const parsed = parseContentPlanData({
      ...planDataFixture({ slots: [] }),
      slots: [
        good,
        { ...slotFixture({ id: "s2" }), date: "2026-13-45" },
        { ...slotFixture({ id: "s3" }), kind: "WEIRD" },
        { ...slotFixture({ id: "s4" }), ideaId: "" },
        "junk",
        { ...slotFixture({ id: "s5" }), keyword: "  " },
        slotFixture({ id: "s6", creativeId: "creative-6" }),
      ],
    });
    expect(parsed.slots.map((slot) => slot.id)).toEqual(["s1", "s6"]);
  });

  it("clamps oversized arrays", () => {
    const slots = Array.from({ length: 20 }, (_, index) =>
      slotFixture({ id: `s${index + 1}` }),
    );
    const pillar = planDataFixture().pillars[0]!;
    const parsed = parseContentPlanData({
      ...planDataFixture(),
      slots,
      pillars: Array.from({ length: 20 }, (_, index) => ({ ...pillar, clusterId: `c${index}` })),
      notes: Array.from({ length: 12 }, (_, index) => `Note ${index}`),
      filtered: Array.from({ length: 30 }, () => ({ reason: "BRAND_QUERY", count: 1 })),
    });
    expect(parsed.slots).toHaveLength(PLAN_MAX_SLOTS);
    expect(parsed.pillars).toHaveLength(PLAN_MAX_PILLARS);
    expect(parsed.notes).toHaveLength(PLAN_MAX_NOTES);
    expect(parsed.filtered.length).toBeLessThanOrEqual(8);
  });

  it("never trusts dates and clamps field lengths", () => {
    const parsed = parseContentPlanData({
      ...planDataFixture({ slots: [] }),
      slots: [
        { ...slotFixture(), date: "2026-02-30" },
        { ...slotFixture({ id: "s2" }), date: "2026-10-9" },
        {
          ...slotFixture({ id: "s3" }),
          title: "x".repeat(500),
          share: 7,
          impressions: -4,
          time: "late",
          queries: ["a", "b", "c", "d", "e"],
        },
      ],
    });
    expect(parsed.slots).toHaveLength(1);
    const slot = parsed.slots[0]!;
    expect(Array.from(slot.title).length).toBeLessThanOrEqual(200);
    expect(slot.share).toBe(1);
    expect(slot.impressions).toBe(0);
    expect(slot.time).toBe("10:00");
    expect(slot.queries).toHaveLength(3);
  });

  it("keeps nextSlot above every used id and never shrinks it", () => {
    const low = parseContentPlanData({ ...planDataFixture(), nextSlot: 1 });
    expect(low.nextSlot).toBe(3);
    const high = parseContentPlanData({ ...planDataFixture(), nextSlot: 9 });
    expect(high.nextSlot).toBe(9);
    expect(parseContentPlanData({ ...planDataFixture(), nextSlot: "x" }).nextSlot).toBe(3);
  });

  it("repairs bad link entries, reasons and notes", () => {
    const parsed = parseContentPlanData({
      ...planDataFixture(),
      reason: "WHATEVER",
      wordingNote: "other",
      slots: [
        {
          ...slotFixture(),
          linkFrom: [{ url: "u", path: "/p", anchor: "a".repeat(100), role: "related" }, { url: "u" }, 3],
          prevIdeaStatus: 4,
        },
      ],
    });
    expect(parsed.reason).toBeNull();
    expect(parsed.wordingNote).toBeNull();
    expect(parsed.slots[0]!.linkFrom).toHaveLength(1);
    expect(Array.from(parsed.slots[0]!.linkFrom[0]!.anchor).length).toBe(60);
    expect(parsed.slots[0]!.prevIdeaStatus).toBeNull();
  });

  it("keeps skipped and removed slots with their ids", () => {
    const parsed = parseContentPlanData({
      ...planDataFixture(),
      slots: [slotFixture({ status: "SKIPPED" }), slotFixture({ id: "s2", status: "REMOVED" })],
    });
    expect(parsed.slots.map((slot) => slot.status)).toEqual(["SKIPPED", "REMOVED"]);
    expect(parsed.slots[0]!.ideaId).toBe("idea-1");
  });

  it("drops duplicate slot ids", () => {
    const parsed = parseContentPlanData({
      ...planDataFixture(),
      slots: [slotFixture(), slotFixture({ keyword: "other thing" })],
    });
    expect(parsed.slots).toHaveLength(1);
  });
});

describe("isDayKey", () => {
  it("accepts real days only", () => {
    expect(isDayKey("2026-10-02")).toBe(true);
    expect(isDayKey("2028-02-29")).toBe(true);
    expect(isDayKey("2027-02-29")).toBe(false);
    expect(isDayKey("2026-1-02")).toBe(false);
    expect(isDayKey(20261002)).toBe(false);
  });
});
