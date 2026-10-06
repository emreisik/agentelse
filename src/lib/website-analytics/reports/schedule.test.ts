import { describe, expect, it } from "vitest";

import {
  GA_REPORT_MAX_ATTEMPTS,
  attemptKey,
  attemptsOf,
  bumpAttempt,
  clearAttempt,
  goalsDue,
  isoWeekdayOf,
  monthlyReportDue,
  narrativeModeFor,
  nextMonthKey,
  planDue,
  previousMonthKey,
  pulseDue,
  readAttempts,
  weeklyReportDue,
} from "./schedule";

// Bu dosyanın kanıtladığı: haftalık, aylık, plan ve nabız zamanlaması
// (08:00 yerel saat, veri gelene dek bekleme, bayatlama), hedef yenileme
// kararı ve deneme sayacı; hepsi saf fonksiyon.

function weekly(
  localNow: string,
  extra: Partial<Parameters<typeof weeklyReportDue>[0]> = {},
) {
  return weeklyReportDue({
    localNow,
    weekday: 1,
    completeThrough: "2026-10-04",
    lastWeek: null,
    insightsOn: false,
    insightsWeek: null,
    ...extra,
  });
}

describe("calendar helpers", () => {
  it("numbers weekdays from Monday (1) to Sunday (7)", () => {
    expect(isoWeekdayOf("2026-10-05")).toBe(1);
    expect(isoWeekdayOf("2026-10-11")).toBe(7);
    expect(isoWeekdayOf("2026-10-09")).toBe(5);
  });

  it("moves month keys across years", () => {
    expect(nextMonthKey("2026-12")).toBe("2027-01");
    expect(nextMonthKey("2026-09")).toBe("2026-10");
    expect(previousMonthKey("2027-01")).toBe("2026-12");
    expect(previousMonthKey("2026-10")).toBe("2026-09");
  });
});

describe("weeklyReportDue", () => {
  it("is still in the previous cycle before 08:00 on the report day", () => {
    const due = weekly("2026-10-05T07:59", { completeThrough: "2026-09-27" });
    expect(due.week).toEqual({ monday: "2026-09-21", sunday: "2026-09-27" });
    expect(due.dueAt).toBe("2026-09-28T08:00");
    // O döngünün raporu 6 günden fazladır beklemiştir: bayat.
    expect(due.state).toBe("stale");
    expect(
      weekly("2026-10-05T07:59", { lastWeek: "2026-09-21" }).state,
    ).toBe("done");
  });

  it("is due on Monday 08:00 once Sunday's data has arrived", () => {
    const due = weekly("2026-10-05T08:00");
    expect(due.week).toEqual({ monday: "2026-09-28", sunday: "2026-10-04" });
    expect(due.dueAt).toBe("2026-10-05T08:00");
    expect(due.state).toBe("due");
    expect(due.insights).toBe("off");
  });

  it("waits for data until Sunday is complete", () => {
    expect(weekly("2026-10-05T09:00", { completeThrough: "2026-10-03" }).state).toBe(
      "wait_data",
    );
    expect(weekly("2026-10-05T09:00", { completeThrough: null }).state).toBe(
      "wait_data",
    );
  });

  it("waits for the GA-F4 weekly analysis for 24 hours, then posts pending", () => {
    const base = { insightsOn: true, insightsWeek: "2026-09-21" };
    const waiting = weekly("2026-10-05T10:00", base);
    expect(waiting.state).toBe("wait_insights");
    expect(waiting.insights).toBe("pending");
    const late = weekly("2026-10-06T08:00", base);
    expect(late.state).toBe("due");
    expect(late.insights).toBe("pending");
    const ready = weekly("2026-10-05T10:00", {
      insightsOn: true,
      insightsWeek: "2026-09-28",
    });
    expect(ready.state).toBe("due");
    expect(ready.insights).toBe("on");
  });

  it("is done once the week was reported", () => {
    const done = weekly("2026-10-05T10:00", { lastWeek: "2026-09-28" });
    expect(done.state).toBe("done");
    expect(weekly("2026-10-05T10:00", { lastWeek: "2026-10-05" }).state).toBe(
      "done",
    );
  });

  it("goes stale six days after the due time", () => {
    expect(
      weekly("2026-10-10T23:59", { completeThrough: null }).state,
    ).toBe("wait_data");
    expect(weekly("2026-10-11T08:00", { completeThrough: null }).state).toBe(
      "stale",
    );
    expect(weekly("2026-10-11T08:00").state).toBe("stale");
  });

  it("honours a different weekday", () => {
    const due = weekly("2026-10-09T09:00", { weekday: 5 });
    expect(due.week).toEqual({ monday: "2026-09-28", sunday: "2026-10-04" });
    expect(due.dueAt).toBe("2026-10-09T08:00");
    expect(due.state).toBe("due");
  });

  it("crosses the year boundary", () => {
    const due = weekly("2027-01-04T08:00", { completeThrough: "2027-01-03" });
    expect(due.week).toEqual({ monday: "2026-12-28", sunday: "2027-01-03" });
    expect(due.state).toBe("due");
  });
});

