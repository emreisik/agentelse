import { describe, expect, it } from "vitest";

import {
  defaultPublishAt,
  formatDay,
  formatWhen,
  isWallClock,
} from "./deliver";
import {
  SEO_RUN_TTL_MS,
  canGoToSeoStep,
  parseSeoState,
  seoFlowComplete,
  scrubSearchData,
  seoModeOf,
  seoOpenableSteps,
  seoRunActive,
  seoStatusOf,
  seoStepsFor,
  serializeSeoState,
  withoutRun,
  type SeoState,
} from "./state";

const NOW = Date.parse("2026-10-05T10:00:00.000Z");

const BRIEF = {
  topic: "Running shoes for beginners",
  siteUrl: "https://example.com",
  language: "en",
  audience: "",
};

const PLAN = {
  primaryKeyword: "running shoes",
  secondaryKeywords: ["best running shoes"],
  searchIntent: "commercial",
  intentNote: "They compare pairs.",
  titleOptions: ["A", "B"],
  titleIndex: 1,
  metaDescription: "Meta.",
  outline: [{ h2: "One", points: ["a"] }],
  quickWins: { state: "not-connected" },
  researchedAt: "2026-10-05T09:00:00.000Z",
};

const ARTICLE = {
  title: "A",
  metaDescription: "Meta.",
  markdown: "Body.",
  writtenAt: "2026-10-05T09:30:00.000Z",
  rewrites: 0,
};

describe("parseSeoState", () => {
  it("reads nothing from garbage", () => {
    for (const value of [null, undefined, "x", 3, [], { brief: "x" }]) {
      expect(parseSeoState(value)).toEqual({});
    }
  });

  it("keeps every valid part and drops a broken one", () => {
    const state = parseSeoState({
      brief: BRIEF,
      plan: PLAN,
      article: { ...ARTICLE, markdown: "" },
      run: { id: "r1", kind: "research", startedAt: "2026-10-05T09:59:00Z" },
    });
    expect(state.brief).toEqual(BRIEF);
    expect(state.plan?.primaryKeyword).toBe("running shoes");
    expect(state.article).toBeUndefined();
    expect(state.run?.kind).toBe("research");
  });

  it("keeps a brief with an empty topic (a Fix this card opens with the site and language only)", () => {
    const state = parseSeoState({ brief: { ...BRIEF, topic: "" } });
    expect(state.brief).toEqual({ ...BRIEF, topic: "" });
    // Dil yine zorunlu: bozuk bir dil özeti düşürür.
    expect(
      parseSeoState({ brief: { ...BRIEF, topic: "", language: "" } }).brief,
    ).toBeUndefined();
  });

  it("repairs what it can: bad items out, defaults in, the title index clamped", () => {
    const state = parseSeoState({
      plan: {
        ...PLAN,
        secondaryKeywords: ["ok", 3, "", "fine"],
        searchIntent: "shopping",
        titleIndex: 7,
        outline: [{ h2: "One", points: ["a", 2] }, { h2: "" }, "x"],
        quickWins: {
          state: "ok",
          items: [
            { query: "q", impressions: 10, clicks: 1, position: 12 },
            { query: "bad" },
          ],
        },
      },
    });
    expect(state.plan).toMatchObject({
      secondaryKeywords: ["ok", "fine"],
      searchIntent: "informational",
      titleIndex: 1,
      outline: [{ h2: "One", points: ["a"] }],
      quickWins: {
        state: "ok",
        items: [{ query: "q", impressions: 10, clicks: 1, position: 12 }],
      },
    });
  });

  it("reads a quick win's gain only when it is a non-negative number", () => {
    const items = [
      { query: "with gain", impressions: 10, clicks: 1, position: 12, gain: 7 },
      { query: "negative", impressions: 10, clicks: 1, position: 12, gain: -1 },
      { query: "text", impressions: 10, clicks: 1, position: 12, gain: "7" },
      { query: "absent", impressions: 10, clicks: 1, position: 12 },
    ];
    const state = parseSeoState({
      plan: { ...PLAN, quickWins: { state: "ok", items } },
    });
    const quickWins = state.plan?.quickWins;
    expect(quickWins?.state).toBe("ok");
    const parsed = quickWins?.state === "ok" ? quickWins.items : [];
    expect(parsed.map((item) => item.query)).toEqual([
      "with gain",
      "negative",
      "text",
      "absent",
    ]);
    expect(parsed[0]?.gain).toBe(7);
    for (const item of parsed.slice(1)) expect(item.gain).toBeUndefined();
    expect(parsed[3]).not.toHaveProperty("gain");
    expect(Object.keys(serializeSeoState(state).plan as object)).toContain(
      "quickWins",
    );
    const stored = serializeSeoState(state) as {
      plan: { quickWins: { items: Record<string, unknown>[] } };
    };
    expect(stored.plan.quickWins.items.map((item) => "gain" in item)).toEqual([
      true,
      false,
      false,
      false,
    ]);
  });

  it("needs a title and a section to keep a plan", () => {
    expect(
      parseSeoState({ plan: { ...PLAN, titleOptions: [] } }).plan,
    ).toBeUndefined();
    expect(
      parseSeoState({ plan: { ...PLAN, outline: [] } }).plan,
    ).toBeUndefined();
  });

  it("round-trips through the card's data without undefined keys", () => {
    const state: SeoState = {
      brief: BRIEF,
      delivery: {
        postId: "p1",
        creativeId: "c1",
        scheduledFor: "2026-10-09T07:00:00.000Z",
        timezone: "Europe/Istanbul",
      },
    };
    const data = serializeSeoState(state);
    expect(Object.keys(data)).toEqual(["brief", "delivery"]);
    expect(parseSeoState(data)).toEqual(state);
  });
});

