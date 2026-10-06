import { describe, expect, it } from "vitest";

import {
  GA_REPORT_SETTINGS_DEFAULTS,
  WEEKDAY_LABELS,
  parseGaReportSettingsForm,
  readGaReportSettings,
  weekdayLabel,
} from "./settings";

// Bu dosyanın kanıtladığı: ayar satırı alan alan doğrulanır (aralık dışı
// değer varsayılana döner, kısılmaz); form eksik anahtarları kapalı sayar ve
// geçersiz gün ya da nabız değerini reddeder.

function form(fields: Record<string, string>): FormData {
  const data = new FormData();
  for (const [key, value] of Object.entries(fields)) data.set(key, value);
  return data;
}

describe("readGaReportSettings", () => {
  it("returns the defaults without a row", () => {
    expect(GA_REPORT_SETTINGS_DEFAULTS).toEqual({
      weeklyEnabled: true,
      weeklyWeekday: 1,
      monthlyEnabled: true,
      monthlyDay: 2,
      pulse: "notable",
      alertChat: true,
      alertTelegram: true,
    });
    expect(readGaReportSettings(null)).toEqual({
      ...GA_REPORT_SETTINGS_DEFAULTS,
      stored: false,
    });
  });

  it("reads a stored row", () => {
    const view = readGaReportSettings({
      weeklyEnabled: false,
      weeklyWeekday: 5,
      monthlyEnabled: false,
      monthlyDay: 28,
      pulse: "off",
      alertChat: false,
      alertTelegram: false,
    });
    expect(view).toEqual({
      weeklyEnabled: false,
      weeklyWeekday: 5,
      monthlyEnabled: false,
      monthlyDay: 28,
      pulse: "off",
      alertChat: false,
      alertTelegram: false,
      stored: true,
    });
  });

  it("falls back to the default for out-of-range weekdays", () => {
    for (const weeklyWeekday of [0, 9, 2.5, -1, "3", null]) {
      expect(readGaReportSettings({ weeklyWeekday }).weeklyWeekday).toBe(1);
    }
    expect(readGaReportSettings({ weeklyWeekday: 7 }).weeklyWeekday).toBe(7);
  });

  it("falls back to the default for out-of-range month days", () => {
    expect(readGaReportSettings({ monthlyDay: 29 }).monthlyDay).toBe(2);
    expect(readGaReportSettings({ monthlyDay: 0 }).monthlyDay).toBe(2);
    expect(readGaReportSettings({ monthlyDay: 28 }).monthlyDay).toBe(28);
  });

  it("falls back per field for bad types and unknown pulse values", () => {
    const view = readGaReportSettings({
      weeklyEnabled: "yes",
      pulse: "daily",
      alertChat: 1,
      monthlyDay: 10,
    });
    expect(view.weeklyEnabled).toBe(true);
    expect(view.pulse).toBe("notable");
    expect(view.alertChat).toBe(true);
    expect(view.monthlyDay).toBe(10);
    expect(view.stored).toBe(true);
  });
});

describe("weekday labels", () => {
  it("labels 1..7 and nothing else", () => {
    expect(WEEKDAY_LABELS).toHaveLength(8);
    expect(weekdayLabel(1)).toBe("Monday");
    expect(weekdayLabel(7)).toBe("Sunday");
    expect(weekdayLabel(0)).toBe("");
    expect(weekdayLabel(8)).toBe("");
    expect(weekdayLabel(1.5)).toBe("");
  });
});

describe("parseGaReportSettingsForm", () => {
  it("treats missing switches as off", () => {
    const parsed = parseGaReportSettingsForm(
      form({ weeklyWeekday: "3", monthlyDay: "5", pulse: "notable" }),
    );
    expect(parsed).toEqual({
      ok: true,
      value: {
        weeklyEnabled: false,
        weeklyWeekday: 3,
        monthlyEnabled: false,
        monthlyDay: 5,
        pulse: "notable",
        alertChat: false,
        alertTelegram: false,
      },
    });
  });

  it("reads 'on' switches", () => {
    const parsed = parseGaReportSettingsForm(
      form({
        weeklyEnabled: "on",
        monthlyEnabled: "on",
        alertChat: "on",
        alertTelegram: "on",
        weeklyWeekday: "1",
        monthlyDay: "2",
        pulse: "off",
      }),
    );
    expect(parsed).toEqual({
      ok: true,
      value: {
        weeklyEnabled: true,
        weeklyWeekday: 1,
        monthlyEnabled: true,
        monthlyDay: 2,
        pulse: "off",
        alertChat: true,
        alertTelegram: true,
      },
    });
  });

  it("rejects an invalid day", () => {
    const message = "Pick a valid day.";
    expect(
      parseGaReportSettingsForm(
        form({ weeklyWeekday: "9", monthlyDay: "2", pulse: "off" }),
      ),
    ).toEqual({ ok: false, message });
    expect(
      parseGaReportSettingsForm(
        form({ weeklyWeekday: "1", monthlyDay: "29", pulse: "off" }),
      ),
    ).toEqual({ ok: false, message });
    expect(
      parseGaReportSettingsForm(form({ weeklyWeekday: "1", pulse: "off" })),
    ).toEqual({ ok: false, message });
    expect(
      parseGaReportSettingsForm(
        form({ weeklyWeekday: "x", monthlyDay: "2", pulse: "off" }),
      ),
    ).toEqual({ ok: false, message });
  });

  it("rejects an invalid pulse", () => {
    expect(
      parseGaReportSettingsForm(
        form({ weeklyWeekday: "1", monthlyDay: "2", pulse: "daily" }),
      ),
    ).toEqual({ ok: false, message: "Pick a valid pulse setting." });
    expect(
      parseGaReportSettingsForm(form({ weeklyWeekday: "1", monthlyDay: "2" })),
    ).toEqual({ ok: false, message: "Pick a valid pulse setting." });
  });
});