describe("monthlyReportDue", () => {
  const input = (
    localNow: string,
    extra: Partial<Parameters<typeof monthlyReportDue>[0]> = {},
  ) =>
    monthlyReportDue({
      localNow,
      day: 2,
      completeThrough: "2026-09-30",
      lastMonth: null,
      ...extra,
    });

  it("is due on day 2 at 08:00 for the previous month", () => {
    const early = input("2026-10-02T07:59");
    expect(early.month).toBe("2026-08");
    const due = input("2026-10-02T08:00");
    expect(due.month).toBe("2026-09");
    expect(due.dueAt).toBe("2026-10-02T08:00");
    expect(due.state).toBe("due");
  });

  it("waits until the data reaches the month end", () => {
    expect(input("2026-10-02T09:00", { completeThrough: "2026-09-29" }).state).toBe(
      "wait_data",
    );
    expect(input("2026-10-02T09:00", { completeThrough: null }).state).toBe(
      "wait_data",
    );
  });

  it("is done when the month was reported and stale after 10 days", () => {
    expect(input("2026-10-02T09:00", { lastMonth: "2026-09" }).state).toBe("done");
    expect(input("2026-10-12T07:59").state).toBe("due");
    expect(input("2026-10-12T08:00").state).toBe("stale");
  });

  it("reports December in January", () => {
    const due = input("2027-01-02T08:00", { completeThrough: "2026-12-31" });
    expect(due.month).toBe("2026-12");
    expect(due.state).toBe("due");
  });

  it("honours a custom day", () => {
    const due = input("2026-10-05T08:00", { day: 5 });
    expect(due.month).toBe("2026-09");
    expect(due.dueAt).toBe("2026-10-05T08:00");
  });
});

describe("planDue", () => {
  const input = (
    localNow: string,
    extra: Partial<Parameters<typeof planDue>[0]> = {},
  ) =>
    planDue({
      localNow,
      day: 2,
      enabled: true,
      lastPlanMonth: null,
      monthlyState: "done",
      historyDays: 120,
      ...extra,
    });

  it("is off when disabled", () => {
    expect(input("2026-10-02T09:00", { enabled: false })).toEqual({
      month: null,
      state: "off",
    });
  });

  it("is not yet on day 1 with a monthly day of 2", () => {
    expect(input("2026-10-01T12:00")).toEqual({
      month: "2026-10",
      state: "not_yet",
    });
    expect(input("2026-10-02T07:59").state).toBe("not_yet");
  });

  it("targets the current month early on and waits for the monthly report", () => {
    const waiting = input("2026-10-02T08:30", { monthlyState: "due" });
    expect(waiting).toEqual({ month: "2026-10", state: "wait_monthly" });
    expect(
      input("2026-10-02T08:30", { monthlyState: "wait_data" }).state,
    ).toBe("wait_monthly");
    expect(input("2026-10-02T08:30", { monthlyState: "done" })).toEqual({
      month: "2026-10",
      state: "due",
    });
    expect(input("2026-10-10T20:00").month).toBe("2026-10");
  });

  it("targets the next month after day 10 without waiting", () => {
    expect(input("2026-10-20T09:00", { monthlyState: "due" })).toEqual({
      month: "2026-11",
      state: "due",
    });
    expect(input("2026-12-11T09:00").month).toBe("2027-01");
  });

  it("is done once the target month has a plan", () => {
    expect(
      input("2026-11-02T09:00", { lastPlanMonth: "2026-11" }),
    ).toEqual({ month: "2026-11", state: "done" });
    expect(input("2026-10-20T09:00", { lastPlanMonth: "2026-11" }).state).toBe(
      "done",
    );
  });

  it("needs 56 days of history", () => {
    expect(input("2026-10-02T09:00", { historyDays: 55 }).state).toBe(
      "short_history",
    );
    expect(input("2026-10-02T09:00", { historyDays: 56 }).state).toBe("due");
  });
});

