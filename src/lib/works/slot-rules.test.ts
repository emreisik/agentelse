import { describe, expect, it } from "vitest";

import {
  MAX_TARGETS_PER_PRESS,
  minutesOf,
  sanitizeClickText,
  slotWhenLabel,
  validateSlotTargets,
  type SlotTargetInput,
} from "./slot-rules";

const TODAY = "2026-10-01";
const NOW = "2026-10-01T10:30";
const target = (over: Partial<SlotTargetInput> = {}): SlotTargetInput => ({
  channel: "instagram",
  formatKey: "instagram.post",
  date: "2026-10-02",
  time: "11:00",
  ...over,
});
const run = (targets: SlotTargetInput[]) =>
  validateSlotTargets({ targets, today: TODAY, nowLocal: NOW });
const code = (targets: SlotTargetInput[]) => {
  const r = run(targets);
  return r.ok ? "ok" : r.code;
};

describe("validateSlotTargets", () => {
  it("accepts a valid target", () => {
    expect(run([target()])).toEqual({ ok: true });
  });
  it("rejects empty and too many", () => {
    expect(code([])).toBe("EMPTY");
    expect(code(Array.from({ length: MAX_TARGETS_PER_PRESS + 1 }, () => target()))).toBe("TOO_MANY");
    expect(code(Array.from({ length: MAX_TARGETS_PER_PRESS }, () => target()))).toBe("ok");
  });
  it("a chat is not bound to a channel: any known channel and format is fine", () => {
    expect(code([target({ channel: "linkedin", formatKey: "linkedin.post" })])).toBe("ok");
    expect(code([target({ channel: "seo", formatKey: "seo.article" })])).toBe("ok");
    expect(code([target({ channel: "bogus" })])).toBe("BAD_FORMAT");
  });
  it("rejects a format that is not of the channel", () => {
    expect(code([target({ formatKey: "seo.article" })])).toBe("BAD_FORMAT");
  });
  it("rejects malformed or non-real dates", () => {
    for (const date of ["2026-10-32", "2026-13-01", "2026-02-30", "2026-1-2", "tomorrow", ""]) {
      expect(code([target({ date })])).toBe("BAD_DATE");
    }
  });
  it("rejects malformed times (probe inputs)", () => {
    for (const time of ["25:00", "10:99", "9:5", "Tab:cd", "9:00", "", "24:00"]) {
      expect(code([target({ time })])).toBe("BAD_TIME");
    }
  });
  it("rejects a past day", () => {
    expect(code([target({ date: "2026-09-30" })])).toBe("PAST");
  });
  it("enforces the horizon edge", () => {
    expect(code([target({ date: "2026-11-30" })])).toBe("ok");
    expect(code([target({ date: "2026-12-01" })])).toBe("BAD_DATE");
  });
  it("same-day lead: exactly now+60 passes, 59 fails", () => {
    expect(code([target({ date: TODAY, time: "11:30" })])).toBe("ok");
    expect(code([target({ date: TODAY, time: "11:29" })])).toBe("PAST");
  });
  it("compares minutes, never strings ('9:00' vs 10:30)", () => {
    expect(code([target({ date: TODAY, time: "9:00" })])).toBe("BAD_TIME");
    expect(code([target({ date: TODAY, time: "09:00" })])).toBe("PAST");
  });
  it("reports the offending index", () => {
    const r = run([target(), target({ date: TODAY, time: "10:45" })]);
    expect(r).toMatchObject({ ok: false, code: "PAST", suggestIndex: 1 });
  });
  it("fails closed on an unusable clock", () => {
    const r = validateSlotTargets({
      targets: [target({ date: TODAY, time: "23:00" })],
      today: TODAY,
      nowLocal: "garbage",
    });
    expect(r).toMatchObject({ ok: false, code: "PAST" });
  });
  it("never throws on hostile strings", () => {
    expect(() => run([target({ date: "2026-10-02Tab:cd", time: "\u0000" })])).not.toThrow();
  });
});

describe("minutesOf", () => {
  it("parses strict HH:mm only", () => {
    expect(minutesOf("09:05")).toBe(545);
    expect(minutesOf("23:59")).toBe(1439);
    expect(minutesOf("9:05")).toBeNull();
    expect(minutesOf("10:60")).toBeNull();
  });
});

describe("slotWhenLabel", () => {
  it("formats weekday, day, month and time", () => {
    expect(slotWhenLabel("2026-10-02", "11:00")).toBe("Fri 2 Oct, 11:00");
  });
});

describe("sanitizeClickText", () => {
  it("makes one clean line", () => {
    expect(sanitizeClickText("a\nb\t\u0007c  [x]", 50)).toBe("a b c (x)");
  });
  it("clips with an ellipsis", () => {
    const out = sanitizeClickText("x".repeat(100), 10);
    expect(out).toHaveLength(10);
    expect(out.endsWith("…")).toBe(true);
    expect(sanitizeClickText("short", 10)).toBe("short");
  });
});
