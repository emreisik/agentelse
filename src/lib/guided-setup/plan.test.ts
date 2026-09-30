import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { CHANNELS, PLAN_GOAL_LABEL } from "@/lib/content-channels";

import {
  AUDIENCE_SEGMENTS,
  BUSINESS_KINDS,
  GOAL_PRESETS,
  GUARDRAILS,
  TONES,
  type Answers,
  type ApplyPlan,
  type IdeaOptions,
  type ReviewRow,
} from "./contract";
import {
  answeredMain,
  buildApplyPlan,
  resolveAnswerLabels,
  reviewRowsOf,
} from "./plan";

const IDEAS: IdeaOptions = {
  business: [{ id: "o_aaaaaaaaaa", label: "A QR menu for cafes", ai: true }],
  audience: [
    { id: "o_bbbbbbbbbb", label: "Cafe owners", ai: true },
    { id: "o_dddddddddd", label: "Restaurant managers", ai: true },
  ],
  angle: [{ id: "o_cccccccccc", label: "Set up in ten minutes", ai: true }],
};
const NO_IDEAS: IdeaOptions = { business: [], audience: [], angle: [] };

const FULL: Answers = {
  goal: { picked: ["goal.sales"] },
  channels: { picked: ["channel.instagram", "channel.linkedin"] },
  business: { picked: ["o_aaaaaaaaaa"] },
  audience: { picked: ["o_bbbbbbbbbb", "audience.local"] },
  tone: { picked: [], other: "Warm, a little cheeky" },
  angle: { picked: ["o_cccccccccc"] },
  guardrails: {
    picked: ["guardrail.no_prices", "guardrail.no_competitors"],
    other: "Never joke about allergies",
  },
};

const plan = (
  answers: Answers,
  over: Partial<Parameters<typeof buildApplyPlan>[0]> = {},
) => buildApplyPlan({ answers, ideas: IDEAS, ...over });

describe("guided-setup plan: skip and defer persist nothing (G14)", () => {
  it("no answers -> an empty plan with every sink null", () => {
    const p = plan({});
    expect(p).toEqual({
      profile: null,
      goal: null,
      channels: null,
      guardrails: null,
      lines: [],
      empty: true,
    });
  });
  it("skipped and deferred answers produce nothing", () => {
    const answers: Answers = {
      goal: { picked: [], skipped: true },
      channels: { picked: [], skipped: true },
      business: { picked: [], deferred: true },
      audience: { picked: [], deferred: true },
      tone: { picked: [], skipped: true },
      guardrails: { picked: [], skipped: true },
    };
    const p = plan(answers);
    expect(p.empty).toBe(true);
    expect(p.lines).toEqual([]);
  });
  it("a skipped flag wins even if an option id slipped in", () => {
    const answers: Answers = {
      goal: { picked: ["goal.sales"], skipped: true },
      channels: { picked: ["channel.seo"], deferred: true },
      business: { picked: ["kind.food"], skipped: true },
      guardrails: { picked: ["guardrail.no_prices"], skipped: true },
      tone: { picked: [], other: "Bold", skipped: true },
    };
    expect(plan(answers).empty).toBe(true);
    const rows = reviewRowsOf({ answers, ideas: IDEAS });
    expect(rows.every((r) => r.chips.length === 0)).toBe(true);
  });
  it("an answered question next to skipped ones makes only its own part", () => {
    const p = plan({
      goal: { picked: ["goal.leads"] },
      tone: { picked: [], skipped: true },
    });
    expect(p.empty).toBe(false);
    expect(p.lines.map((l) => l.part)).toEqual(["goal"]);
    expect(p.profile).toBeNull();
    expect(p.channels).toBeNull();
    expect(p.guardrails).toBeNull();
  });
});

