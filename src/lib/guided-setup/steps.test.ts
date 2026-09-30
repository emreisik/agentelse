import { describe, expect, it } from "vitest";

import {
  EMPTY_IDEA_OPTIONS,
  MAIN_QUESTIONS,
  type Answers,
  type IdeaOptions,
  type StepId,
} from "./contract";
import {
  allMainSkipped,
  bumpReached,
  businessMode,
  catchUpQuestions,
  checkpointSuggestions,
  detailSteps,
  firstStepOf,
  mainOrder,
  nextStep,
  prevStep,
  progressOf,
  resumeStep,
  stepsFor,
  type FlowCtx,
  type Lists,
  type Reached,
  type ResumeCtx,
} from "./steps";

const opt = (id: string, label: string) => ({ id, label, ai: true as const });
const ideasWith = (o: Partial<IdeaOptions>) => ({
  options: { ...EMPTY_IDEA_OPTIONS, ...o },
});
const READY = ideasWith({
  business: [opt("o_aaaaaaaaaa", "A QR menu for cafes")],
  audience: [opt("o_bbbbbbbbbb", "Cafe owners")],
  angle: [opt("o_cccccccccc", "Fast setup")],
});
const NONE = ideasWith({});

const picked = (id: string) => ({ picked: [id] });
const skipped = { picked: [], skipped: true as const };
const deferred = { picked: [], deferred: true as const };

const FULL: Answers = {
  goal: picked("goal.sales"),
  channels: picked("channel.instagram"),
  business: picked("kind.food"),
  audience: picked("audience.local"),
  tone: picked("tone.friendly"),
};
const ALL_SKIPPED: Answers = {
  goal: skipped,
  channels: skipped,
  business: skipped,
  audience: skipped,
  tone: skipped,
};

const ctx = (over: Partial<FlowCtx> = {}): FlowCtx => ({
  seedFirst: false,
  staticFirst: false,
  more: false,
  ...over,
});

describe("guided-setup steps: order (G80)", () => {
  it("default order", () => {
    expect(mainOrder({ seedFirst: false, staticFirst: false })).toEqual([
      "goal",
      "channels",
      "business",
      "audience",
      "tone",
    ]);
  });
  it("staticFirst moves the research-fed questions last", () => {
    expect(mainOrder({ seedFirst: false, staticFirst: true })).toEqual([
      "goal",
      "channels",
      "tone",
      "business",
      "audience",
    ]);
  });
  it("seedFirst puts business first, in both orders", () => {
    expect(mainOrder({ seedFirst: true, staticFirst: false })).toEqual([
      "business",
      "goal",
      "channels",
      "audience",
      "tone",
    ]);
    expect(mainOrder({ seedFirst: true, staticFirst: true })).toEqual([
      "business",
      "goal",
      "channels",
      "tone",
      "audience",
    ]);
  });
  it("every order holds the same five questions and starts at firstStepOf", () => {
    for (const seedFirst of [false, true]) {
      for (const staticFirst of [false, true]) {
        const order = mainOrder({ seedFirst, staticFirst });
        expect([...order].sort()).toEqual([...MAIN_QUESTIONS].sort());
        expect(order[0]).toBe(firstStepOf(seedFirst));
      }
    }
    expect(firstStepOf(true)).toBe("business");
    expect(firstStepOf(false)).toBe("goal");
  });
  it("the order never depends on answers or ideas", () => {
    const a = stepsFor({
      seedFirst: false,
      staticFirst: true,
      more: false,
      hasAngleOptions: false,
    });
    const b = nextStep(
      "goal",
      ctx({ staticFirst: true, answers: FULL, ideas: READY }),
    );
    expect(a[0]).toBe("goal");
    expect(b).toBe("channels");
  });
});

