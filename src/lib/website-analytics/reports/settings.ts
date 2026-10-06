// GA-F5 rapor ayarları (docs/website-reports.md "Ayarlar"). Saf ve
// izomorfik: sunucu okuyucusu (GaReportSettings satırı) ve ayar kartı
// buradan beslenir. Aralık dışı değerler kısılmaz, alanın varsayılanına döner.

export const GA_REPORT_PULSE_MODES = ["notable", "off"] as const;
export type GaReportPulseMode = (typeof GA_REPORT_PULSE_MODES)[number];

export type GaReportSettingsValue = {
  weeklyEnabled: boolean;
  // ISO hafta günü, 1 = Pazartesi … 7 = Pazar.
  weeklyWeekday: number;
  monthlyEnabled: boolean;
  // Ayın günü, 1–28.
  monthlyDay: number;
  pulse: GaReportPulseMode;
  alertChat: boolean;
  alertTelegram: boolean;
};

// stored = projede kayıtlı bir satır var mı (yoksa varsayılanlar geçerli).
export type GaReportSettingsView = GaReportSettingsValue & { stored: boolean };

export const GA_REPORT_SETTINGS_DEFAULTS: Readonly<GaReportSettingsValue> = {
  weeklyEnabled: true,
  weeklyWeekday: 1,
  monthlyEnabled: true,
  monthlyDay: 2,
  pulse: "notable",
  alertChat: true,
  alertTelegram: true,
};

export const WEEKDAY_LABELS = [
  "",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
  "Sunday",
] as const;

// 1..7 dışında boş metin.
export function weekdayLabel(isoWeekday: number): string {
  return Number.isInteger(isoWeekday) && isoWeekday >= 1 && isoWeekday <= 7
    ? (WEEKDAY_LABELS[isoWeekday] ?? "")
    : "";
}

function isIntInRange(value: unknown, min: number, max: number): value is number {
  return (
    typeof value === "number" &&
    Number.isInteger(value) &&
    value >= min &&
    value <= max
  );
}

function isPulseMode(value: unknown): value is GaReportPulseMode {
  return (
    typeof value === "string" &&
    (GA_REPORT_PULSE_MODES as readonly string[]).includes(value)
  );
}

// Veritabanı satırından (ya da satırsız null) ayar görünümü; her alan türüne
// ve aralığına göre ayrı doğrulanır.
export function readGaReportSettings(
  row: Partial<Record<keyof GaReportSettingsValue, unknown>> | null,
): GaReportSettingsView {
  const d = GA_REPORT_SETTINGS_DEFAULTS;
  if (!row) return { ...d, stored: false };
  return {
    weeklyEnabled:
      typeof row.weeklyEnabled === "boolean" ? row.weeklyEnabled : d.weeklyEnabled,
    weeklyWeekday: isIntInRange(row.weeklyWeekday, 1, 7)
      ? row.weeklyWeekday
      : d.weeklyWeekday,
    monthlyEnabled:
      typeof row.monthlyEnabled === "boolean"
        ? row.monthlyEnabled
        : d.monthlyEnabled,
    monthlyDay: isIntInRange(row.monthlyDay, 1, 28)
      ? row.monthlyDay
      : d.monthlyDay,
    pulse: isPulseMode(row.pulse) ? row.pulse : d.pulse,
    alertChat: typeof row.alertChat === "boolean" ? row.alertChat : d.alertChat,
    alertTelegram:
      typeof row.alertTelegram === "boolean" ? row.alertTelegram : d.alertTelegram,
    stored: true,
  };
}

function formInt(formData: FormData, name: string): number | null {
  const raw = formData.get(name);
  if (typeof raw !== "string" || !/^\d{1,2}$/.test(raw.trim())) return null;
  return Number(raw.trim());
}

// Ayar formu: işaret kutuları "on" ise açık, eksikse kapalı.
export function parseGaReportSettingsForm(
  formData: FormData,
):
  | { ok: true; value: GaReportSettingsValue }
  | { ok: false; message: string } {
  const weeklyWeekday = formInt(formData, "weeklyWeekday");
  const monthlyDay = formInt(formData, "monthlyDay");
  if (
    !isIntInRange(weeklyWeekday, 1, 7) ||
    !isIntInRange(monthlyDay, 1, 28)
  ) {
    return { ok: false, message: "Pick a valid day." };
  }
  const pulse = formData.get("pulse");
  if (!isPulseMode(pulse)) {
    return { ok: false, message: "Pick a valid pulse setting." };
  }
  const on = (name: string) => formData.get(name) === "on";
  return {
    ok: true,
    value: {
      weeklyEnabled: on("weeklyEnabled"),
      weeklyWeekday,
      monthlyEnabled: on("monthlyEnabled"),
      monthlyDay,
      pulse,
      alertChat: on("alertChat"),
      alertTelegram: on("alertTelegram"),
    },
  };
}
