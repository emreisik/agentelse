import { describe, expect, it } from "vitest";

import { addDaysToKey } from "./grid";
import { sourceOf } from "./source";
import {
  EMPTY_FILTER,
  dayDots,
  filterItems,
  groupForSort,
  isFiltering,
  matchesQuery,
  relativeDayLabel,
  sortItems,
} from "./panel-view";
import { item } from "./test-fixtures";

const ig = item({ id: "ig", title: "Autumn launch" });
const tt = item({
  id: "tt",
  title: "Behind the scenes",
  label: "TikTok · Video",
  source: sourceOf("tiktok", null),
  glyph: "video",
  localDay: "2026-10-05",
  localTime: "18:00",
  stage: "needs-approval",
});
const failed = item({
  id: "fb",
  title: "Weekend offer",
  label: "Facebook",
  source: sourceOf(null, "facebook"),
  glyph: null,
  localDay: "2026-10-07",
  localTime: "09:00",
  stage: "failed",
});
const tray = item({ id: "tray", title: null, preview: "Draft caption", localDay: null, localTime: null, scheduledFor: null });
const all = [ig, tt, failed, tray];

describe("panel filters", () => {
  it("matches every search word across title, preview and platform", () => {
    expect(matchesQuery(ig, "autumn insta")).toBe(true);
    expect(matchesQuery(ig, "autumn tiktok")).toBe(false);
    expect(matchesQuery(tray, "caption")).toBe(true);
  });

  it("combines platform, status and format filters", () => {
    const sources = filterItems(all, { ...EMPTY_FILTER, sources: new Set(["tiktok", "facebook"]) });
    expect(sources.map((i) => i.id)).toEqual(["tt", "fb"]);
    const both = filterItems(all, {
      ...EMPTY_FILTER,
      sources: new Set(["tiktok", "facebook"]),
      stages: new Set(["failed"]),
    });
    expect(both.map((i) => i.id)).toEqual(["fb"]);
    const glyphs = filterItems(all, { ...EMPTY_FILTER, glyphs: new Set(["video"]) });
    expect(glyphs.map((i) => i.id)).toEqual(["tt"]);
  });

  it("ignores its own dimension when counting a filter row", () => {
    const filter = { ...EMPTY_FILTER, sources: new Set(["tiktok"]) };
    expect(filterItems(all, filter, "sources")).toHaveLength(4);
    expect(isFiltering(filter)).toBe(true);
    expect(isFiltering(EMPTY_FILTER)).toBe(false);
  });
});

describe("panel sorting and grouping", () => {
  it("orders by day and time, unscheduled last", () => {
    expect(sortItems(all, "soonest").map((i) => i.id)).toEqual(["tt", "fb", "ig", "tray"]);
    expect(sortItems(all, "latest").map((i) => i.id)[0]).toBe("tray");
  });

  it("puts what needs the user first", () => {
    expect(sortItems(all, "attention").map((i) => i.id).slice(0, 2)).toEqual(["fb", "tt"]);
  });

  it("groups by day for date sorts and by stage/platform otherwise", () => {
    const days = groupForSort(all, "soonest");
    expect(days.map((g) => g.key)).toEqual(["2026-10-05", "2026-10-07"]);
    expect(days[1]!.items.map((i) => i.id)).toEqual(["fb", "ig"]);
    expect(groupForSort(all, "latest").map((g) => g.key)).toEqual(["2026-10-07", "2026-10-05"]);
    expect(groupForSort(all, "attention").map((g) => g.key)).toEqual(["failed", "needs-approval", "scheduled"]);
    expect(groupForSort(all, "platform").every((g) => g.kind === "source")).toBe(true);
  });
});

describe("day helpers", () => {
  it("shows one dot per platform colour and flags problems", () => {
    const dots = dayDots([ig, failed, ig]);
    expect(dots.colors).toHaveLength(2);
    expect(dots.total).toBe(3);
    expect(dots.attention).toBe(true);
    expect(dayDots([ig]).attention).toBe(false);
  });

  it("labels nearby days", () => {
    expect(relativeDayLabel("2026-10-03", "2026-10-03", addDaysToKey)).toBe("Today");
    expect(relativeDayLabel("2026-10-04", "2026-10-03", addDaysToKey)).toBe("Tomorrow");
    expect(relativeDayLabel("2026-10-02", "2026-10-03", addDaysToKey)).toBe("Yesterday");
    expect(relativeDayLabel("2026-10-09", "2026-10-03", addDaysToKey)).toBeNull();
  });
});