describe("runs", () => {
  const run = {
    id: "r1",
    kind: "write" as const,
    startedAt: new Date(NOW).toISOString(),
  };

  it("holds the card until the TTL, then counts as crashed", () => {
    expect(seoRunActive(run, NOW + 1000)).toBe(true);
    expect(seoRunActive(run, NOW + SEO_RUN_TTL_MS)).toBe(false);
    expect(seoRunActive(undefined, NOW)).toBe(false);
    expect(seoRunActive({ ...run, startedAt: "never" }, NOW)).toBe(false);
  });

  it("withoutRun drops only the claim", () => {
    expect(withoutRun({ brief: BRIEF, run })).toEqual({ brief: BRIEF });
  });

  it("shows what the card is doing in its status pill", () => {
    expect(seoStatusOf({ run }, NOW)).toEqual({
      label: "Writing",
      tone: "waiting",
    });
    expect(seoStatusOf({}, NOW)).toBeNull();
    const delivery = {
      postId: "p",
      creativeId: "c",
      scheduledFor: "2026-10-09T07:00:00.000Z",
      timezone: "UTC",
    };
    expect(seoStatusOf({ delivery })).toEqual({
      label: "On calendar",
      tone: "special",
    });
    expect(
      seoStatusOf({
        delivery: { ...delivery, publishedAt: "2026-10-09T08:00:00Z" },
      }),
    ).toEqual({ label: "Published", tone: "positive" });
    expect(seoFlowComplete({ delivery })).toBe(false);
    expect(
      seoFlowComplete({
        delivery: { ...delivery, publishedAt: "2026-10-09T08:00:00Z" },
      }),
    ).toBe(true);
  });
});

