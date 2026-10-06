import { addDays } from "./days";

// Brand sekmesindeki "Website" kartının saf kuralları (GA-F2 bölüm 2,
// GA_BRAND_CARD): veriye dayalı 28 günlük pencere, oturum trendi ve sağlık
// noktası. İzomorfik modül: kart tipleri buradan alır.

export type WebsiteHealthTone = "ok" | "warning" | "error" | "unknown";

export type WebsiteOverview =
  | { ok: false; reason: "off" | "not_connected" | "not_synced" }
  | {
      ok: true;
      propertyName: string | null;
      days: 28;
      sessions: number;
      keyEvents: number;
      sessionsChange: number | null;
      keyEventsChange: number | null;
      trend: "up" | "down" | "flat" | null;
      health: WebsiteHealthTone;
      healthLabel: string;
      dataThrough: string | null;
      // GA-F3 (GA_HEALTH): ölçüm sağlığı noktası
      measurement?: { score: number | null; tone: WebsiteHealthTone; label: string };
    };

const TREND_THRESHOLD = 3;
// Son gün bugünden 3 günden eskiyse veri gecikmiş sayılır.
const LATE_AFTER_DAYS = 3;
const WINDOW_DAYS = 28;

// ±%3'ten küçük değişim "yatay"; karşılaştırma yoksa null.
export function overviewTrend(
  change: number | null,
): "up" | "down" | "flat" | null {
  if (change === null) return null;
  if (change >= TREND_THRESHOLD) return "up";
  if (change <= -TREND_THRESHOLD) return "down";
  return "flat";
}

// Kullanıcının düzeltmesi gereken durumlar (runner.ts STOPPING ile aynı).
const ERROR_LABELS: Record<string, string> = {
  AUTH: "Reconnect needed",
  NEEDS_PERMISSION: "Reconnect needed",
  ACCESS_LOST: "Can't read the property",
  GONE: "Can't read the property",
  API_DISABLED: "Can't read the property",
};

// Bağın sağlığı + verinin tazeliği → nokta rengi ve etiket. Hata tonları
// geciken veriden, geciken veri "OK"den önce gelir.
export function websiteHealthTone(input: {
  health: string;
  dataThrough: string | null;
  today: string;
}): { tone: WebsiteHealthTone; label: string } {
  const error = ERROR_LABELS[input.health];
  if (error) return { tone: "error", label: error };
  if (input.health === "DEGRADED") {
    return { tone: "warning", label: "Updates are failing" };
  }
  if (
    input.dataThrough !== null &&
    input.dataThrough < addDays(input.today, -LATE_AFTER_DAYS)
  ) {
    return { tone: "warning", label: "Data is late" };
  }
  if (input.health === "OK") return { tone: "ok", label: "Up to date" };
  return { tone: "unknown", label: "Checking" };
}

// Pencere veriye bağlanır: son gün = min(dün, ambarın son günü); bu dönem
// son 28 gün, önceki dönem ondan önceki 28 gün. Veri yoksa null.
export function overviewWindow(
  today: string,
  through: string | null,
): {
  current: { from: string; to: string };
  previous: { from: string; to: string };
} | null {
  if (through === null) return null;
  const yesterday = addDays(today, -1);
  const end = through < yesterday ? through : yesterday;
  return {
    current: { from: addDays(end, -(WINDOW_DAYS - 1)), to: end },
    previous: {
      from: addDays(end, -(WINDOW_DAYS * 2 - 1)),
      to: addDays(end, -WINDOW_DAYS),
    },
  };
}
