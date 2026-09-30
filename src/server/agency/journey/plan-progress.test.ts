import { describe, expect, it } from "vitest";

import {
  deriveItemStage,
  selectProductionBatch,
  toJourneyItem,
  type PlanCreativeRow,
  type PlanTaskRow,
} from "./plan-progress";

const at = (iso: string) => new Date(iso);

const row = (over: Partial<PlanCreativeRow> = {}): PlanCreativeRow => ({
  id: "c1",
  planId: "plan-1",
  status: "DRAFT",
  currentVersionId: null,
  scheduledFor: at("2026-10-05T07:00:00Z"),
  channel: "instagram",
  formatKey: "instagram.post",
  title: "Topic",
  platform: "INSTAGRAM",
  ...over,
});

const task = (over: Partial<PlanTaskRow> = {}): PlanTaskRow => ({
  creativeId: "c1",
  status: "RUNNING",
  updatedAt: at("2026-10-01T10:00:00Z"),
  ...over,
});

describe("deriveItemStage", () => {
  it("a draft slot with no content and no job is planned", () => {
    expect(deriveItemStage(row(), [])).toBe("PLANNED");
  });

  it("a draft slot with a running job is being produced", () => {
    expect(deriveItemStage(row(), [task()])).toBe("PRODUCING");
    // Waiting on an approval or a provider is still in flight.
    expect(deriveItemStage(row(), [task({ status: "WAITING_APPROVAL" })])).toBe(
      "PRODUCING",
    );
  });

  it("a slot whose last job failed and nothing else runs is failed", () => {
    expect(deriveItemStage(row(), [task({ status: "FAILED" })])).toBe("FAILED");
  });

  it("a retry in flight wins over the failure before it", () => {
    expect(
      deriveItemStage(row(), [
        task({ status: "FAILED", updatedAt: at("2026-10-01T09:00:00Z") }),
        task({ status: "RUNNING", updatedAt: at("2026-10-01T10:00:00Z") }),
      ]),
    ).toBe("PRODUCING");
  });

  it("a newer success does not leave an older failure showing", () => {
    expect(
      deriveItemStage(row(), [
        task({ status: "FAILED", updatedAt: at("2026-10-01T09:00:00Z") }),
        task({ status: "CANCELLED", updatedAt: at("2026-10-01T10:00:00Z") }),
      ]),
    ).toBe("PLANNED");
  });

  it("content that exists is in review whatever a leftover job says", () => {
    expect(
      deriveItemStage(row({ currentVersionId: "v1" }), [
        task({ status: "FAILED" }),
      ]),
    ).toBe("IN_REVIEW");
  });

  it("maps the decided and final statuses straight through", () => {
    expect(deriveItemStage(row({ status: "IN_REVIEW" }), [])).toBe("IN_REVIEW");
    expect(deriveItemStage(row({ status: "APPROVED" }), [])).toBe("APPROVED");
    expect(deriveItemStage(row({ status: "REJECTED" }), [])).toBe("REJECTED");
    expect(deriveItemStage(row({ status: "PUBLISHED" }), [])).toBe("PUBLISHED");
  });

  it("an archived slot is out of the journey", () => {
    expect(deriveItemStage(row({ status: "ARCHIVED" }), [])).toBeNull();
  });
});

describe("toJourneyItem", () => {
  it("reads the catalog publish mode and the day in the project timezone", () => {
    const item = toJourneyItem(
      row({ scheduledFor: at("2026-10-05T22:30:00Z") }),
      [],
      "Europe/Istanbul",
    );
    // 22:30 UTC is already the 6th in Istanbul (UTC+3).
    expect(item).toMatchObject({
      id: "c1",
      planId: "plan-1",
      stage: "PLANNED",
      channel: "instagram",
      publish: "auto",
      date: "2026-10-06",
      platform: "INSTAGRAM",
    });
  });

  it("only looks at its own jobs", () => {
    const item = toJourneyItem(row(), [task({ creativeId: "other" })], "UTC");
    expect(item?.stage).toBe("PLANNED");
  });

  it("an unknown format or channel falls back to a manual hand-off", () => {
    const item = toJourneyItem(
      row({ channel: "facebook", formatKey: "facebook.post" }),
      [],
      "UTC",
    );
    expect(item?.publish).toBe("manual");
    expect(item?.channel).toBeUndefined();
  });

  it("an unscheduled slot has no date", () => {
    expect(toJourneyItem(row({ scheduledFor: null }), [], "UTC")?.date).toBe(
      "",
    );
  });
});

describe("selectProductionBatch", () => {
  const slot = (
    id: string,
    date: string,
    stage = "PLANNED",
    planId = "p1",
  ) => ({
    id,
    planId,
    date,
    stage: stage as "PLANNED",
  });

  it("takes the producible slots of the nearest seven days", () => {
    const items = [
      slot("a", "2026-10-01"),
      slot("b", "2026-10-03"),
      slot("c", "2026-10-07"),
      slot("d", "2026-10-08"),
      slot("e", "2026-10-14"),
    ];
    // Window: Oct 1 .. Oct 7.
    expect(selectProductionBatch(items)).toEqual(["a", "b", "c"]);
  });

  it("caps one click at the batch limit", () => {
    const items = Array.from({ length: 10 }, (_, i) =>
      slot(`s${i}`, "2026-10-01"),
    );
    expect(selectProductionBatch(items)).toHaveLength(7);
    expect(selectProductionBatch(items, undefined, 3)).toHaveLength(3);
  });

  it("includes failed slots and skips everything that has content", () => {
    const items = [
      slot("a", "2026-10-01", "FAILED"),
      slot("b", "2026-10-01", "IN_REVIEW"),
      slot("c", "2026-10-01", "PRODUCING"),
      slot("d", "2026-10-01", "APPROVED"),
    ];
    expect(selectProductionBatch(items)).toEqual(["a"]);
  });

  it("never mixes two plans and stays on the earliest one", () => {
    const items = [
      slot("late", "2026-10-09", "PLANNED", "p2"),
      slot("early", "2026-10-02", "PLANNED", "p1"),
      slot("same-plan", "2026-10-04", "PLANNED", "p1"),
    ];
    expect(selectProductionBatch(items)).toEqual(["early", "same-plan"]);
  });

  it("honours a named plan", () => {
    const items = [
      slot("x", "2026-10-02", "PLANNED", "p1"),
      slot("y", "2026-10-09", "PLANNED", "p2"),
    ];
    expect(selectProductionBatch(items, "p2")).toEqual(["y"]);
  });

  it("returns nothing when nothing needs content", () => {
    expect(
      selectProductionBatch([slot("a", "2026-10-01", "APPROVED")]),
    ).toEqual([]);
    expect(selectProductionBatch([])).toEqual([]);
  });
});
