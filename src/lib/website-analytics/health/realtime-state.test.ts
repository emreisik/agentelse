import { describe, expect, it } from "vitest";

import {
  GA_RT_EVERY_MS,
  nextRealtimeState,
  realtimeProbeDue,
} from "./realtime-state";
import type { GaRealtimeState } from "./types";

// Bu dosyanın kanıtladığı: ölçüm yalnız 09:00–21:00 arasında ve 240
// oturum/gün tabanının üstünde; aynı gün iki ölçüm arası en az 50 dakika;
// force yalnız bu aralığı atlar; yeni gün sayaçları sıfırlar; sıfır
// okumalar art arda birikir, sıfır olmayan okuma diziyi keser.

const TODAY = "2026-10-06";
const NOW = new Date("2026-10-06T10:00:00.000Z");

function state(overrides: Partial<GaRealtimeState> = {}): GaRealtimeState {
  return {
    v: 1,
    day: TODAY,
    zeros: 1,
    checks: 1,
    lastAt: new Date(NOW.getTime() - 10 * 60_000).toISOString(),
    lastActive: 0,
    expected: 300,
    ...overrides,
  };
}

const due = (
  current: GaRealtimeState | null,
  overrides: Partial<Parameters<typeof realtimeProbeDue>[1]> = {},
) =>
  realtimeProbeDue(current, {
    today: TODAY,
    hour: 12,
    now: NOW,
    expectedDailySessions: 300,
    ...overrides,
  });

describe("realtimeProbeDue", () => {
  it("runs only between 09:00 and 21:00", () => {
    expect(due(null, { hour: 8 })).toBe(false);
    expect(due(null, { hour: 9 })).toBe(true);
    expect(due(null, { hour: 20 })).toBe(true);
    expect(due(null, { hour: 21 })).toBe(false);
  });

  it("needs at least 240 expected sessions a day", () => {
    expect(due(null, { expectedDailySessions: 239 })).toBe(false);
    expect(due(null, { expectedDailySessions: 240 })).toBe(true);
    expect(due(null, { expectedDailySessions: null })).toBe(false);
  });

  it("keeps 50 minutes between readings on the same day", () => {
    expect(due(state())).toBe(false);
    expect(
      due(
        state({
          lastAt: new Date(NOW.getTime() - GA_RT_EVERY_MS).toISOString(),
        }),
      ),
    ).toBe(true);
    expect(due(state({ day: "2026-10-05" }))).toBe(true);
    expect(due(state({ lastAt: null }))).toBe(true);
  });

  it("lets force bypass the spacing but not the floor or the hours", () => {
    expect(due(state(), { force: true })).toBe(true);
    expect(due(state(), { force: true, expectedDailySessions: 100 })).toBe(
      false,
    );
    expect(due(state(), { force: true, hour: 22 })).toBe(false);
  });
});

describe("nextRealtimeState", () => {
  it("starts a new day from scratch", () => {
    const next = nextRealtimeState(
      state({ day: "2026-10-05", zeros: 2, checks: 5 }),
      {
        today: TODAY,
        now: NOW,
        activeUsers: 0,
        expected: 310,
      },
    );
    expect(next).toEqual({
      v: 1,
      day: TODAY,
      zeros: 1,
      checks: 1,
      lastAt: NOW.toISOString(),
      lastActive: 0,
      expected: 310,
    });
    expect(
      nextRealtimeState(null, {
        today: TODAY,
        now: NOW,
        activeUsers: 4,
        expected: null,
      }),
    ).toEqual({
      v: 1,
      day: TODAY,
      zeros: 0,
      checks: 1,
      lastAt: NOW.toISOString(),
      lastActive: 4,
      expected: null,
    });
  });

  it("counts a zero streak and resets it on activity", () => {
    const input = { today: TODAY, now: NOW, expected: 300 };
    const second = nextRealtimeState(state({ zeros: 1, checks: 1 }), {
      ...input,
      activeUsers: 0,
    });
    const third = nextRealtimeState(second, { ...input, activeUsers: 0 });
    expect(third.zeros).toBe(3);
    expect(third.checks).toBe(3);
    const active = nextRealtimeState(third, { ...input, activeUsers: 7 });
    expect(active.zeros).toBe(0);
    expect(active.checks).toBe(4);
    expect(active.lastActive).toBe(7);
  });
});
