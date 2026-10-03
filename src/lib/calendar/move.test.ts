import { describe, expect, it } from "vitest";

import { DEFAULT_DROP_TIME, isDroppableDay, resolveDrop } from "./move";

const NOW_LOCAL = "2026-10-03T14:20";

describe("resolveDrop", () => {
  it("gelecek güne bırakınca mevcut saati korur", () => {
    expect(
      resolveDrop({
        targetDay: "2026-10-09",
        currentTime: "18:30",
        nowLocal: NOW_LOCAL,
      }),
    ).toEqual({ ok: true, localDateTime: "2026-10-09T18:30" });
  });

  it("saati olmayan parçaya varsayılan saati verir", () => {
    expect(
      resolveDrop({
        targetDay: "2026-10-09",
        currentTime: null,
        nowLocal: NOW_LOCAL,
      }),
    ).toEqual({ ok: true, localDateTime: `2026-10-09T${DEFAULT_DROP_TIME}` });
  });

  it("geçmiş güne bırakmayı reddeder", () => {
    const result = resolveDrop({
      targetDay: "2026-10-02",
      currentTime: "10:00",
      nowLocal: NOW_LOCAL,
    });
    expect(result.ok).toBe(false);
  });

  it("bugüne bırakılan ve saati geçmiş parça bir sonraki çeyrek saate ertelenir", () => {
    expect(
      resolveDrop({
        targetDay: "2026-10-03",
        currentTime: "09:00",
        nowLocal: NOW_LOCAL,
      }),
    ).toEqual({ ok: true, localDateTime: "2026-10-03T14:30" });
  });

  it("bugüne bırakılan ve saati henüz gelmemiş parça saatini korur", () => {
    expect(
      resolveDrop({
        targetDay: "2026-10-03",
        currentTime: "20:00",
        nowLocal: NOW_LOCAL,
      }),
    ).toEqual({ ok: true, localDateTime: "2026-10-03T20:00" });
  });

  it("tam çeyrek saatte bir sonraki çeyreğe atlar (şimdiye eşit saat geçmiş sayılır)", () => {
    expect(
      resolveDrop({
        targetDay: "2026-10-03",
        currentTime: "14:00",
        nowLocal: "2026-10-03T14:00",
      }),
    ).toEqual({ ok: true, localDateTime: "2026-10-03T14:15" });
  });

  it("günün sonunda bugüne yer kalmadıysa reddeder", () => {
    const result = resolveDrop({
      targetDay: "2026-10-03",
      currentTime: "09:00",
      nowLocal: "2026-10-03T23:50",
    });
    expect(result.ok).toBe(false);
  });

  it("geçersiz gün anahtarını reddeder", () => {
    expect(
      resolveDrop({
        targetDay: "2026-02-31",
        currentTime: null,
        nowLocal: NOW_LOCAL,
      }).ok,
    ).toBe(false);
  });
});

describe("isDroppableDay", () => {
  it("bugün ve sonrası bırakılabilir, geçmiş değil", () => {
    expect(isDroppableDay("2026-10-03", "2026-10-03")).toBe(true);
    expect(isDroppableDay("2026-10-04", "2026-10-03")).toBe(true);
    expect(isDroppableDay("2026-10-02", "2026-10-03")).toBe(false);
  });
});