describe("canGoToSeoStep", () => {
  const parsed = parseSeoState({ brief: BRIEF, plan: PLAN, article: ARTICLE });

  it("goes back to any step whose content exists", () => {
    expect(canGoToSeoStep({ step: "plan", state: parsed, to: "brief" })).toBe(
      true,
    );
    expect(canGoToSeoStep({ step: "review", state: parsed, to: "plan" })).toBe(
      true,
    );
    expect(
      canGoToSeoStep({ step: "deliver", state: parsed, to: "review" }),
    ).toBe(true);
    expect(canGoToSeoStep({ step: "plan", state: parsed, to: "review" })).toBe(
      true,
    );
    expect(
      canGoToSeoStep({ step: "brief", state: { brief: BRIEF }, to: "plan" }),
    ).toBe(false);
  });

  it("publishes only from Review, never jumps into Create or stays put", () => {
    expect(
      canGoToSeoStep({ step: "review", state: parsed, to: "deliver" }),
    ).toBe(true);
    expect(canGoToSeoStep({ step: "plan", state: parsed, to: "deliver" })).toBe(
      false,
    );
    expect(canGoToSeoStep({ step: "plan", state: parsed, to: "create" })).toBe(
      false,
    );
    expect(canGoToSeoStep({ step: "plan", state: parsed, to: "plan" })).toBe(
      false,
    );
  });

  it("stays put while a model call runs and once the article is on the calendar", () => {
    const running = {
      ...parsed,
      run: {
        id: "r",
        kind: "rewrite" as const,
        startedAt: new Date(NOW).toISOString(),
      },
    };
    expect(
      canGoToSeoStep({
        step: "review",
        state: running,
        to: "plan",
        now: NOW + 1,
      }),
    ).toBe(false);
    const placed = {
      ...parsed,
      delivery: {
        postId: "p",
        creativeId: "c",
        scheduledFor: "2026-10-09T07:00:00.000Z",
        timezone: "UTC",
      },
    };
    expect(
      canGoToSeoStep({ step: "deliver", state: placed, to: "review" }),
    ).toBe(false);
    expect(seoOpenableSteps("deliver", placed)).toEqual({
      brief: false,
      plan: false,
      review: false,
    });
  });
});

describe("deliver helpers", () => {
  it("accepts only a real wall-clock date and time", () => {
    expect(isWallClock("2026-10-09T10:00")).toBe(true);
    expect(isWallClock("2026-02-31T10:00")).toBe(false);
    expect(isWallClock("2026-10-09T24:00")).toBe(false);
    expect(isWallClock("2026-10-09 10:00")).toBe(false);
    expect(isWallClock(42)).toBe(false);
  });

  it("starts the picker on tomorrow at 10:00", () => {
    expect(defaultPublishAt("2026-10-05")).toBe("2026-10-06T10:00");
    expect(defaultPublishAt("2026-12-31")).toBe("2027-01-01T10:00");
  });

  it("prints the day and time in the project's timezone", () => {
    expect(formatWhen("2026-10-09T07:00:00.000Z", "Europe/Istanbul")).toBe(
      "Fri 9 Oct, 10:00",
    );
    expect(formatDay("2026-10-09T22:30:00.000Z", "Europe/Istanbul")).toBe(
      "Sat 10 Oct",
    );
    expect(formatWhen("nonsense")).toBe("");
  });
});

// ---- SC-F6: kipler, hedef, başlık düzeltme, tazeleme ------------------------------

const TARGET = {
  url: "https://example.com/blog/shoes",
  path: "/blog/shoes",
  title: "Shoes",
  metaDescription: "About shoes.",
  h1: "Shoes",
  h2: ["Fit", "Care"],
  wordCount: 800,
  textHash: "abc",
  fetchedAt: "2026-10-05T09:00:00.000Z",
  queryCount: 7,
};

const SNIPPET = {
  variants: [
    { title: "A", metaDescription: "a", angle: "Benefit" },
    { title: "B", metaDescription: "b", angle: "Question" },
  ],
  chosen: 1,
  edited: null,
  generatedAt: "2026-10-05T09:30:00.000Z",
};

describe("an old card", () => {
  it("parses to exactly what it did before the modes existed", () => {
    const old = {
      brief: BRIEF,
      plan: PLAN,
      article: ARTICLE,
      delivery: {
        postId: "p",
        creativeId: "c",
        scheduledFor: "2026-10-09T07:00:00.000Z",
        timezone: "UTC",
      },
      run: { id: "r1", kind: "write", startedAt: "2026-10-05T09:59:00Z" },
    };
    const state = parseSeoState(old);
    expect(Object.keys(state)).toEqual([
      "brief",
      "plan",
      "article",
      "delivery",
      "run",
    ]);
    expect(state.run).toStrictEqual(old.run);
    expect(seoModeOf(state)).toBe("article");
    expect(seoStepsFor("article")).toEqual([
      "brief",
      "plan",
      "create",
      "review",
      "deliver",
    ]);
  });
});