describe("guided-setup steps: the step list", () => {
  const base = { seedFirst: false, staticFirst: false };
  it("the checkpoint follows the last main question, review is last", () => {
    const list = stepsFor({ ...base, more: false, hasAngleOptions: true });
    expect(list).toEqual([
      "goal",
      "channels",
      "business",
      "audience",
      "tone",
      "checkpoint",
      "review",
    ]);
  });
  it("detail steps appear only after more = true", () => {
    expect(
      stepsFor({ ...base, more: false, hasAngleOptions: true }),
    ).not.toContain("guardrails");
    expect(stepsFor({ ...base, more: true, hasAngleOptions: true })).toEqual([
      "goal",
      "channels",
      "business",
      "audience",
      "tone",
      "checkpoint",
      "angle",
      "guardrails",
      "review",
    ]);
  });
  it("angle is absent without options", () => {
    expect(detailSteps(false)).toEqual(["guardrails"]);
    expect(detailSteps(true)).toEqual(["angle", "guardrails"]);
    expect(
      stepsFor({ ...base, more: true, hasAngleOptions: false }),
    ).not.toContain("angle");
  });
  it("nextStep only offers angle when the ideas hold options for it", () => {
    expect(nextStep("checkpoint", ctx({ more: true, ideas: READY }))).toBe(
      "angle",
    );
    expect(nextStep("checkpoint", ctx({ more: true, ideas: NONE }))).toBe(
      "guardrails",
    );
    expect(nextStep("checkpoint", ctx({ more: false, ideas: READY }))).toBe(
      "review",
    );
  });
});

describe("guided-setup steps: Back/Next", () => {
  it("Next then Back returns to the same step across every main order", () => {
    for (const seedFirst of [false, true]) {
      for (const staticFirst of [false, true]) {
        const c = ctx({ seedFirst, staticFirst, answers: FULL, ideas: NONE });
        const order = mainOrder({ seedFirst, staticFirst });
        for (const step of order.slice(0, -1)) {
          const next = nextStep(step, c);
          expect(next).not.toBeNull();
          expect(prevStep(next as StepId, c)).toBe(step);
        }
      }
    }
  });
  it("Back from the checkpoint is the last main question; from the first step is null", () => {
    const c = ctx({ answers: FULL });
    expect(prevStep("checkpoint", c)).toBe("tone");
    expect(nextStep("tone", c)).toBe("checkpoint");
    expect(prevStep("goal", c)).toBeNull();
    expect(prevStep("business", ctx({ seedFirst: true }))).toBeNull();
  });
  it("detail steps walk angle -> guardrails -> review and back", () => {
    const c = ctx({ more: true, answers: FULL, ideas: READY });
    expect(nextStep("angle", c)).toBe("guardrails");
    expect(nextStep("guardrails", c)).toBe("review");
    expect(prevStep("guardrails", c)).toBe("angle");
    expect(prevStep("angle", c)).toBe("checkpoint");
    expect(nextStep("review", c)).toBeNull();
  });
  it("Back from review returns to the step the person came from", () => {
    const c = ctx({ answers: FULL, cameFrom: "audience" });
    expect(prevStep("review", c)).toBe("audience");
    expect(prevStep("review", ctx({ answers: FULL }))).toBe("checkpoint");
    expect(
      prevStep("review", ctx({ more: true, ideas: NONE, answers: FULL })),
    ).toBe("guardrails");
  });
  it("all five skipped: tone goes straight to review and Back from review is the last question", () => {
    const c = ctx({ answers: ALL_SKIPPED });
    expect(allMainSkipped(ALL_SKIPPED)).toBe(true);
    expect(nextStep("tone", c)).toBe("review");
    expect(prevStep("review", c)).toBe("tone");
  });
  it("one answer among the skips keeps the checkpoint", () => {
    const answers: Answers = { ...ALL_SKIPPED, goal: picked("goal.sales") };
    expect(allMainSkipped(answers)).toBe(false);
    expect(nextStep("tone", ctx({ answers }))).toBe("checkpoint");
  });
  it("a step outside the current list has no next", () => {
    expect(nextStep("guardrails", ctx({ more: false }))).toBeNull();
  });
});