describe("guided-setup plan: the plan itself", () => {
  const p = plan(FULL);
  it("profile takes the sentence, audiences (max 2), positioning and voice", () => {
    expect(p.profile).toEqual({
      identity: "A QR menu for cafes",
      audiences: ["Cafe owners", "People who live nearby"],
      positioning: "Set up in ten minutes",
      toneOfVoice: "Warm, a little cheeky",
    });
  });
  it("goal comes from the preset (title and metricKey are code)", () => {
    expect(p.goal).toEqual({
      key: "sales",
      title: GOAL_PRESETS.sales.title,
      metricKey: GOAL_PRESETS.sales.metricKey,
      mode: "proposed",
    });
  });
  it("goalMode defaults to proposed and is passed through", () => {
    expect(plan(FULL).goal?.mode).toBe("proposed");
    expect(plan(FULL, { goalMode: "active" }).goal?.mode).toBe("active");
  });
  it("both goal lines", () => {
    const active = plan(FULL, { goalMode: "active" }).lines.find(
      (l) => l.part === "goal",
    );
    const proposed = plan(FULL, { goalMode: "proposed" }).lines.find(
      (l) => l.part === "goal",
    );
    expect(active?.text).toBe(
      "Sets your goal: Sales. Your agency will work toward it.",
    );
    expect(proposed?.text).toBe(
      "Adds your goal as a proposal: approve it in Strategy.",
    );
  });
  it("memory line templates", () => {
    expect(p.channels).toEqual({
      keys: ["instagram", "linkedin"],
      memoryLine: "Focus channels: Instagram, LinkedIn.",
    });
    expect(p.guardrails?.memoryLine).toBe(
      "Never: state prices or discounts; mention competitors by name.",
    );
  });
  it("typed rules are rule rows only, never in the memory line", () => {
    expect(p.guardrails?.rules).toEqual([
      { text: "Never state prices or discounts", source: "preset" },
      { text: "Never mention competitors by name", source: "preset" },
      { text: "Never joke about allergies", source: "typed" },
    ]);
    expect(p.guardrails?.memoryLine).not.toContain("allergies");
    const onlyTyped = plan({ guardrails: { picked: [], other: "No puns" } });
    expect(onlyTyped.guardrails).toEqual({
      rules: [{ text: "No puns", source: "typed" }],
      memoryLine: null,
    });
  });
  it("at most two memory lines per run", () => {
    const lines = [p.channels?.memoryLine, p.guardrails?.memoryLine].filter(
      Boolean,
    );
    expect(lines.length).toBeLessThanOrEqual(2);
    expect(
      Object.keys(p).filter((k) => k === "channels" || k === "guardrails"),
    ).toHaveLength(2);
  });
  it("the lines follow the apply parts in order, with the closed wording", () => {
    expect(p.lines.map((l) => l.part)).toEqual([
      "profile",
      "goal",
      "channels",
      "guardrails",
    ]);
    expect(p.lines.map((l) => l.text)).toEqual([
      "Saves your brand profile: what you do, audience, positioning, voice",
      "Adds your goal as a proposal: approve it in Strategy.",
      "Remembers your channel focus: Instagram, LinkedIn",
      "Adds 3 rules your team always follows (existing rules stay)",
    ]);
    expect(p.empty).toBe(false);
  });
  it("the profile line names only the answered parts", () => {
    const only = plan({
      tone: { picked: ["tone.premium"] },
      audience: { picked: ["audience.online"] },
    });
    expect(only.lines).toEqual([
      { part: "profile", text: "Saves your brand profile: audience, voice" },
    ]);
  });
  it("one rule reads in the singular", () => {
    const one = plan({ guardrails: { picked: ["guardrail.no_health"] } });
    expect(one.lines[0]?.text).toBe(
      "Adds 1 rule your team always follows (existing rules stay)",
    );
  });
  it("a duplicate rule is written once", () => {
    const dup = plan({
      guardrails: {
        picked: ["guardrail.no_prices"],
        other: "never state prices or discounts",
      },
    });
    expect(dup.guardrails?.rules).toHaveLength(1);
  });
  it("caps: three channels, two audiences, four rules", () => {
    const wide = plan({
      channels: {
        picked: [
          "channel.instagram",
          "channel.tiktok",
          "channel.x",
          "channel.seo",
        ],
      },
      audience: {
        picked: ["audience.local", "audience.online", "audience.young"],
      },
      guardrails: {
        picked: GUARDRAILS.slice(0, 5).map((g) => g.id),
        other: "Extra rule",
      },
    });
    expect(wide.channels?.keys).toEqual(["instagram", "tiktok", "x"]);
    expect(wide.profile?.audiences).toHaveLength(2);
    expect(wide.guardrails?.rules).toHaveLength(4);
    expect(wide.guardrails?.rules.at(-1)?.source).toBe("typed");
  });
  it("a single question keeps the typed words and drops the pick", () => {
    const both = plan({
      tone: { picked: ["tone.friendly"], other: "Dry wit" },
    });
    expect(both.profile?.toneOfVoice).toBe("Dry wit");
  });
});

