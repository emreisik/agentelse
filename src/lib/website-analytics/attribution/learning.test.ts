import { describe, expect, it } from "vitest";

import {
  ATTRIBUTION_LEARNING_GATE,
  attributionLearningOf,
  GA_ATTRIBUTION_LEARNING_PREFIX,
} from "./learning";
import type {
  AttributionGroup,
  AttributionMetrics,
} from "./types";

function metrics(sessions: number, keyEvents: number): AttributionMetrics {
  return {
    sessions,
    engagedSessions: Math.round(sessions * 0.6),
    keyEvents,
    revenue: 0,
  };
}

function group(
  sessions: number,
  keyEvents: number,
  overrides: Partial<
    Pick<AttributionGroup, "key" | "kind" | "entityType" | "label">
  > = {},
): Pick<AttributionGroup, "key" | "kind" | "entityType" | "label" | "metrics"> {
  return {
    key: "meta:123456789",
    kind: "meta_campaign",
    entityType: "meta_ad",
    label: "Spring Sale",
    metrics: metrics(sessions, keyEvents),
    ...overrides,
  };
}

describe("attributionLearningOf", () => {
  it("returns null below the session floor", () => {
    expect(
      attributionLearningOf({
        group: group(199, 40),
        rest: metrics(5000, 250),
      }),
    ).toBeNull();
  });

  it("returns null when the rest of the site is too small", () => {
    expect(
      attributionLearningOf({
        group: group(500, 60),
        rest: metrics(199, 10),
      }),
    ).toBeNull();
  });

  it("returns null when fewer than 10 key events were expected", () => {
    // Beklenen: 0.02 × 300 = 6.
    expect(
      attributionLearningOf({
        group: group(300, 30),
        rest: metrics(5000, 100),
      }),
    ).toBeNull();
  });

  it("returns null when the difference is not significant", () => {
    expect(
      attributionLearningOf({
        group: group(200, 13),
        rest: metrics(2000, 100),
      }),
    ).toBeNull();
  });

  it("returns null for a significant ratio of only 1.1", () => {
    expect(
      attributionLearningOf({
        group: group(100_000, 5500),
        rest: metrics(100_000, 5000),
      }),
    ).toBeNull();
  });

  it("writes a WORKS learning for a significant 2.4x", () => {
    const result = attributionLearningOf({
      group: group(500, 60),
      rest: metrics(5000, 250),
    });
    expect(result).not.toBeNull();
    expect(result?.polarity).toBe("WORKS");
    expect(result?.insight).toContain("clearly more often");
    expect(result?.ratio).toBeCloseTo(2.4, 5);
    expect(result?.p).toBeLessThan(ATTRIBUTION_LEARNING_GATE.maxP);
    expect(result?.sessions).toBe(500);
  });

  it("writes an AVOID learning with the check sentence for a significant 0.5x", () => {
    const result = attributionLearningOf({
      group: group(1000, 25),
      rest: metrics(10_000, 500),
    });
    expect(result?.polarity).toBe("AVOID");
    expect(result?.insight).toContain("clearly less often");
    expect(result?.insight).toContain(
      "check that the ad or post matches the page it opens",
    );
    expect(result?.ratio).toBeCloseTo(0.5, 5);
  });

  it("keeps digits, slashes and numbers out of the text", () => {
    const result = attributionLearningOf({
      group: group(500, 60, { label: "Spring 2026 Sale" }),
      rest: metrics(5000, 250),
    });
    expect(result?.insight).toMatch(/^[^0-9]*$/);
    expect(result?.insight).not.toContain("/");
    expect(result?.insight).toContain('"Spring Sale"');
  });

  it("strips quotes, control characters and path marks from the label", () => {
    const result = attributionLearningOf({
      group: group(500, 60, { label: ' "Big\n"Sale"/pricing?x=1 ' }),
      rest: metrics(5000, 250),
    });
    expect(result?.insight).toContain('"Big Sale pricing x"');
    expect(result?.insight).not.toMatch(/[?=/\n]/);
    expect(result?.insight.match(/"/g)?.length).toBe(2);
  });

  it("clips a long label to 60 characters", () => {
    const result = attributionLearningOf({
      group: group(500, 60, { label: "Lovely ".repeat(30) }),
      rest: metrics(5000, 250),
    });
    const quoted = result?.insight.match(/"([^"]*)"/)?.[1] ?? "";
    expect(quoted.length).toBeLessThanOrEqual(60);
    expect(quoted.length).toBeGreaterThan(40);
  });

  it("drops the name when nothing is left of the label", () => {
    const result = attributionLearningOf({
      group: group(500, 60, { label: "2026 \"\"" }),
      rest: metrics(5000, 250),
    });
    expect(result?.insight).toBe(
      "Visitors from the Meta campaign took a key action clearly more often than other website visitors.",
    );
  });

  it("describes each kind of tracked link", () => {
    const base = { rest: metrics(5000, 250) };
    expect(
      attributionLearningOf({
        ...base,
        group: group(500, 60, {
          key: "link:abc",
          kind: "link",
          entityType: "instagram_bio",
          label: "Bio",
        }),
      })?.insight,
    ).toContain("your Instagram bio link");
    expect(
      attributionLearningOf({
        ...base,
        group: group(500, 60, {
          key: "link:abc",
          kind: "link",
          entityType: "facebook_post",
          label: "Launch",
        }),
      })?.insight,
    ).toContain('the Facebook post "Launch"');
    expect(
      attributionLearningOf({
        ...base,
        group: group(500, 60, {
          key: "link:abc",
          kind: "link",
          entityType: "social_post",
          label: "Launch",
        }),
      })?.insight,
    ).toContain('the post "Launch"');
  });

  it("builds the sourceRef from the prefix and the group key", () => {
    const result = attributionLearningOf({
      group: group(500, 60, { key: "link:cl123" }),
      rest: metrics(5000, 250),
    });
    expect(GA_ATTRIBUTION_LEARNING_PREFIX).toBe("ga-utm:");
    expect(result?.sourceRef).toBe("ga-utm:link:cl123");
  });

  it("uses the high confidence tier only for p < 0.01 and 1000+ sessions", () => {
    const low = attributionLearningOf({
      group: group(500, 60),
      rest: metrics(5000, 250),
    });
    expect(low?.p).toBeLessThan(0.01);
    expect(low?.confidence).toBe(0.6);

    const high = attributionLearningOf({
      group: group(1000, 25),
      rest: metrics(10_000, 500),
    });
    expect(high?.confidence).toBe(0.8);

    // p 0.01 ile 0.05 arasında: 1000 oturum olsa da düşük kademe.
    const middle = attributionLearningOf({
      group: group(1000, 66),
      rest: metrics(10_000, 500),
    });
    expect(middle?.p).toBeGreaterThan(0.01);
    expect(middle?.p).toBeLessThan(0.05);
    expect(middle?.confidence).toBe(0.6);
  });

  it("returns null for non-finite numbers", () => {
    expect(
      attributionLearningOf({
        group: group(Number.NaN, 60),
        rest: metrics(5000, 250),
      }),
    ).toBeNull();
  });
});
