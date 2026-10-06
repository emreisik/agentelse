import { describe, expect, it } from "vitest";

import {
  AUTO_RUN_NEXT_KINDS,
  NEXT_STEP_KINDS,
  addDaysKey,
  nextStepHref,
  planIdOfStep,
  publishesItself,
  selectProductionBatch,
  type JourneyItem,
  type NextStep,
  type NextStepAction,
} from "./journey";

const step = (action: NextStepAction): NextStep => ({
  key: "k",
  tone: "next",
  label: "L",
  title: "T",
  action,
});

const item = (id: string, planId: string, date: string): JourneyItem => ({
  id,
  planId,
  stage: "IN_REVIEW",
  publish: "manual",
  date,
  title: id,
});

// A link that opens the chat to run a step must open the chat that holds the
// plan: the bare project URL starts a new chat, whose own journey is empty.
describe("planIdOfStep", () => {
  const items = [
    item("c1", "planA", "2026-10-05"),
    item("c2", "planB", "2026-10-20"),
    item("c3", "planB", "2026-10-22"),
  ];

  it("is the plan the step names", () => {
    expect(
      planIdOfStep(
        step({ kind: "produce_plan", planId: "planA", count: 2 }),
        items,
      ),
    ).toBe("planA");
    expect(
      planIdOfStep(
        step({
          kind: "approve_plan",
          planIds: ["planB", "planA"],
          creativeIds: ["c2"],
          count: 1,
        }),
        items,
      ),
    ).toBe("planB");
  });

  it("is the plan of the pieces the step names", () => {
    expect(
      planIdOfStep(
        step({ kind: "publish_manual", creativeIds: ["c1"] }),
        items,
      ),
    ).toBe("planA");
  });

  it("else the plan that ends last (the newest), for steps about the plan as a whole", () => {
    for (const action of [
      { kind: "plan_next", afterDate: "2026-10-22" },
      { kind: "show_results", count: 1 },
      { kind: "enable_scheduled_publish", count: 2 },
    ] as const) {
      expect(planIdOfStep(step(action), items)).toBe("planB");
    }
  });

  it("falls back to the first plan when no piece has a day, and to nothing without plans", () => {
    const undated = [item("c1", "planA", ""), item("c2", "planB", "")];
    expect(
      planIdOfStep(step({ kind: "show_results", count: 1 }), undated),
    ).toBe("planA");
    expect(
      planIdOfStep(step({ kind: "show_results", count: 1 }), []),
    ).toBeUndefined();
    // Named pieces that are not in the snapshot fall through to the newest.
    expect(
      planIdOfStep(
        step({ kind: "publish_manual", creativeIds: ["zzz"] }),
        items,
      ),
    ).toBe("planB");
  });
});

describe("addDaysKey", () => {
  it("crosses month and year ends", () => {
    expect(addDaysKey("2026-10-31", 1)).toBe("2026-11-01");
    expect(addDaysKey("2026-12-31", 1)).toBe("2027-01-01");
    expect(addDaysKey("2026-03-01", -1)).toBe("2026-02-28");
  });
});

describe("publishesItself", () => {
  const item = {
    publish: "auto" as const,
    channel: "instagram" as const,
    platform: "INSTAGRAM",
  };

  it("only a connected Instagram piece in an auto format publishes itself", () => {
    expect(publishesItself(item, { instagram: { connected: true } })).toBe(
      true,
    );
    expect(publishesItself(item, { instagram: { connected: false } })).toBe(
      false,
    );
    expect(publishesItself(item, {})).toBe(false);
    expect(
      publishesItself(
        { ...item, publish: "manual" },
        { instagram: { connected: true } },
      ),
    ).toBe(false);
  });

  it("LinkedIn and X are the client's to post whatever the catalog says", () => {
    expect(
      publishesItself(
        { publish: "auto", channel: "linkedin", platform: "LINKEDIN" },
        { linkedin: { connected: true } },
      ),
    ).toBe(false);
  });
});