describe("guided-setup plan: every string has a known origin (G19)", () => {
  const known = new Set<string>([
    ...BUSINESS_KINDS.map((o) => o.label),
    ...AUDIENCE_SEGMENTS.map((o) => o.label),
    ...TONES.map((o) => o.label),
    ...GUARDRAILS.map((o) => o.label),
    ...Object.values(PLAN_GOAL_LABEL).map((g) => g.label),
    ...Object.values(CHANNELS).map((c) => c.label),
    ...[...IDEAS.business, ...IDEAS.audience, ...IDEAS.angle].map(
      (o) => o.label,
    ),
    "Warm, a little cheeky",
    "Never joke about allergies",
  ]);
  const walk = (value: unknown, out: string[]) => {
    if (typeof value === "string") out.push(value);
    else if (Array.isArray(value)) value.forEach((v) => walk(v, out));
    else if (value && typeof value === "object")
      Object.values(value).forEach((v) => walk(v, out));
  };
  it("plan.profile, rules and Review chips are labels or typed text", () => {
    const p = plan(FULL, { goalMode: "active" });
    const strings: string[] = [];
    walk(p.profile, strings);
    walk(
      p.guardrails?.rules.map((r) => r.text),
      strings,
    );
    walk(
      reviewRowsOf({ answers: FULL, ideas: IDEAS, more: true }).map((r) =>
        r.chips.map((c) => c.text),
      ),
      strings,
    );
    expect(strings.length).toBeGreaterThan(8);
    for (const s of strings) expect(known.has(s), s).toBe(true);
  });
  it("every line is built from those labels plus the closed vocabulary", () => {
    const p = plan(FULL, { goalMode: "active" });
    for (const line of p.lines) {
      expect(line.text).toMatch(
        /^(Saves your brand profile: |Sets your goal: |Adds your goal as a proposal|Remembers your channel focus: |Adds \d rules? your team always follows)/,
      );
    }
    expect(p.channels?.memoryLine).toBe("Focus channels: Instagram, LinkedIn.");
  });
  it("labels of AI options come only from the stored ideas passed in", () => {
    // The same id with another ideas row resolves to that row's label; with none, to nothing.
    const other: IdeaOptions = {
      ...NO_IDEAS,
      business: [{ id: "o_aaaaaaaaaa", label: "Another sentence", ai: true }],
    };
    expect(plan(FULL, { ideas: other }).profile?.identity).toBe(
      "Another sentence",
    );
    expect(plan(FULL, { ideas: NO_IDEAS }).profile?.identity).toBeUndefined();
    expect(resolveAnswerLabels("business", FULL.business, NO_IDEAS)).toEqual(
      [],
    );
  });
  it("ids that are not in the catalog or the stored ideas are dropped", () => {
    const spoof: Answers = {
      goal: { picked: ["goal.world_domination"] },
      channels: { picked: ["channel.myspace"] },
      business: { picked: ["o_ffffffffff", "kind.nope"] },
      tone: { picked: ["o_aaaaaaaaaa"] }, // an ideas id on a question without ideas
      audience: { picked: ["guardrail.no_prices"] }, // another question's id
    };
    expect(plan(spoof).empty).toBe(true);
  });
  it("typed text is cleaned again", () => {
    const p = plan({
      business: { picked: [], other: "  Cafe <b>for</b>   [everyone]  \n" },
      tone: { picked: [], other: "x".repeat(300) },
    });
    expect(p.profile?.identity).toBe("Cafe b for /b everyone");
    expect(p.profile?.toneOfVoice).toHaveLength(100);
    expect(plan({ business: { picked: [], other: "   " } }).empty).toBe(true);
    // a question with no Other row ignores typed text
    expect(plan({ goal: { picked: [], other: "Sales" } }).empty).toBe(true);
  });
  it("the client-side plan equals the server-side plan for the same inputs", () => {
    // The server reads the stored JSON; the client holds parsed objects.
    const viaServer = buildApplyPlan({
      answers: JSON.parse(JSON.stringify(FULL)) as Answers,
      ideas: JSON.parse(JSON.stringify(IDEAS)) as IdeaOptions,
      goalMode: "active",
    });
    const viaClient = buildApplyPlan({
      answers: FULL,
      ideas: IDEAS,
      goalMode: "active",
    });
    expect(JSON.parse(JSON.stringify(viaServer)) as ApplyPlan).toEqual(
      viaClient,
    );
    expect(
      buildApplyPlan({ answers: FULL, ideas: IDEAS, goalMode: "active" }),
    ).toEqual(viaClient);
  });
  it("the plan does not mutate its inputs", () => {
    const before = JSON.stringify([FULL, IDEAS]);
    plan(FULL);
    reviewRowsOf({ answers: FULL, ideas: IDEAS, more: true });
    expect(JSON.stringify([FULL, IDEAS])).toBe(before);
  });
});

