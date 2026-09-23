import { describe, expect, it } from "vitest";

import {
  dayKeyInTimezone,
  utcToZonedDateTimeLocal,
  zonedDateTimeToUtc,
} from "./timezone";

describe("zonedDateTimeToUtc", () => {
  it("converts a positive-offset zone (Europe/Istanbul, UTC+3)", () => {
    expect(
      zonedDateTimeToUtc("2026-10-15T14:00", "Europe/Istanbul").toISOString(),
    ).toBe("2026-10-15T11:00:00.000Z");
  });

  it("rolls onto the previous UTC day near local midnight", () => {
    expect(
      zonedDateTimeToUtc("2026-10-16T01:00", "Europe/Istanbul").toISOString(),
    ).toBe("2026-10-15T22:00:00.000Z");
  });

  it("converts a negative-offset zone (America/New_York, EDT UTC-4)", () => {
    expect(
      zonedDateTimeToUtc("2026-10-15T14:00", "America/New_York").toISOString(),
    ).toBe("2026-10-15T18:00:00.000Z");
  });

  it("is a no-op for UTC itself", () => {
    expect(zonedDateTimeToUtc("2026-10-15T14:00", "UTC").toISOString()).toBe(
      "2026-10-15T14:00:00.000Z",
    );
  });
});

describe("utcToZonedDateTimeLocal", () => {
  it("is the inverse of zonedDateTimeToUtc", () => {
    const utc = zonedDateTimeToUtc("2026-10-15T14:00", "Europe/Istanbul");
    expect(utcToZonedDateTimeLocal(utc, "Europe/Istanbul")).toBe(
      "2026-10-15T14:00",
    );
  });

  it("rolls forward onto the next local day near UTC midnight", () => {
    const date = new Date("2026-10-15T22:00:00.000Z");
    expect(utcToZonedDateTimeLocal(date, "Europe/Istanbul")).toBe(
      "2026-10-16T01:00",
    );
  });
});

describe("dayKeyInTimezone", () => {
  it("buckets by the zone's own calendar day, not UTC's", () => {
    // 22:00 UTC on Oct 15 is already Oct 16 in Istanbul (UTC+3).
    const date = new Date("2026-10-15T22:00:00.000Z");
    expect(dayKeyInTimezone(date, "Europe/Istanbul")).toBe("2026-10-16");
    expect(dayKeyInTimezone(date, "UTC")).toBe("2026-10-15");
  });
});