describe("pulseDue", () => {
  const now = new Date("2026-10-06T10:00:00.000Z");
  const input = (extra: Partial<Parameters<typeof pulseDue>[0]> = {}) =>
    pulseDue({
      propertyToday: "2026-10-06",
      completeThrough: "2026-10-05",
      lastPulseDay: null,
      mode: "notable",
      insightsOn: false,
      insightsDay: null,
      pendingDay: null,
      pendingSince: null,
      now,
      ...extra,
    });

  it("is off when the pulse is off", () => {
    expect(input({ mode: "off" })).toEqual({ day: null, state: "off" });
  });

  it("is not yet when the newest complete day is older than yesterday", () => {
    expect(input({ completeThrough: "2026-10-04" }).state).toBe("not_yet");
    expect(input({ completeThrough: null }).state).toBe("not_yet");
  });

  it("is due once per new day", () => {
    expect(input()).toEqual({ day: "2026-10-05", state: "due" });
    expect(input({ lastPulseDay: "2026-10-05" })).toEqual({
      day: "2026-10-05",
      state: "done",
    });
  });

  it("waits for the daily analysis for up to 3 hours", () => {
    const base = { insightsOn: true, insightsDay: "2026-10-04" };
    expect(input(base).state).toBe("wait_insights");
    expect(
      input({
        ...base,
        pendingDay: "2026-10-05",
        pendingSince: new Date(now.getTime() - 3 * 3_600_000),
      }).state,
    ).toBe("due");
    expect(
      input({
        ...base,
        pendingDay: "2026-10-05",
        pendingSince: new Date(now.getTime() - 3_600_000),
      }).state,
    ).toBe("wait_insights");
    expect(input({ ...base, insightsDay: "2026-10-05" }).state).toBe("due");
    expect(input({ insightsOn: true, insightsDay: null }).state).toBe(
      "wait_insights",
    );
  });
});

describe("goalsDue", () => {
  it("runs once per new complete day", () => {
    expect(goalsDue({ completeThrough: null, lastGoalsDay: null })).toBe(false);
    expect(goalsDue({ completeThrough: "2026-10-05", lastGoalsDay: null })).toBe(
      true,
    );
    expect(
      goalsDue({ completeThrough: "2026-10-05", lastGoalsDay: "2026-10-04" }),
    ).toBe(true);
    expect(
      goalsDue({ completeThrough: "2026-10-05", lastGoalsDay: "2026-10-05" }),
    ).toBe(false);
  });
});

describe("attempts", () => {
  it("builds keys and reads tolerantly", () => {
    expect(attemptKey("weekly", "2026-09-28")).toBe("weekly:2026-09-28");
    expect(readAttempts(null)).toEqual({});
    expect(readAttempts("x")).toEqual({});
    expect(readAttempts([1, 2])).toEqual({});
    expect(readAttempts({ a: 1, b: 1.5, c: "2", d: -1, e: 3 })).toEqual({
      a: 1,
      e: 3,
    });
  });

  it("counts, bumps and clears", () => {
    expect(attemptsOf({}, "a")).toBe(0);
    const once = bumpAttempt({}, "a");
    expect(once).toEqual({ a: 1 });
    expect(bumpAttempt(once, "a")).toEqual({ a: 2 });
    expect(attemptsOf(bumpAttempt(once, "a"), "a")).toBe(2);
    expect(clearAttempt({ a: 2, b: 1 }, "a")).toEqual({ b: 1 });
    expect(GA_REPORT_MAX_ATTEMPTS).toBe(5);
  });

  it("keeps the 12 most recently bumped keys", () => {
    let attempts: Record<string, number> = {};
    for (let i = 0; i < 15; i += 1) attempts = bumpAttempt(attempts, `k${i}`);
    expect(Object.keys(attempts)).toHaveLength(12);
    expect(attempts.k0).toBeUndefined();
    expect(attempts.k2).toBeUndefined();
    expect(attempts.k3).toBe(1);
    expect(attempts.k14).toBe(1);
    // Yeniden artırılan anahtar en yeniye taşınır.
    attempts = bumpAttempt(attempts, "k3");
    attempts = bumpAttempt(attempts, "new");
    expect(attempts.k3).toBe(2);
    expect(attempts.k4).toBeUndefined();
  });
});

describe("narrativeModeFor", () => {
  it("skips after repeated failures, defers without budget, else allows", () => {
    expect(narrativeModeFor({ attempts: 0, llmBudget: 2 })).toBe("allow");
    expect(narrativeModeFor({ attempts: 1, llmBudget: 1 })).toBe("allow");
    expect(narrativeModeFor({ attempts: 0, llmBudget: 0 })).toBe("defer");
    expect(narrativeModeFor({ attempts: 2, llmBudget: 2 })).toBe("skip");
    expect(narrativeModeFor({ attempts: 3, llmBudget: 0 })).toBe("skip");
  });
});