describe("the mode parts", () => {
  it("reads every new part when valid", () => {
    const state = parseSeoState({
      brief: BRIEF,
      mode: "snippet",
      features: { modes: true, live: false },
      target: TARGET,
      pendingUrl: "https://example.com/x",
      origin: { findingId: "f1", ruleKey: "TA1" },
      actionId: "act_1",
      snippet: SNIPPET,
      refresh: { missing: ["a", 3, "b"], keep: ["Fit"] },
      lastError: {
        runId: "r1",
        kind: "snippet",
        message: "Nope.",
        at: "2026-10-05T10:00:00.000Z",
      },
      applied: { at: "2026-10-06T10:00:00.000Z" },
      run: {
        id: "r2",
        kind: "snippet",
        startedAt: "2026-10-05T09:59:00Z",
        phase: "writing",
      },
    });
    expect(state.mode).toBe("snippet");
    expect(state.features).toEqual({ modes: true, live: false });
    expect(state.target).toEqual(TARGET);
    expect(state.pendingUrl).toBe("https://example.com/x");
    expect(state.origin).toEqual({ findingId: "f1", ruleKey: "TA1" });
    expect(state.actionId).toBe("act_1");
    expect(state.snippet).toEqual(SNIPPET);
    expect(state.refresh).toEqual({ missing: ["a", "b"], keep: ["Fit"] });
    expect(state.lastError?.kind).toBe("snippet");
    expect(state.applied).toEqual({ at: "2026-10-06T10:00:00.000Z" });
    expect(state.run?.phase).toBe("writing");
  });

  it("drops what is bad and keeps the rest", () => {
    const state = parseSeoState({
      brief: BRIEF,
      mode: "bulk",
      features: "yes",
      target: { ...TARGET, url: "" },
      pendingUrl: "",
      origin: { findingId: "f1" },
      actionId: "bad id!",
      snippet: { ...SNIPPET, variants: [] },
      applied: { at: "" },
      run: { id: "r", kind: "write", startedAt: "x", phase: "dreaming" },
    });
    expect(state).toEqual({
      brief: BRIEF,
      run: { id: "r", kind: "write", startedAt: "x" },
    });
  });

  it("repairs: clamps long text, drops variants past three, fixes the choice", () => {
    const state = parseSeoState({
      target: {
        ...TARGET,
        title: "x".repeat(900),
        h2: ["ok", 1, "y".repeat(500)],
        queryCount: -3,
        wordCount: "many",
      },
      features: { modes: true },
      snippet: {
        ...SNIPPET,
        variants: [1, 2, 3, 4].map((n) => ({
          title: `T${n}`,
          metaDescription: "m",
          angle: "a",
        })),
        chosen: 9,
      },
    });
    expect(state.target?.title).toHaveLength(300);
    expect(state.target?.h2).toHaveLength(2);
    expect(state.target?.h2[1]).toHaveLength(200);
    expect(state.target?.queryCount).toBe(0);
    expect(state.target?.wordCount).toBeNull();
    expect(state.features).toEqual({ modes: true, live: false });
    expect(state.snippet?.variants).toHaveLength(3);
    expect(state.snippet?.chosen).toBeNull();
  });

  it("round-trips through the card's data", () => {
    const state: SeoState = {
      mode: "refresh",
      features: { modes: true, live: true },
      target: TARGET,
      refresh: { missing: ["a"], keep: ["b"] },
    };
    expect(parseSeoState(serializeSeoState(state))).toEqual(state);
  });
});

