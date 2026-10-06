import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/prisma", () => ({ prisma: {} }));
vi.mock("@/server/ideas/idea-engine", () => ({
  IDEA_LOW_WATER: 8,
  IDEA_POOL_TARGET: 20,
  IDEAS_PER_CALL: 6,
  IdeaEngine: { generate: vi.fn() },
}));
vi.mock("@/server/repositories/agency-loop-state.repository", () => ({
  isProjectAgencyActive: vi.fn(),
}));
vi.mock("@/server/works/flag", () => ({ isWorksEnabled: vi.fn(() => true) }));
vi.mock("@/server/ideas/idea-modules", () => ({ moduleRefillIfDue: vi.fn() }));

const {
  refillDue,
  refillCount,
  lowWaterOf,
  REFILL_INTERVAL_MS,
  REFILL_RETRY_MS,
} = await import("./idea-refill");

const NOW = new Date("2026-10-06T12:00:00Z");
const ago = (ms: number) => new Date(NOW.getTime() - ms);

describe("pool refill", () => {
  it("is due only below the low-water mark", () => {
    expect(refillDue({ fresh: 8, lowWater: 8, last: null, now: NOW })).toBe(
      false,
    );
    expect(refillDue({ fresh: 7, lowWater: 8, last: null, now: NOW })).toBe(
      true,
    );
  });

  it("is never due while the pool has no room left", () => {
    expect(
      refillDue({ fresh: 0, lowWater: 8, last: null, now: NOW, room: 0 }),
    ).toBe(false);
    expect(
      refillDue({ fresh: 0, lowWater: 8, last: null, now: NOW, room: 3 }),
    ).toBe(true);
  });

  it("waits hours after a good run, an hour after a failed one", () => {
    const good = { createdAt: ago(REFILL_INTERVAL_MS - 1), status: "OK" };
    const failed = { createdAt: ago(REFILL_RETRY_MS - 1), status: "FAILED" };
    expect(refillDue({ fresh: 2, lowWater: 8, last: good, now: NOW })).toBe(
      false,
    );
    expect(
      refillDue({
        fresh: 2,
        lowWater: 8,
        last: { ...good, createdAt: ago(REFILL_INTERVAL_MS) },
        now: NOW,
      }),
    ).toBe(true);
    expect(refillDue({ fresh: 2, lowWater: 8, last: failed, now: NOW })).toBe(
      false,
    );
    expect(
      refillDue({
        fresh: 2,
        lowWater: 8,
        last: { ...failed, createdAt: ago(REFILL_RETRY_MS) },
        now: NOW,
      }),
    ).toBe(true);
  });

  it("asks for up to the target, never past the pool size, one call at a time", () => {
    expect(refillCount({ fresh: 2, poolSize: 20, unlimited: false })).toBe(6);
    expect(refillCount({ fresh: 17, poolSize: 20, unlimited: false })).toBe(3);
    expect(refillCount({ fresh: 4, poolSize: 5, unlimited: false })).toBe(1);
    expect(refillCount({ fresh: 25, poolSize: 5, unlimited: true })).toBe(0);
  });

  it("lowers the low-water mark for a small pool", () => {
    expect(lowWaterOf(20, false)).toBe(8);
    expect(lowWaterOf(5, false)).toBe(5);
    expect(lowWaterOf(5, true)).toBe(8);
  });
});
