import { describe, expect, it } from "vitest";

import {
  ENGINE_RECHECK_MS,
  goalsDue,
  monthlyCandidate,
  monthlyDue,
  monthlyWaitUntil,
  pulseCandidate,
  reportBackoffMs,
  waitingFor,
  weeklyCandidate,
  weeklyDue,
  weeklyWaitUntil,
} from "./schedule";

// Hafta W = 2026-09-28 (Pazartesi); rapor Çarşamba 2026-10-07 09:00'dan itibaren.
const W = "2026-09-28";
const TZ = "Europe/Istanbul";

function weekly(
  localDay: string,
  localTime: string,
  extra: { engineWaits?: boolean; engineWeek?: string | null } = {},
) {
  return weeklyDue({
    week: W,
    localDay,
    localTime,
    engineWaits: extra.engineWaits ?? false,
    engineWeek: extra.engineWeek ?? null,
  });
}

describe("weeklyCandidate", () => {
  it("is the last complete week once its summaries are fetched", () => {
    expect(
      weeklyCandidate({
        finalThrough: "2026-10-05",
        lastWeeklyWeek: W,
        doneWeek: null,
      }),
    ).toBe(W);
  });

  it("needs lastWeeklyWeek >= W", () => {
    expect(
      weeklyCandidate({
        finalThrough: "2026-10-05",
        lastWeeklyWeek: "2026-09-21",
        doneWeek: null,
      }),
    ).toBeNull();
    expect(
      weeklyCandidate({
        finalThrough: "2026-10-05",
        lastWeeklyWeek: null,
        doneWeek: null,
      }),
    ).toBeNull();
  });

  it("is null once the week is done", () => {
    expect(
      weeklyCandidate({
        finalThrough: "2026-10-05",
        lastWeeklyWeek: W,
        doneWeek: W,
      }),
    ).toBeNull();
    expect(
      weeklyCandidate({
        finalThrough: "2026-10-05",
        lastWeeklyWeek: W,
        doneWeek: "2026-09-21",
      }),
    ).toBe(W);
  });
});

describe("weeklyDue", () => {
  it("waits until Wednesday 09:00", () => {
    expect(weekly("2026-10-06", "12:00")).toBe("wait");
    expect(weekly("2026-10-07", "08:59")).toBe("wait");
    expect(weekly("2026-10-07", "09:00")).toBe("due");
  });

  it("is still due on Thursday 08:00 when the engine is not awaited", () => {
    expect(weekly("2026-10-08", "08:00")).toBe("due");
  });

  it("waits for a lagging engine until Thursday 09:00", () => {
    const lagging = { engineWaits: true, engineWeek: "2026-09-21" };
    expect(weekly("2026-10-07", "09:00", lagging)).toBe("wait");
    expect(weekly("2026-10-08", "08:59", lagging)).toBe("wait");
    expect(weekly("2026-10-08", "09:00", lagging)).toBe("due");
    expect(weekly("2026-10-07", "09:00", { engineWaits: true, engineWeek: W })).toBe(
      "due",
    );
    expect(weekly("2026-10-07", "09:00", { engineWaits: true, engineWeek: null })).toBe(
      "wait",
    );
  });

  it("is stale after 20 days", () => {
    expect(weekly("2026-10-18", "10:00")).toBe("due");
    expect(weekly("2026-10-19", "10:00")).toBe("stale");
  });
});

describe("weeklyWaitUntil", () => {
  it("is Wednesday 09:00 project time before the due moment", () => {
    const until = weeklyWaitUntil({
      week: W,
      timezone: TZ,
      now: new Date("2026-10-06T12:00:00Z"),
      engineLagging: false,
    });
    expect(until.toISOString()).toBe("2026-10-07T06:00:00.000Z");
  });

  it("is an hour later when the engine lags after Wednesday", () => {
    const now = new Date("2026-10-07T07:00:00Z");
    const until = weeklyWaitUntil({
      week: W,
      timezone: TZ,
      now,
      engineLagging: true,
    });
    expect(until.getTime()).toBe(now.getTime() + ENGINE_RECHECK_MS);
  });

  it("is capped by Thursday 09:00", () => {
    const until = weeklyWaitUntil({
      week: W,
      timezone: TZ,
      now: new Date("2026-10-08T05:30:00Z"),
      engineLagging: true,
    });
    expect(until.toISOString()).toBe("2026-10-08T06:00:00.000Z");
  });
});