describe("guided-setup plan: Review rows (G81)", () => {
  const rowOf = (rows: ReviewRow[], q: string) =>
    rows.find((r) => r.question === q);

  it("one row per main question in catalog order, detail rows only after more", () => {
    expect(
      reviewRowsOf({ answers: {}, ideas: NO_IDEAS }).map((r) => r.question),
    ).toEqual(["goal", "channels", "business", "audience", "tone"]);
    expect(
      reviewRowsOf({ answers: {}, ideas: IDEAS, more: true }).map(
        (r) => r.question,
      ),
    ).toEqual([
      "goal",
      "channels",
      "business",
      "audience",
      "tone",
      "angle",
      "guardrails",
    ]);
    // no angle options: no angle row, even after more
    expect(
      reviewRowsOf({ answers: {}, ideas: NO_IDEAS, more: true }).map(
        (r) => r.question,
      ),
    ).toEqual([
      "goal",
      "channels",
      "business",
      "audience",
      "tone",
      "guardrails",
    ]);
  });
  it("a detail question that was answered keeps its row", () => {
    const rows = reviewRowsOf({
      answers: { guardrails: { picked: ["guardrail.no_prices"] } },
      ideas: NO_IDEAS,
    });
    expect(rowOf(rows, "guardrails")).toMatchObject({ state: "answered" });
  });
  it("answered rows carry the exact strings, AI chips flagged", () => {
    const rows = reviewRowsOf({ answers: FULL, ideas: IDEAS, more: true });
    expect(rowOf(rows, "business")).toEqual({
      question: "business",
      state: "answered",
      chips: [{ text: "A QR menu for cafes", ai: true }],
    });
    expect(rowOf(rows, "audience")?.chips).toEqual([
      { text: "Cafe owners", ai: true },
      { text: "People who live nearby" },
    ]);
    expect(rowOf(rows, "tone")?.chips).toEqual([
      { text: "Warm, a little cheeky" },
    ]);
    expect(rowOf(rows, "goal")?.chips).toEqual([{ text: "Sales" }]);
    expect(rowOf(rows, "channels")?.chips).toEqual([
      { text: "Instagram" },
      { text: "LinkedIn" },
    ]);
  });
  it("skipped on a delegate question is 'delegated', elsewhere 'skipped'", () => {
    const rows = reviewRowsOf({
      answers: {
        goal: { picked: [], skipped: true },
        audience: { picked: [], skipped: true },
        tone: { picked: [], skipped: true },
        business: { picked: [], deferred: true },
        channels: { picked: [], skipped: true },
      },
      ideas: IDEAS,
    });
    expect(rowOf(rows, "goal")?.state).toBe("skipped");
    expect(rowOf(rows, "channels")?.state).toBe("skipped");
    expect(rowOf(rows, "business")?.state).toBe("skipped");
    expect(rowOf(rows, "audience")?.state).toBe("delegated");
    expect(rowOf(rows, "tone")?.state).toBe("delegated");
    expect(rows.every((r) => r.chips.length === 0)).toBe(true);
  });
  it("an unanswered question whose profile holds a value is 'current' with the value as a chip", () => {
    const rows = reviewRowsOf({
      answers: { goal: { picked: ["goal.sales"] } },
      ideas: NO_IDEAS,
      current: {
        identity: "A bakery in Skopje",
        audiences: ["Families", "Students"],
        tone: "Warm",
        goal: "Increase sales",
      },
    });
    expect(rowOf(rows, "business")).toEqual({
      question: "business",
      state: "current",
      chips: [{ text: "A bakery in Skopje", ai: true }],
    });
    expect(rowOf(rows, "audience")?.chips.map((c) => c.text)).toEqual([
      "Families",
      "Students",
    ]);
    expect(rowOf(rows, "tone")?.state).toBe("current");
    // answered wins over current; channels has no current value
    expect(rowOf(rows, "goal")?.state).toBe("answered");
    expect(rowOf(rows, "channels")?.state).toBe("unanswered");
  });
  it("a skip beats the current value, and hostile current text is dropped", () => {
    const rows = reviewRowsOf({
      answers: { tone: { picked: [], skipped: true } },
      ideas: NO_IDEAS,
      current: { tone: "Warm", identity: "Visit http://evil.example now" },
    });
    expect(rowOf(rows, "tone")?.state).toBe("delegated");
    expect(rowOf(rows, "business")?.state).toBe("unanswered");
  });
  it("an unanswered question with nothing known is 'unanswered'", () => {
    const rows = reviewRowsOf({ answers: {}, ideas: NO_IDEAS, current: {} });
    expect(
      rows.every((r) => r.state === "unanswered" && r.chips.length === 0),
    ).toBe(true);
  });
});

describe("guided-setup plan: purity", () => {
  it("steps.ts and plan.ts read no clock and no randomness", () => {
    for (const file of ["steps.ts", "plan.ts"]) {
      const source = readFileSync(`${__dirname}/${file}`, "utf8");
      expect(source).not.toMatch(/Date\.now|new Date|Math\.random|crypto\./u);
    }
  });
});

describe("guided-setup plan: helpers", () => {
  it("answeredMain counts real answers only", () => {
    expect(answeredMain({})).toBe(0);
    expect(
      answeredMain({
        goal: { picked: ["goal.sales"] },
        tone: { picked: [], other: "Bold" },
        audience: { picked: [], skipped: true },
        business: { picked: [], deferred: true },
        guardrails: { picked: ["guardrail.no_prices"] },
      }),
    ).toBe(2);
  });
  it("resolveAnswerLabels returns the shown strings in tap order", () => {
    expect(resolveAnswerLabels("audience", FULL.audience, IDEAS)).toEqual([
      "Cafe owners",
      "People who live nearby",
    ]);
    expect(resolveAnswerLabels("goal", undefined, IDEAS)).toEqual([]);
  });
});
