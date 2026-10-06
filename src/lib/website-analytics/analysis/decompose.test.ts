import { describe, expect, it } from "vitest";

import { decompose, decompositionRows, type GaDecomposeRow } from "./decompose";
import type { GaDecomposition } from "./types";

// Tohumlu PRNG (mulberry32): rastgele ama tekrarlanabilir fikstürler.
function prng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function row(
  key: string,
  sB: number,
  sA: number,
  vB: number,
  vA: number,
): GaDecomposeRow {
  return {
    key,
    label: key,
    sessionsBefore: sB,
    sessionsAfter: sA,
    valueBefore: vB,
    valueAfter: vA,
  };
}

function explained(result: GaDecomposition): number {
  return (
    result.components.reduce((sum, c) => sum + c.total, 0) +
    (result.other?.total ?? 0) +
    result.residual
  );
}

describe("decompose", () => {
  it("keeps components + other + residual equal to the total change on 200 random fixtures", () => {
    const random = prng(20261007);
    for (let i = 0; i < 200; i += 1) {
      const count = 1 + Math.floor(random() * 25);
      const rows: GaDecomposeRow[] = [];
      for (let r = 0; r < count; r += 1) {
        const zeroBefore = random() < 0.1;
        const zeroAfter = random() < 0.1;
        const sB = zeroBefore ? 0 : Math.floor(random() * 2000);
        const sA = zeroAfter ? 0 : Math.floor(random() * 2000);
        rows.push(
          row(
            `k${r}`,
            sB,
            sA,
            Math.floor(sB * random() * 0.2),
            Math.floor(sA * random() * 0.2),
          ),
        );
      }
      const metric = (["keyEvents", "sessions", "revenue"] as const)[i % 3]!;
      const totalBefore =
        rows.reduce(
          (s, x) =>
            s + (metric === "sessions" ? x.sessionsBefore : x.valueBefore),
          0,
        ) + Math.floor(random() * 100);
      const totalAfter =
        rows.reduce(
          (s, x) =>
            s + (metric === "sessions" ? x.sessionsAfter : x.valueAfter),
          0,
        ) + Math.floor(random() * 100);
      const perDay = i % 4 === 0 ? { before: 30, after: 31 } : undefined;
      const result = decompose({
        metric,
        dimension: "channel",
        rows,
        totalBefore,
        totalAfter,
        top: 1 + Math.floor(random() * 12),
        perDay,
      });
      expect(Math.abs(explained(result) - result.delta)).toBeLessThanOrEqual(
        1e-6,
      );
      for (const component of result.components) {
        expect(component.total).toBeCloseTo(
          component.volume + component.rate,
          9,
        );
      }
      if (metric === "sessions") {
        for (const component of result.components)
          expect(component.rate).toBe(0);
      }
    }
  });

  it("splits volume and rate as (sA − sB)·rb and sA·(ra − rb)", () => {
    const result = decompose({
      metric: "keyEvents",
      dimension: "channel",
      rows: [row("Organic Search", 100, 150, 10, 30)],
      totalBefore: 10,
      totalAfter: 30,
    });
    const [component] = result.components;
    expect(component!.volume).toBeCloseTo(50 * 0.1, 9);
    expect(component!.rate).toBeCloseTo(150 * (0.2 - 0.1), 9);
    expect(component!.total).toBeCloseTo(20, 9);
    expect(component!.share).toBeCloseTo(1, 9);
    expect(result.residual).toBeCloseTo(0, 9);
  });

  it("handles zero sessions before or after", () => {
    const result = decompose({
      metric: "keyEvents",
      dimension: "channel",
      rows: [row("New", 0, 40, 0, 8), row("Gone", 50, 0, 5, 0)],
      totalBefore: 5,
      totalAfter: 8,
    });
    const fresh = result.components.find((c) => c.key === "New")!;
    expect(fresh.rateBefore).toBeNull();
    expect(fresh.rateAfter).toBeCloseTo(0.2, 9);
    expect(fresh.volume).toBe(0);
    expect(fresh.rate).toBeCloseTo(8, 9);
    const gone = result.components.find((c) => c.key === "Gone")!;
    expect(gone.rateAfter).toBeNull();
    expect(gone.volume).toBeCloseTo(-5, 9);
    expect(gone.rate).toBe(0);
    expect(Math.abs(explained(result) - result.delta)).toBeLessThanOrEqual(
      1e-6,
    );
  });

  it("gives rate 0 for the sessions metric", () => {
    const result = decompose({
      metric: "sessions",
      dimension: "channel",
      rows: [row("Direct", 100, 80, 100, 80)],
      totalBefore: 100,
      totalAfter: 80,
    });
    expect(result.components[0]!.volume).toBe(-20);
    expect(result.components[0]!.rate).toBe(0);
  });

  it("normalises per day before any math", () => {
    const result = decompose({
      metric: "sessions",
      dimension: "channel",
      rows: [row("Direct", 300, 310, 300, 310)],
      totalBefore: 300,
      totalAfter: 310,
      perDay: { before: 30, after: 31 },
    });
    expect(result.before).toBe(10);
    expect(result.after).toBe(10);
    expect(result.delta).toBe(0);
    expect(result.perDay).toBe(true);
    expect(result.components[0]!.sessionsBefore).toBe(10);
    expect(result.components[0]!.share).toBeNull();
  });

  it("keeps the top components and sums the rest into other", () => {
    const rows = [
      row("a", 10, 60, 10, 60),
      row("b", 10, 40, 10, 40),
      row("c", 10, 20, 10, 20),
      row("d", 10, 15, 10, 15),
    ];
    const result = decompose({
      metric: "sessions",
      dimension: "landingPage",
      rows,
      totalBefore: 40,
      totalAfter: 140,
      top: 2,
    });
    expect(result.components.map((c) => c.key)).toEqual(["a", "b"]);
    expect(result.other).toEqual({ count: 2, volume: 15, rate: 0, total: 15 });
    expect(result.residual).toBeCloseTo(100 - 80 - 15, 9);
    const all = decompose({
      metric: "sessions",
      dimension: "landingPage",
      rows,
      totalBefore: 40,
      totalAfter: 140,
    });
    expect(all.other).toBeNull();
  });
});