describe("monthlyCandidate", () => {
  it("is the last complete month", () => {
    expect(
      monthlyCandidate({
        finalThrough: "2026-10-05",
        lastMonthlyMonth: "2026-09-01",
        doneMonth: "2026-08-01",
      }),
    ).toBe("2026-09-01");
  });

  it("needs the monthly summaries and no earlier run", () => {
    expect(
      monthlyCandidate({
        finalThrough: "2026-10-05",
        lastMonthlyMonth: "2026-08-01",
        doneMonth: null,
      }),
    ).toBeNull();
    expect(
      monthlyCandidate({
        finalThrough: "2026-10-05",
        lastMonthlyMonth: "2026-09-01",
        doneMonth: "2026-09-01",
      }),
    ).toBeNull();
  });
});

describe("monthlyDue", () => {
  const M = "2026-09-01";

  it("is due from the 4th at 09:00 and still on the 5th at 08:00", () => {
    expect(monthlyDue({ month: M, localDay: "2026-10-03", localTime: "23:59" })).toBe(
      "wait",
    );
    expect(monthlyDue({ month: M, localDay: "2026-10-04", localTime: "08:59" })).toBe(
      "wait",
    );
    expect(monthlyDue({ month: M, localDay: "2026-10-04", localTime: "09:00" })).toBe(
      "due",
    );
    expect(monthlyDue({ month: M, localDay: "2026-10-05", localTime: "08:00" })).toBe(
      "due",
    );
  });

  it("is stale after the 27th day", () => {
    expect(monthlyDue({ month: M, localDay: "2026-10-27", localTime: "12:00" })).toBe(
      "due",
    );
    expect(monthlyDue({ month: M, localDay: "2026-10-28", localTime: "12:00" })).toBe(
      "stale",
    );
  });
});

describe("monthlyWaitUntil", () => {
  it("is the 4th at 09:00 project time", () => {
    expect(
      monthlyWaitUntil({ month: "2026-09-01", timezone: TZ }).toISOString(),
    ).toBe("2026-10-04T06:00:00.000Z");
  });
});

describe("pulseCandidate", () => {
  it("is the newest final day", () => {
    expect(
      pulseCandidate({
        finalThrough: "2026-10-05",
        donePulse: null,
        today: "2026-10-06",
      }),
    ).toBe("2026-10-05");
  });

  it("skips a day already looked at", () => {
    expect(
      pulseCandidate({
        finalThrough: "2026-10-05",
        donePulse: "2026-10-05",
        today: "2026-10-06",
      }),
    ).toBeNull();
  });

  it("skips a final day older than four days", () => {
    expect(
      pulseCandidate({
        finalThrough: "2026-10-05",
        donePulse: null,
        today: "2026-10-09",
      }),
    ).toBe("2026-10-05");
    expect(
      pulseCandidate({
        finalThrough: "2026-10-05",
        donePulse: null,
        today: "2026-10-10",
      }),
    ).toBeNull();
  });
});

describe("goalsDue", () => {
  it("is due when the final day moved forward", () => {
    expect(goalsDue({ finalThrough: "2026-10-05", doneGoalsDay: null })).toBe(true);
    expect(goalsDue({ finalThrough: "2026-10-05", doneGoalsDay: "2026-10-04" })).toBe(
      true,
    );
    expect(goalsDue({ finalThrough: "2026-10-05", doneGoalsDay: "2026-10-05" })).toBe(
      false,
    );
  });
});

describe("waitingFor", () => {
  const now = new Date("2026-10-07T05:00:00Z");
  const until = new Date("2026-10-07T06:00:00Z");

  it("waits only for the recorded period before the recorded moment", () => {
    expect(waitingFor(W, W, until, now)).toBe(true);
    expect(waitingFor(W, W, until, until)).toBe(false);
    expect(waitingFor("2026-10-05", W, until, now)).toBe(false);
    expect(waitingFor(W, null, until, now)).toBe(false);
    expect(waitingFor(W, W, null, now)).toBe(false);
  });
});

describe("reportBackoffMs", () => {
  it("doubles from ten minutes and caps at six hours", () => {
    expect(reportBackoffMs(0)).toBe(0);
    expect(reportBackoffMs(-3)).toBe(0);
    expect(reportBackoffMs(1)).toBe(600_000);
    expect(reportBackoffMs(2)).toBe(1_200_000);
    expect(reportBackoffMs(6)).toBe(19_200_000);
    expect(reportBackoffMs(7)).toBe(21_600_000);
    expect(reportBackoffMs(40)).toBe(21_600_000);
  });
});
