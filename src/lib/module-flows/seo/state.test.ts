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
  seoOpenableSteps,
  seoRunActive,
  seoStatusOf,
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
