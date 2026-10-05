import { describe, expect, it } from "vitest";

import {
  WEEKLY_DRAFT_COPY,
  handsOnLevelFor,
  weekOfWeeklyWork,
  weekRangeLabel,
  weeklyCommandId,
  weeklyDraftOn,
  weeklyDraftTarget,
  weeklyWorkId,
} from "./weekly-draft";

// What this suite proves: the weekly draft is made only on Sunday from 18:00
// local time, for the next Monday; its ids are deterministic, short enough for
// every id guard and never look like a Today Work; the chat line carries no
// idea text; and the Settings switch maps onto the hands-on level.

describe("weeklyDraftTarget", () => {
  it("targets next Monday on Sunday from 18:00, and nothing else", () => {
    // 2026-10-04 is a Sunday.
    expect(weeklyDraftTarget("2026-10-04T18:00")).toBe("2026-10-05");
    expect(weeklyDraftTarget("2026-10-04T23:59")).toBe("2026-10-05");
    expect(weeklyDraftTarget("2026-10-04T17:59")).toBeNull();
    expect(weeklyDraftTarget("2026-10-03T20:00")).toBeNull();
    expect(weeklyDraftTarget("2026-10-05T09:00")).toBeNull();
    expect(weeklyDraftTarget("not a time")).toBeNull();
  });

  it("crosses a month and a year", () => {
    expect(weeklyDraftTarget("2026-05-31T19:00")).toBe("2026-06-01");
    expect(weeklyDraftTarget("2028-12-31T19:00")).toBe("2029-01-01");
  });
});

describe("weekly ids", () => {
  const projectId = "cmg1234567890abcdefghijkl";

  it("are deterministic, guard-safe and round-trip the week", () => {
    const workId = weeklyWorkId(projectId, "2026-10-05");
    expect(workId).toBe(`wkplan_${projectId}_2026-10-05`);
    expect(workId.length).toBeLessThanOrEqual(64);
    expect(workId).toMatch(/^[A-Za-z0-9_-]{1,64}$/);
    expect(workId.startsWith("today_")).toBe(false);
    expect(weeklyCommandId(projectId, "2026-10-05").length).toBeLessThanOrEqual(
      64,
    );
    expect(weekOfWeeklyWork(projectId, workId)).toBe("2026-10-05");
    expect(weekOfWeeklyWork(projectId, "wkplan_other_2026-10-05")).toBeNull();
    expect(weekOfWeeklyWork(projectId, `wkplan_${projectId}_bad`)).toBeNull();
  });
});

describe("weekRangeLabel and the copy", () => {
  it("labels the week inside one month and across two", () => {
    expect(weekRangeLabel("2026-10-05")).toBe("5–11 Oct");
    expect(weekRangeLabel("2026-09-28")).toBe("28 Sep – 4 Oct");
  });

  it("gives the chat a non-default title and a fixed line with counts and dates only", () => {
    expect(WEEKLY_DRAFT_COPY.workTitle("2026-10-05")).toBe(
      "Weekly plan · 5–11 Oct",
    );
    expect(
      WEEKLY_DRAFT_COPY.workTitle("2026-10-05").length,
    ).toBeLessThanOrEqual(60);
    const reply = WEEKLY_DRAFT_COPY.reply(3, "2026-10-05");
    expect(reply).toContain("3 posts");
    expect(reply).toContain("Nothing is made or posted before you approve.");
    expect(WEEKLY_DRAFT_COPY.reply(1, "2026-10-05")).toContain("1 post.");
  });
});

describe("the Weekly plan draft switch", () => {
  it("reads on unless the agency waits for the client", () => {
    expect(weeklyDraftOn("AUTOPILOT")).toBe(true);
    expect(weeklyDraftOn("CREATE_AUTOMATICALLY")).toBe(true);
    expect(weeklyDraftOn(null)).toBe(true);
    expect(weeklyDraftOn("REVIEW_EVERYTHING")).toBe(false);
  });

  it("writes REVIEW_EVERYTHING when off and keeps an acting level when on", () => {
    expect(handsOnLevelFor(false, "AUTOPILOT")).toBe("REVIEW_EVERYTHING");
    expect(handsOnLevelFor(true, "REVIEW_EVERYTHING")).toBe("AUTOPILOT");
    expect(handsOnLevelFor(true, "CREATE_AUTOMATICALLY")).toBe(
      "CREATE_AUTOMATICALLY",
    );
    expect(handsOnLevelFor(true, null)).toBe("AUTOPILOT");
  });
});
