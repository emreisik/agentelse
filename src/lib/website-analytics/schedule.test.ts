import { describe, expect, it } from "vitest";

import {
  dailyAttemptCompletes,
  dailyWindow,
  dueGaStages,
  finalThrough,
  type GaSyncState,
} from "./schedule";

// Bu dosyanın kanıtladığı: günlük çekim mülk saatiyle 16:00, 18:00 ve 21:00
// pencerelerinde, her pencerede en çok bir kez denenir; dünün verisi
// gelince ya da son pencerede gün tamamlanır; yeni bağlantı saati beklemez;
// 16:00'dan önceki deneme günü tamamlamaz.

const TZ = "Europe/Istanbul"; // UTC+3
const at = (utcHour: number, day = "2026-10-06") =>
  new Date(`${day}T${String(utcHour).padStart(2, "0")}:05:00.000Z`);

const fresh: GaSyncState = {
  lastMetadataAt: null,
  lastDailyAt: null,
  lastDailyDate: null,
  backfillDone: false,
};

describe("dueGaStages", () => {
  it("runs a new connection at once, whatever the hour", () => {
    expect(dueGaStages(fresh, { now: at(6), timeZone: TZ })).toEqual({
      metadata: true,
      daily: true,
      backfill: true,
    });
  });

  it("after an early first try waits for the 16:00 window", () => {
    const state: GaSyncState = {
      ...fresh,
      lastMetadataAt: at(6),
      lastDailyAt: at(6), // 09:05 yerel
    };
    expect(dueGaStages(state, { now: at(10), timeZone: TZ }).daily).toBe(false);
    // Geri doldurma ilk denemeden sonra beklemez.
    expect(dueGaStages(state, { now: at(10), timeZone: TZ }).backfill).toBe(
      true,
    );
    expect(dueGaStages(state, { now: at(13), timeZone: TZ }).daily).toBe(true);
  });

  it("tries each window once until the day completes", () => {
    const tried16: GaSyncState = {
      ...fresh,
      lastMetadataAt: at(13),
      lastDailyAt: at(13), // 16:05 yerel, dün gelmedi
      backfillDone: true,
    };
    expect(dueGaStages(tried16, { now: at(14), timeZone: TZ }).daily).toBe(
      false,
    );
    expect(dueGaStages(tried16, { now: at(15), timeZone: TZ }).daily).toBe(
      true,
    );
    const completed: GaSyncState = { ...tried16, lastDailyDate: "2026-10-06" };
    expect(dueGaStages(completed, { now: at(19), timeZone: TZ }).daily).toBe(
      false,
    );
    // Ertesi gün yine 16:00'ı bekler.
    expect(
      dueGaStages(completed, { now: at(6, "2026-10-07"), timeZone: TZ }).daily,
    ).toBe(false);
    expect(
      dueGaStages(completed, { now: at(13, "2026-10-07"), timeZone: TZ }).daily,
    ).toBe(true);
  });

  it("reads the property metadata once a day", () => {
    const state: GaSyncState = {
      ...fresh,
      lastMetadataAt: new Date("2026-10-05T12:00:00.000Z"),
      lastDailyAt: at(6),
    };
    expect(
      dueGaStages(state, {
        now: new Date("2026-10-06T11:00:00.000Z"),
        timeZone: TZ,
      }).metadata,
    ).toBe(false);
    expect(
      dueGaStages(state, {
        now: new Date("2026-10-06T12:00:00.000Z"),
        timeZone: TZ,
      }).metadata,
    ).toBe(true);
  });
});

describe("daily attempts and finality", () => {
  it("completes the day only in a window", () => {
    expect(dailyWindow(15)).toBeNull();
    expect(dailyWindow(17)).toBe(16);
    expect(dailyWindow(23)).toBe(21);
    expect(dailyAttemptCompletes({ hour: 10, yesterdayIn: true })).toBe(false);
    expect(dailyAttemptCompletes({ hour: 16, yesterdayIn: true })).toBe(true);
    expect(dailyAttemptCompletes({ hour: 18, yesterdayIn: false })).toBe(false);
    expect(dailyAttemptCompletes({ hour: 21, yesterdayIn: false })).toBe(true);
  });

  it("calls a day final once it left the revision window", () => {
    expect(finalThrough("2026-10-06", 7)).toBe("2026-09-28");
    expect(finalThrough("2026-10-06", 13)).toBe("2026-09-22");
  });
});
