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

  it("shows at most three steps that are waiting, most urgent first", () => {
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
    // Three waiting steps, then the quiet one (not counted against the cap).
    expect(steps.filter((s) => !s.quiet).map((s) => s.key)).toEqual([
      "produce-retry",
      "publish-manual",
      "review",
    ]);
    expect(steps.filter((s) => s.quiet).map((s) => s.key)).toEqual([
      "connect-instagram",
    ]);
  });

  it("a channel that is not connected is quiet: it never takes a slot from work that is waiting", () => {
    const steps = computeNextSteps(
      snap(
        [
          item("FAILED", "2026-10-01"),
          item("IN_REVIEW", "2026-10-02"),
          item("PLANNED", "2026-10-09"),
          item("PUBLISHED", "2026-10-30"),
        ],
        { connections: { instagram: { connected: false } } },
      ),
    );
    const connect = steps.find((s) => s.key === "connect-instagram");
    expect(connect?.quiet).toBe(true);
    // Last, after everything that is waiting.
    expect(steps.at(-1)?.key).toBe("connect-instagram");
    // Nothing else is quiet.
    expect(steps.filter((s) => s.quiet)).toHaveLength(1);
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

// W57: the Work-scoped rules (approve_plan, visible connect) only exist when
// the snapshot says workScoped.
describe("computeNextSteps, Work-scoped snapshot", () => {
  const review = (planId = "plan-1") =>
    item("IN_REVIEW", "2026-10-02", { planId });
  const scoped = (items: JourneyItem[], over: Partial<JourneySnapshot> = {}) =>
    snap(items, { workScoped: true, ...over });

  it("adds approve before review when two or more pieces are in review", () => {
    const pieces = [review(), review(), item("PLANNED", "2026-10-10")];
    const steps = computeNextSteps(scoped(pieces));
    expect(steps.map((s) => s.key)).toEqual(["approve", "review", "produce"]);
    expect(steps[0]).toMatchObject({
      tone: "next",
      label: "Approve 2",
      title: "2 pieces are ready. Approve them in one go.",
      action: {
        kind: "approve_plan",
        planIds: ["plan-1"],
        creativeIds: [pieces[0]!.id, pieces[1]!.id],
        count: 2,
      },
    });
    expect(steps[1]).toMatchObject({
      action: { kind: "review_queue", count: 2 },
    });
  });

  it("is never emitted without workScoped, and the list stays as it was", () => {
    const pieces = [review(), review(), item("PLANNED", "2026-10-10")];
    expect(keys(snap(pieces))).toEqual(["review", "produce"]);
    expect(keys(snap(pieces, { workScoped: false }))).toEqual([
      "review",
      "produce",
    ]);
  });

  it("needs at least two pieces in review", () => {
    const one = keys(scoped([review()]));
    expect(one).toContain("review");
    expect(one).not.toContain("approve");
    expect(keys(scoped([item("PLANNED", "2026-10-02")]))).not.toContain(
      "approve",
    );
  });

  it("names distinct plan ids, at most 12, and exactly the in-review pieces of those plans", () => {
    const pieces = Array.from({ length: 14 }, (_, i) =>
      review(`plan-${i}`),
    );
    // A second piece of the first plan, one of a plan beyond the cap, and
    // pieces in other stages that must never be listed.
    const second = review("plan-0");
    const beyond = review("plan-13");
    const other = item("APPROVED", "2026-10-02", { planId: "plan-0" });
    const all = [...pieces, second, beyond, other];
    const step = computeNextSteps(scoped(all)).find((s) => s.key === "approve");
    const action = step?.action;
    if (action?.kind !== "approve_plan") throw new Error("no approve step");
    expect(action.planIds).toEqual(
      Array.from({ length: 12 }, (_, i) => `plan-${i}`),
    );
    expect(new Set(action.planIds).size).toBe(12);
    expect(action.creativeIds).toEqual(
      all
        .filter(
          (p) => p.stage === "IN_REVIEW" && action.planIds.includes(p.planId),
        )
        .map((p) => p.id),
    );
    expect(action.creativeIds).not.toContain(other.id);
    expect(action.creativeIds).not.toContain(beyond.id);
    expect(action.count).toBe(action.creativeIds.length);
    expect(action.count).toBe(13);
  });

  it("covers at most 100 pieces and counts what it covers", () => {
    const pieces = Array.from({ length: 120 }, () => review());
    const action = computeNextSteps(scoped(pieces)).find(
      (s) => s.key === "approve",
    )?.action;
    if (action?.kind !== "approve_plan") throw new Error("no approve step");
    expect(action.creativeIds).toHaveLength(100);
    expect(action.count).toBe(100);
    expect(action.creativeIds).toEqual(pieces.slice(0, 100).map((p) => p.id));
  });

  it("the connect step is visible only when workScoped", () => {
    const pieces = [item("PLANNED", "2026-10-03")];
    const connections = { instagram: { connected: false } };
    const plain = computeNextSteps(snap(pieces, { connections })).find(
      (s) => s.key === "connect-instagram",
    );
    expect(plain?.quiet).toBe(true);
    const work = computeNextSteps(scoped(pieces, { connections }));
    const connect = work.find((s) => s.key === "connect-instagram");
    expect(connect?.quiet).toBe(false);
    expect(work.filter((s) => s.quiet)).toHaveLength(0);
  });
});
