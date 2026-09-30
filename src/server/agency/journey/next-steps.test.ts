import { describe, expect, it } from "vitest";

import type {
  JourneyItem,
  JourneySnapshot,
  PlanItemStage,
} from "@/lib/journey";

import { computeNextSteps } from "./next-steps";

const TODAY = "2026-10-01";

let seq = 0;
const item = (
  stage: PlanItemStage,
  date: string,
  over: Partial<JourneyItem> = {},
): JourneyItem => ({
  id: `c${++seq}`,
  planId: "plan-1",
  stage,
  channel: "instagram",
  publish: "auto",
  date,
  title: "T",
  platform: "INSTAGRAM",
  ...over,
});

const snap = (
  items: JourneyItem[],
  over: Partial<JourneySnapshot> = {},
): JourneySnapshot => ({
  today: TODAY,
  items,
  connections: { instagram: { connected: true } },
  publishScheduleEnabled: true,
  results: [],
  ...over,
});

const keys = (snapshot: JourneySnapshot) =>
  computeNextSteps(snapshot).map((step) => step.key);

describe("computeNextSteps", () => {
  it("has nothing to say before there is a plan", () => {
    expect(computeNextSteps(snap([]))).toEqual([]);
  });

  it("a freshly saved plan: produce the nearest week first", () => {
    const steps = computeNextSteps(
      snap([
        item("PLANNED", "2026-10-01"),
        item("PLANNED", "2026-10-03"),
        item("PLANNED", "2026-10-20"),
      ]),
    );
    expect(steps[0]).toMatchObject({
      key: "produce",
      tone: "next",
      label: "Produce 2",
      action: { kind: "produce_plan", planId: "plan-1", count: 2 },
    });
  });

  it("content waiting for a decision comes before producing more", () => {
    const pieces = [
      item("IN_REVIEW", "2026-10-01"),
      item("IN_REVIEW", "2026-10-02"),
      item("PLANNED", "2026-10-10"),
    ];
    const steps = computeNextSteps(snap(pieces));
    expect(steps.map((s) => s.key)).toEqual(["review", "produce"]);
    expect(steps[0]).toMatchObject({
      label: "Review 2",
      action: { kind: "review_queue", creativeId: pieces[0]!.id, count: 2 },
    });
  });

  it("a failed piece is a blocker and offers a retry, not a second produce step", () => {
    const steps = computeNextSteps(
      snap([
        item("FAILED", "2026-10-01"),
        item("PLANNED", "2026-10-02"),
        item("IN_REVIEW", "2026-10-03"),
        // A far last day keeps "plan the next weeks" out of this case.
        item("PUBLISHED", "2026-10-30"),
      ]),
    );
    expect(steps.map((s) => s.key)).toEqual(["produce-retry", "review"]);
    expect(steps[0]).toMatchObject({ tone: "blocker", label: "Try again" });
  });

  it("a manual piece due today is urgent and comes first", () => {
    const due = item("APPROVED", TODAY, {
      channel: "seo",
      publish: "manual",
      platform: undefined,
    });
    const steps = computeNextSteps(
      snap([due, item("IN_REVIEW", "2026-10-02")], { connections: {} }),
    );
    expect(steps[0]).toMatchObject({
      key: "publish-manual",
      tone: "blocker",
      action: { kind: "publish_manual", creativeIds: [due.id] },
    });
  });

  it("an Instagram piece on a disconnected account is the client's to post", () => {
    const due = item("APPROVED", TODAY);
    const steps = computeNextSteps(
      snap([due], { connections: { instagram: { connected: false } } }),
    );
    expect(steps[0]).toMatchObject({
      key: "publish-manual",
      action: { kind: "publish_manual", creativeIds: [due.id] },
    });
  });

  it("a manual piece whose day has not come is not nagged yet", () => {
    expect(
      keys(
        snap(
          [
            item("APPROVED", "2026-10-09", {
              channel: "seo",
              publish: "manual",
              platform: undefined,
            }),
          ],
          { connections: {} },
        ),
      ),
    ).not.toContain("publish-manual");
  });

  it("ads wait for their own approval and never show up as 'you post it'", () => {
    expect(
      keys(
        snap([
          item("APPROVED", TODAY, {
            channel: "ads",
            publish: "approval",
            platform: undefined,
          }),
        ]),
      ),
    ).not.toContain("publish-manual");
  });

  it("approved future Instagram posts with no schedule need it turned on", () => {
    const steps = computeNextSteps(
      snap([item("APPROVED", "2026-10-05"), item("APPROVED", "2026-10-06")], {
        publishScheduleEnabled: false,
      }),
    );
    expect(
      steps.find((s) => s.key === "enable-scheduled-publish"),
    ).toMatchObject({ action: { kind: "enable_scheduled_publish", count: 2 } });
  });

  it("does not ask for a schedule that already exists", () => {
    expect(
      keys(
        snap([item("APPROVED", "2026-10-05")], {
          publishScheduleEnabled: true,
        }),
      ),
    ).not.toContain("enable-scheduled-publish");
  });

  it("does not ask for a schedule when the account is not connected", () => {
    const steps = keys(
      snap([item("APPROVED", "2026-10-05")], {
        publishScheduleEnabled: false,
        connections: { instagram: { connected: false } },
      }),
    );
    expect(steps).not.toContain("enable-scheduled-publish");
    expect(steps).toContain("connect-instagram");
  });

  it("a missing connection is a step but never blocks producing", () => {
    const steps = computeNextSteps(
      snap([item("PLANNED", "2026-10-02"), item("PUBLISHED", "2026-10-30")], {
        connections: { instagram: { connected: false } },
      }),
    );
    expect(steps.map((s) => s.key)).toEqual(["produce", "connect-instagram"]);
    expect(steps[1]).toMatchObject({
      label: "Connect Instagram",
      action: { kind: "connect_channel", channel: "instagram" },
    });
  });

  it("channels with nothing to connect never produce a connect step", () => {
    expect(
      keys(
        snap(
          [
            item("PLANNED", "2026-10-02", {
              channel: "seo",
              publish: "manual",
              platform: undefined,
            }),
          ],
          { connections: {} },
        ),
      ),
    ).not.toContain("connect-seo");
  });

  it("a plan that is about to end suggests the next stretch", () => {
    const steps = computeNextSteps(snap([item("PUBLISHED", "2026-10-03")]));
    expect(steps).toEqual([
      expect.objectContaining({
        key: "plan-next",
        title: "Your plan runs until 2026-10-03.",
        action: { kind: "plan_next", afterDate: "2026-10-03" },
      }),
    ]);
  });

  it("an ended plan says so", () => {
    const [step] = computeNextSteps(snap([item("PUBLISHED", "2026-09-25")]));
    expect(step).toMatchObject({
      key: "plan-next",
      title: "Your plan has ended.",
    });
  });

  it("a plan with plenty of runway is left alone", () => {
    expect(keys(snap([item("PUBLISHED", "2026-10-20")]))).toEqual([]);
  });

  it("shows at most three steps, most urgent first", () => {
    const steps = computeNextSteps(
      snap(
        [
          item("FAILED", "2026-10-01"),
          item("APPROVED", TODAY, {
            channel: "seo",
            publish: "manual",
            platform: undefined,
          }),
          item("IN_REVIEW", "2026-10-02"),
          item("APPROVED", "2026-10-03"),
        ],
        {
          publishScheduleEnabled: false,
          connections: { instagram: { connected: false } },
        },
      ),
    );
    expect(steps).toHaveLength(3);
    expect(steps.map((s) => s.key)).toEqual([
      "produce-retry",
      "publish-manual",
      "review",
    ]);
  });

  it("offers the results last, and only when there are real ones", () => {
    const result = {
      creativeId: "c1",
      title: "T",
      where: "Instagram · Post",
      check: "24h",
      observation: "Reach 1.2k",
      checkedAt: "2026-10-02T10:00:00.000Z",
    };
    const steps = computeNextSteps(
      snap([item("IN_REVIEW", "2026-10-03"), item("PUBLISHED", "2026-10-30")], {
        results: [result, result],
      }),
    );
    expect(steps.map((s) => s.key)).toEqual(["review", "results"]);
    expect(steps[1]).toMatchObject({
      label: "See results (2)",
      action: { kind: "show_results", count: 2 },
    });
    expect(keys(snap([item("PUBLISHED", "2026-10-30")]))).not.toContain(
      "results",
    );
  });

  it("results never push out something that is actually waiting", () => {
    const result = {
      creativeId: "c1",
      title: "T",
      where: "x",
      check: "c",
      observation: "o",
      checkedAt: "2026-10-02T10:00:00.000Z",
    };
    const steps = computeNextSteps(
      snap(
        [
          item("FAILED", "2026-10-01"),
          item("IN_REVIEW", "2026-10-02"),
          item("PLANNED", "2026-10-03"),
        ],
        { results: [result] },
      ),
    );
    // Three steps at most, and the results are the first to go.
    expect(steps).toHaveLength(3);
    expect(steps.map((s) => s.key).slice(0, 2)).toEqual(["produce-retry", "review"]);
    expect(steps.map((s) => s.key)).not.toContain("results");
  });
});