describe("guided-setup steps: catch-up", () => {
  const lists: Lists = { business: "static", audience: "static" };
  it("a deferred question whose ideas landed is offered", () => {
    expect(
      catchUpQuestions({ ...FULL, business: deferred }, READY, lists),
    ).toEqual(["business"]);
  });
  it("nothing is offered while the ideas have not landed", () => {
    expect(
      catchUpQuestions({ ...FULL, business: deferred }, NONE, lists),
    ).toEqual([]);
    expect(
      catchUpQuestions({ ...FULL, business: deferred }, null, lists),
    ).toEqual([]);
  });
  it("a question whose list was already the ideas list is not offered again", () => {
    expect(
      catchUpQuestions({ ...FULL, business: deferred }, READY, {
        business: "ideas",
      }),
    ).toEqual([]);
  });
  it("skipped, answered and unanswered questions are not offered", () => {
    expect(
      catchUpQuestions({ ...FULL, business: skipped }, READY, lists),
    ).toEqual([]);
    expect(catchUpQuestions(FULL, READY, lists)).toEqual([]);
    expect(catchUpQuestions({}, READY, lists)).toEqual([]);
  });
  it("the offer sits between the last main question and the checkpoint, once", () => {
    // staticFirst: audience is last; business was deferred earlier.
    const answers: Answers = {
      ...FULL,
      business: deferred,
    };
    const c = ctx({ staticFirst: true, answers, ideas: READY, lists });
    expect(nextStep("audience", c)).toBe("business");
    // the person skips it again: it becomes `skipped`, nothing is offered twice
    const after = ctx({
      staticFirst: true,
      answers: { ...answers, business: skipped },
      ideas: READY,
      lists,
    });
    expect(nextStep("audience", after)).toBe("checkpoint");
  });
  it("a catch-up visit continues to the next candidate, then the checkpoint", () => {
    const answers: Answers = {
      ...FULL,
      business: deferred,
      audience: deferred,
    };
    const c = ctx({ answers, ideas: READY, lists });
    // default order: business, audience, tone. tone is last, both are offered.
    expect(nextStep("tone", c)).toBe("business");
    expect(nextStep("business", c)).toBe("audience");
    expect(nextStep("audience", c)).toBe("checkpoint");
  });
  it("a deferred question in the middle of the flow does not jump ahead", () => {
    const answers: Answers = { goal: picked("goal.sales"), business: deferred };
    const c = ctx({ answers, ideas: READY, lists });
    expect(nextStep("business", c)).toBe("audience");
  });
  it("a landed deferral does not skip the checkpoint when everything else is skipped", () => {
    const answers: Answers = { ...ALL_SKIPPED, business: deferred };
    const c = ctx({ answers, ideas: READY, lists });
    expect(nextStep("tone", c)).toBe("business");
    expect(nextStep("business", c)).toBe("review");
  });
});

describe("guided-setup steps: checkpointSuggestions (G80)", () => {
  it("lists research-fed questions answered from a static list while ideas are ready", () => {
    expect(
      checkpointSuggestions(FULL, READY, {
        business: "static",
        audience: "static",
      }),
    ).toEqual(["business", "audience"]);
  });
  it("is empty while the list is not frozen yet", () => {
    expect(checkpointSuggestions(FULL, READY, {})).toEqual([]);
    expect(checkpointSuggestions(FULL, READY, undefined)).toEqual([]);
  });
  it("is empty when the list was already the ideas list", () => {
    expect(
      checkpointSuggestions(FULL, READY, {
        business: "ideas",
        audience: "ideas",
      }),
    ).toEqual([]);
  });
  it("is empty while no ideas exist for the question", () => {
    expect(
      checkpointSuggestions(
        FULL,
        ideasWith({ business: READY.options.business }),
        {
          business: "static",
          audience: "static",
        },
      ),
    ).toEqual(["business"]);
    expect(checkpointSuggestions(FULL, NONE, { business: "static" })).toEqual(
      [],
    );
  });
  it("ignores skipped questions and the questions that have no ideas", () => {
    expect(
      checkpointSuggestions({ ...FULL, business: skipped }, READY, {
        business: "static",
        audience: "static",
        tone: "static",
        goal: "static",
      }),
    ).toEqual(["audience"]);
  });
});

