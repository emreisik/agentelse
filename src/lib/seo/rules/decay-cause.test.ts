import { describe, expect, it } from "vitest";

import { decayCause } from "./decay-cause";
import { metric } from "./test-support";

const prior = metric({ clicks: 100, impressions: 2000, position: 5 });

function cause(input: Partial<Parameters<typeof decayCause>[0]>) {
  return decayCause({
    recent: metric({ clicks: 60, impressions: 2000, position: 5.5 }),
    prior,
    indexProblem: false,
    ownShareDrop: null,
    otherShareRise: null,
    ...input,
  });
}

describe("decayCause", () => {
  it("puts index problems first", () => {
    expect(
      cause({ indexProblem: true, ownShareDrop: 0.5, otherShareRise: 0.5 }),
    ).toBe("INDEX");
  });

  it("detects cannibalization before ranking", () => {
    const recent = metric({ clicks: 50, impressions: 2000, position: 9 });
    expect(cause({ recent, ownShareDrop: 0.3, otherShareRise: 0.3 })).toBe(
      "CANNIBALIZATION",
    );
    expect(cause({ recent, ownShareDrop: 0.29, otherShareRise: 0.5 })).toBe(
      "RANKING",
    );
    expect(cause({ recent, ownShareDrop: 0.5, otherShareRise: null })).toBe(
      "RANKING",
    );
  });

  it("calls a drop of two or more positions RANKING", () => {
    expect(
      cause({ recent: metric({ clicks: 50, impressions: 2000, position: 7 }) }),
    ).toBe("RANKING");
    expect(
      cause({
        recent: metric({ clicks: 50, impressions: 2000, position: 6.9 }),
      }),
    ).toBe("MIXED");
  });

  it("calls a demand drop with a stable position DEMAND", () => {
    expect(
      cause({
        recent: metric({ clicks: 60, impressions: 1500, position: 5.5 }),
      }),
    ).toBe("DEMAND");
    // Gösterim yalnız %24 düştü, CTR düşüşü de < %20: MIXED.
    expect(
      cause({
        recent: metric({ clicks: 70, impressions: 1520, position: 5.5 }),
      }),
    ).toBe("MIXED");
  });

  it("calls a click-rate drop with a stable position CTR", () => {
    expect(
      cause({
        recent: metric({ clicks: 80, impressions: 2000, position: 5.5 }),
      }),
    ).toBe("CTR");
    expect(
      cause({
        recent: metric({ clicks: 81, impressions: 2000, position: 5.5 }),
      }),
    ).toBe("MIXED");
  });

  it("falls back to MIXED without positions", () => {
    expect(cause({ recent: metric({ clicks: 0, impressions: 0 }) })).toBe(
      "MIXED",
    );
  });
});
