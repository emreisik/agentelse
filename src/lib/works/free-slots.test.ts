import { describe, expect, it } from "vitest";
import {
  DEFAULT_SLOT_TIMES,
  parseCronTime,
  suggestSlots,
} from "./free-slots";

const TZ = "Europe/Istanbul";
// 08:00 UTC = 11:00 Istanbul on 2026-10-01.
const NOW = new Date("2026-10-01T08:00:00Z");

describe("suggestSlots", () => {
  it("offers the next three days on an empty calendar", () => {
    const r = suggestSlots({ now: NOW, timezone: TZ, channel: "linkedin", occupied: [] });
    expect(r).toEqual([
      { date: "2026-10-01", time: "12:00" },
      { date: "2026-10-02", time: "10:00" },
      { date: "2026-10-03", time: "10:00" },
    ]);
  });

  it("skips a day occupied by the channel while empty days exist", () => {
    const r = suggestSlots({
      now: NOW,
      timezone: TZ,
      channel: "linkedin",
      occupied: [{ date: "2026-10-02", time: "10:00", channel: "linkedin" }],
    });
    expect(r.map((s) => s.date)).toEqual(["2026-10-01", "2026-10-03", "2026-10-04"]);
  });

  it("is not blocked by another channel", () => {
    const r = suggestSlots({
      now: NOW,
      timezone: TZ,
      channel: "linkedin",
      occupied: [{ date: "2026-10-02", time: "10:00", channel: "x" }],
    });
    expect(r[1]).toEqual({ date: "2026-10-02", time: "10:00" });
  });

  it("uses instagram publish times first", () => {
    const r = suggestSlots({
      now: NOW,
      timezone: TZ,
      channel: "instagram",
      occupied: [],
      publishTimes: ["09:30"],
    });
    expect(r[1]).toEqual({ date: "2026-10-02", time: "09:30" });
    const other = suggestSlots({
      now: NOW,
      timezone: TZ,
      channel: "x",
      occupied: [],
      publishTimes: ["09:30"],
    });
    expect(other[1]!.time).toBe(DEFAULT_SLOT_TIMES[0]);
  });

  it("respects the lead time on the first day", () => {
    // 11:00 local + 60 min lead: 12:00 ok, but with 90 min it moves to 15:00.
    const r = suggestSlots({
      now: NOW,
      timezone: TZ,
      channel: "x",
      occupied: [],
      minLeadMinutes: 90,
    });
    expect(r[0]).toEqual({ date: "2026-10-01", time: "15:00" });
  });

  it("moves to the next day when no time is left today", () => {
    const late = new Date("2026-10-01T16:30:00Z"); // 19:30 Istanbul
    const r = suggestSlots({ now: late, timezone: TZ, channel: "x", occupied: [] });
    expect(r[0]).toEqual({ date: "2026-10-02", time: "10:00" });
  });

  it("falls back to days with one piece, avoiding its time", () => {
    const occupied = Array.from({ length: 4 }, (_, i) => ({
      date: `2026-10-0${i + 1}`,
      time: "10:00",
      channel: "x",
    }));
    const r = suggestSlots({
      now: NOW,
      timezone: TZ,
      channel: "x",
      occupied,
      horizonDays: 3,
    });
    // Empty days 5.. are beyond the horizon (Oct 4), so one-piece days fill in.
    expect(r.length).toBe(3);
    for (const s of r) expect(s.time).not.toBe("10:00");
  });

  it("never offers days with two pieces and stops at the horizon", () => {
    const occupied = ["2026-10-01", "2026-10-02"].flatMap((date) => [
      { date, time: "10:00", channel: "x" },
      { date, time: "12:00", channel: "x" },
    ]);
    const r = suggestSlots({
      now: NOW,
      timezone: TZ,
      channel: "x",
      occupied,
      horizonDays: 2,
    });
    expect(r).toEqual([{ date: "2026-10-03", time: "10:00" }]);
    expect(
      suggestSlots({ now: NOW, timezone: TZ, channel: "x", occupied, horizonDays: 0 }),
    ).toEqual([]);
  });

  it("honours startFrom and returns unique ordered dates", () => {
    const r = suggestSlots({
      now: NOW,
      timezone: TZ,
      channel: "x",
      occupied: [],
      startFrom: "2026-10-10",
      count: 4,
    });
    expect(r.map((s) => s.date)).toEqual([
      "2026-10-10",
      "2026-10-11",
      "2026-10-12",
      "2026-10-13",
    ]);
  });

  it("uses the project day, not the UTC day", () => {
    const n = new Date("2026-10-01T12:00:00Z"); // Oct 2, 02:00 in Kiritimati
    const far = suggestSlots({
      now: n,
      timezone: "Pacific/Kiritimati",
      channel: "x",
      occupied: [],
    });
    const utc = suggestSlots({ now: n, timezone: "UTC", channel: "x", occupied: [] });
    expect(far[0]).toEqual({ date: "2026-10-02", time: "10:00" });
    expect(utc[0]).toEqual({ date: "2026-10-01", time: "15:00" });
  });
});

describe("parseCronTime", () => {
  it("parses M H * * *", () => {
    expect(parseCronTime("30 9 * * *")).toBe("09:30");
    expect(parseCronTime("0 18 * * *")).toBe("18:00");
  });
  it("rejects missing or malformed input", () => {
    expect(parseCronTime(null)).toBeNull();
    expect(parseCronTime(undefined)).toBeNull();
    expect(parseCronTime("")).toBeNull();
    expect(parseCronTime("*/5 * * * *")).toBeNull();
    expect(parseCronTime("30 * * * *")).toBeNull();
    expect(parseCronTime("61 9 * * *")).toBeNull();
    expect(parseCronTime("0 24 * * *")).toBeNull();
    expect(parseCronTime("9")).toBeNull();
  });
});