describe("guided-setup steps: businessMode (G81)", () => {
  it("confirm only when the list is frozen to ideas and exactly one sentence exists", () => {
    expect(businessMode({ lists: { business: "ideas" }, ideas: READY })).toBe(
      "confirm",
    );
    expect(businessMode({ lists: { business: "static" }, ideas: READY })).toBe(
      "list",
    );
    expect(businessMode({ lists: {}, ideas: READY })).toBe("list");
    expect(businessMode({ lists: { business: "ideas" }, ideas: NONE })).toBe(
      "list",
    );
    expect(businessMode({ lists: { business: "ideas" }, ideas: null })).toBe(
      "list",
    );
  });
});

describe("guided-setup steps: resume", () => {
  const rc = (over: Partial<ResumeCtx> = {}): ResumeCtx => ({
    seedFirst: false,
    staticFirst: false,
    more: false,
    status: "OPEN",
    hasProfile: false,
    paidRun: false,
    answers: {},
    ideas: NONE,
    ...over,
  });
  it("keeps the saved step while it is in the list", () => {
    expect(
      resumeStep("audience", rc({ answers: { goal: picked("goal.sales") } })),
    ).toBe("audience");
    expect(resumeStep("checkpoint", rc({ answers: FULL }))).toBe("checkpoint");
  });
  it("clamps a stale saved step to the first unresolved main question", () => {
    // angle is not in the list: more is false
    expect(
      resumeStep(
        "angle",
        rc({ answers: { goal: picked("goal.sales"), channels: skipped } }),
      ),
    ).toBe("business");
    // detail step while the angle options vanished
    expect(
      resumeStep(
        "angle",
        rc({
          more: true,
          ideas: NONE,
          answers: { goal: picked("goal.sales") },
        }),
      ),
    ).toBe("channels");
  });
  it("clamps to the checkpoint when every main question is resolved", () => {
    expect(resumeStep("guardrails", rc({ answers: FULL }))).toBe("checkpoint");
    expect(resumeStep(null, rc({ answers: FULL }))).toBe("checkpoint");
  });
  it("a null step starts at the first question of the stored order", () => {
    expect(resumeStep(null, rc())).toBe("goal");
    expect(resumeStep(null, rc({ seedFirst: true }))).toBe("business");
    expect(
      resumeStep(
        null,
        rc({
          staticFirst: true,
          answers: { goal: skipped, channels: skipped },
        }),
      ),
    ).toBe("tone");
  });
  it("DONE opens on review whatever was saved", () => {
    expect(resumeStep("goal", rc({ status: "DONE", answers: FULL }))).toBe(
      "review",
    );
    expect(resumeStep(null, rc({ status: "DONE" }))).toBe("review");
  });
  it("an established project with no answers opens on review", () => {
    expect(resumeStep(null, rc({ hasProfile: true }))).toBe("review");
    expect(resumeStep("goal", rc({ hasProfile: true }))).toBe("review");
  });
  it("... but not once the session left its first step, holds an answer, or a paid run exists", () => {
    expect(resumeStep("channels", rc({ hasProfile: true }))).toBe("channels");
    expect(
      resumeStep(
        "goal",
        rc({ hasProfile: true, answers: { goal: picked("goal.sales") } }),
      ),
    ).toBe("goal");
    expect(resumeStep("goal", rc({ hasProfile: true, paidRun: true }))).toBe(
      "goal",
    );
    expect(resumeStep(null, rc({ hasProfile: false }))).toBe("goal");
  });
  it("seedFirst: the first step is business for the established-project rule", () => {
    expect(
      resumeStep("business", rc({ hasProfile: true, seedFirst: true })),
    ).toBe("review");
    expect(resumeStep("goal", rc({ hasProfile: true, seedFirst: true }))).toBe(
      "goal",
    );
  });
  it("all five skipped opens on review, never on the checkpoint", () => {
    expect(resumeStep("checkpoint", rc({ answers: ALL_SKIPPED }))).toBe(
      "review",
    );
    expect(resumeStep(null, rc({ answers: ALL_SKIPPED }))).toBe("review");
    expect(resumeStep("review", rc({ answers: ALL_SKIPPED }))).toBe("review");
  });
});