describe("decompositionRows", () => {
  it("outer-joins by key and labels with the joined key", () => {
    const rows = decompositionRows(
      [
        { key: ["Organic Search"], values: [100, 50, 10, 5] },
        { key: ["Direct"], values: [40, 20, 2, 0] },
      ],
      [
        { key: ["Organic Search"], values: [120, 60, 12, 6] },
        { key: ["Referral"], values: [10, 5, 1, 0] },
      ],
      { sessions: 0, value: 2 },
    );
    expect(rows).toHaveLength(3);
    expect(rows.find((r) => r.key === "Organic Search")).toEqual(
      row("Organic Search", 100, 120, 10, 12),
    );
    expect(rows.find((r) => r.key === "Direct")).toEqual(
      row("Direct", 40, 0, 2, 0),
    );
    expect(rows.find((r) => r.key === "Referral")).toEqual(
      row("Referral", 0, 10, 0, 1),
    );
  });

  it("joins multi-dimension keys and accepts a custom label", () => {
    const rows = decompositionRows(
      [{ key: ["google", "organic"], values: [5, 1] }],
      [{ key: ["google", "organic"], values: [7, 2] }],
      { sessions: 0, value: 1 },
      (key) => key.join(" via "),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.label).toBe("google via organic");
    expect(rows[0]!.sessionsAfter).toBe(7);
    expect(
      decompositionRows([{ key: ["a", "b"], values: [1, 1] }], [], {
        sessions: 0,
        value: 1,
      })[0]!.label,
    ).toBe("a / b");
  });
});