describe("snippet mode", () => {
  const base: SeoState = {
    brief: BRIEF,
    mode: "snippet",
    target: TARGET,
    snippet: SNIPPET,
  };

  it("has Brief, Plan and Deliver only", () => {
    expect(seoStepsFor("snippet")).toEqual(["brief", "plan", "deliver"]);
  });

  it("opens Deliver only with a chosen variant, from the Plan step", () => {
    expect(canGoToSeoStep({ step: "plan", state: base, to: "deliver" })).toBe(
      true,
    );
    expect(
      canGoToSeoStep({
        step: "plan",
        state: { ...base, snippet: { ...SNIPPET, chosen: null } },
        to: "deliver",
      }),
    ).toBe(false);
    expect(canGoToSeoStep({ step: "brief", state: base, to: "deliver" })).toBe(
      false,
    );
    expect(canGoToSeoStep({ step: "plan", state: base, to: "review" })).toBe(
      false,
    );
    expect(canGoToSeoStep({ step: "deliver", state: base, to: "plan" })).toBe(
      true,
    );
    expect(
      canGoToSeoStep({
        step: "brief",
        state: { ...base, snippet: undefined },
        to: "plan",
      }),
    ).toBe(false);
  });

  it("lists Brief and Plan as openable", () => {
    expect(seoOpenableSteps("deliver", base)).toEqual({
      brief: true,
      plan: true,
    });
  });

  it("is complete and 'Updated' once applied, and locks the card", () => {
    const applied = { ...base, applied: { at: "2026-10-06T10:00:00.000Z" } };
    expect(seoFlowComplete(base)).toBe(false);
    expect(seoFlowComplete(applied)).toBe(true);
    expect(seoStatusOf(applied)).toEqual({
      label: "Updated",
      tone: "positive",
    });
    expect(
      canGoToSeoStep({ step: "deliver", state: applied, to: "plan" }),
    ).toBe(false);
  });

  it("names the snippet run in the status pill", () => {
    const run = {
      id: "r",
      kind: "snippet" as const,
      startedAt: new Date(NOW).toISOString(),
    };
    expect(seoStatusOf({ ...base, run }, NOW)).toEqual({
      label: "Writing titles",
      tone: "waiting",
    });
  });
});

describe("refresh mode", () => {
  const state: SeoState = {
    brief: BRIEF,
    mode: "refresh",
    target: TARGET,
    plan: parseSeoState({ plan: PLAN }).plan,
    article: ARTICLE,
  };

  it("keeps the five steps and the article navigation", () => {
    expect(seoStepsFor("refresh")).toHaveLength(5);
    expect(canGoToSeoStep({ step: "review", state, to: "deliver" })).toBe(true);
    expect(canGoToSeoStep({ step: "review", state, to: "plan" })).toBe(true);
  });

  it("is complete when applied", () => {
    const applied = { ...state, applied: { at: "2026-10-06T10:00:00.000Z" } };
    expect(seoFlowComplete(state)).toBe(false);
    expect(seoFlowComplete(applied)).toBe(true);
    expect(seoStatusOf(applied)?.label).toBe("Updated");
    expect(
      canGoToSeoStep({ step: "deliver", state: applied, to: "review" }),
    ).toBe(false);
  });

  it("an article card ignores a stray applied mark", () => {
    const article: SeoState = {
      brief: BRIEF,
      article: ARTICLE,
      applied: { at: "2026-10-06T10:00:00.000Z" },
    };
    expect(seoFlowComplete(article)).toBe(false);
    expect(seoStatusOf(article)).toBeNull();
  });
});

describe("scrubSearchData", () => {
  const plan = parseSeoState({ plan: PLAN }).plan!;
  const withWins: SeoState = {
    plan: {
      ...plan,
      quickWins: {
        state: "ok",
        items: [{ query: "q", impressions: 10, clicks: 1, position: 12 }],
      },
    },
    target: TARGET,
  };

  it("replaces ok quick wins and zeroes the query count", () => {
    const { state, changed } = scrubSearchData(withWins);
    expect(changed).toBe(true);
    expect(state.plan?.quickWins).toEqual({ state: "not-connected" });
    expect(state.target?.queryCount).toBe(0);
    expect(state.target?.title).toBe("Shoes");
    // Girdi değişmez.
    expect(withWins.plan?.quickWins.state).toBe("ok");
    expect(withWins.target?.queryCount).toBe(7);
  });

  it("does nothing otherwise", () => {
    const clean: SeoState = {
      plan: { ...plan, quickWins: { state: "failed" } },
      target: { ...TARGET, queryCount: 0 },
    };
    const result = scrubSearchData(clean);
    expect(result.changed).toBe(false);
    expect(result.state).toBe(clean);
    expect(scrubSearchData({}).changed).toBe(false);
  });
});