describe("guided-setup steps: progress (G81)", () => {
  it("assistive strings", () => {
    const c = ctx({ ideas: READY, more: true });
    expect(progressOf("goal", c).assistive).toBe("Question 1 of 5");
    expect(progressOf("business", c).assistive).toBe("Question 3 of 5");
    expect(progressOf("tone", c).assistive).toBe("Question 5 of 5");
    expect(progressOf("angle", c).assistive).toBe("Extra question 1 of 2");
    expect(progressOf("guardrails", c).assistive).toBe("Extra question 2 of 2");
    expect(progressOf("checkpoint", c).assistive).toBe("Review");
    expect(progressOf("review", c).assistive).toBe("Review");
  });
  it("the number follows the stored order", () => {
    const c = ctx({ staticFirst: true });
    expect(progressOf("tone", c).assistive).toBe("Question 3 of 5");
    expect(progressOf("business", ctx({ seedFirst: true })).assistive).toBe(
      "Question 1 of 5",
    );
  });
  it("without angle options the extra group has one question", () => {
    expect(
      progressOf("guardrails", ctx({ ideas: NONE, more: true })),
    ).toMatchObject({
      group: "detail",
      index: 1,
      total: 1,
      assistive: "Extra question 1 of 1",
    });
  });
  it("a catch-up carries no number", () => {
    const c = ctx({
      answers: { ...FULL, business: deferred },
      ideas: READY,
      lists: { business: "static" },
    });
    const p = progressOf("business", c);
    expect(p.catchUp).toBe(true);
    expect(p.group).toBe("catchup");
    expect(p.assistive).toBe("Suggestions ready");
    expect(p.assistive).not.toMatch(/\d/);
    expect(p.index).toBe(5);
  });
  it("a normal deferred step in the middle of the flow is not a catch-up", () => {
    const c = ctx({
      answers: { goal: picked("goal.sales"), business: deferred },
      ideas: READY,
      lists: { business: "static" },
    });
    expect(progressOf("business", c).catchUp).toBe(false);
  });
  it("segment fill never decreases along a walk with Back and a catch-up", () => {
    const answers: Answers = { ...FULL, business: deferred };
    const base = ctx({ answers, ideas: READY, lists: { business: "static" } });
    const walk: StepId[] = [
      "goal",
      "channels",
      "business",
      "audience",
      "tone",
      "audience", // Back
      "channels", // Back
      "goal", // Back
      "channels",
      "business", // catch-up visit (all resolved)
      "checkpoint",
      "review",
    ];
    let reached: Reached = {};
    let last = 0;
    for (const step of walk) {
      const p = progressOf(step, { ...base, reached });
      expect(p.index).toBeGreaterThanOrEqual(last);
      last = p.index;
      reached = bumpReached(reached, p);
    }
    expect(reached.main).toBe(5);
  });
  it("the detail group fills separately and never decreases", () => {
    const c = ctx({ more: true, ideas: READY });
    let reached: Reached = {};
    const a = progressOf("guardrails", { ...c, reached });
    reached = bumpReached(reached, a);
    const b = progressOf("angle", { ...c, reached });
    expect(b.index).toBeGreaterThanOrEqual(a.index);
    expect(b.assistive).toBe("Extra question 1 of 2");
  });
});