describe("nextStepHref", () => {
  it("sends review to the piece and connect to the integrations page", () => {
    expect(
      nextStepHref(
        "p1",
        step({ kind: "review_queue", creativeId: "c9", count: 2 }),
      ),
    ).toBe("/projects/p1/takvim?creative=c9");
    expect(
      nextStepHref(
        "p1",
        step({ kind: "connect_channel", channel: "instagram" }),
      ),
    ).toBe("/projects/p1/integrations");
  });

  it("sends website and search fixes to their own screens", () => {
    expect(nextStepHref("p1", step({ kind: "connect_analytics" }))).toBe(
      "/projects/p1/integrations?integration=google_analytics",
    );
    expect(
      nextStepHref(
        "p1",
        step({
          kind: "fix_tracking",
          checkKey: "MH1",
          href: "/projects/p1/site#measurement-health",
        }),
      ),
    ).toBe("/projects/p1/site#measurement-health");
    expect(
      nextStepHref(
        "p1",
        step({ kind: "fix_search_issue", alertId: "a 1", count: 2 }),
      ),
    ).toBe("/projects/p1/arama?issue=a%201#health");
  });

  it("sends everything the chat runs to the chat, which runs it once on landing", () => {
    expect(
      nextStepHref("p1", step({ kind: "produce_plan", planId: "x", count: 3 })),
    ).toBe("/projects/p1?next=produce_plan");
    expect(
      nextStepHref("p1", step({ kind: "plan_next", afterDate: "2026-10-12" })),
    ).toBe("/projects/p1?next=plan_next");
    expect(nextStepHref("p1", step({ kind: "show_results", count: 1 }))).toBe(
      "/projects/p1?next=show_results",
    );
  });

  it("every step kind the chat lands on is one the chat knows", () => {
    const kinds: NextStepAction["kind"][] = [
      "produce_plan",
      "review_queue",
      "approve_plan",
      "connect_channel",
      "enable_scheduled_publish",
      "publish_manual",
      "plan_next",
      "plan_from_ideas",
      "open_weekly_draft",
      "show_results",
      "connect_analytics",
      "fix_tracking",
    ];
    expect([...NEXT_STEP_KINDS].sort()).toEqual([...kinds].sort());
    // SC-F3: arama sorunu adımı bir bağlantıdır, sohbet onu çalıştırmaz.
    expect(NEXT_STEP_KINDS).not.toContain("fix_search_issue");
    expect(NEXT_STEP_KINDS).toContain("approve_plan");
  });

  it("a link never auto-runs approve_plan (an approval needs a tap on the bar)", () => {
    expect(AUTO_RUN_NEXT_KINDS).not.toContain("approve_plan");
    expect(AUTO_RUN_NEXT_KINDS).toContain("produce_plan");
    expect(AUTO_RUN_NEXT_KINDS).toContain("plan_next");
    expect(AUTO_RUN_NEXT_KINDS.length).toBe(NEXT_STEP_KINDS.length - 1);
  });

  it("a Work-owned step carries the Work id to the chat and to the integrations page", () => {
    expect(
      nextStepHref(
        "p1",
        step({ kind: "produce_plan", planId: "x", count: 3 }),
        { workId: "w 1" },
      ),
    ).toBe("/projects/p1?work=w%201&next=produce_plan");
    expect(
      nextStepHref(
        "p1",
        step({ kind: "connect_channel", channel: "instagram" }),
        { workId: "w1" },
      ),
    ).toBe("/projects/p1/integrations?integration=instagram&from=w1");
    expect(
      nextStepHref(
        "p1",
        step({ kind: "review_queue", creativeId: "c9", count: 2 }),
        { workId: "w1" },
      ),
    ).toBe("/projects/p1/takvim?creative=c9");
  });

  it("approve_plan lands in the chat through the default branch", () => {
    expect(
      nextStepHref(
        "p1",
        step({
          kind: "approve_plan",
          planIds: ["x"],
          creativeIds: ["a", "b"],
          count: 2,
        }),
      ),
    ).toBe("/projects/p1?next=approve_plan");
  });
});

describe("selectProductionBatch", () => {
  it("is what plan-progress re-exports, so the card and the server agree", async () => {
    const { selectProductionBatch: fromServer } =
      await import("@/server/agency/journey/plan-progress");
    expect(fromServer).toBe(selectProductionBatch);
  });
});
