// Dışa aktarım ile GA API sayılarının karşılaştırması (GA-F8 "Export check").
// Saf modül. Gelir karşılaştırılmaz: dışa aktarımdaki para birimi ve zamanlama farklıdır.

export type ExportCompareLevel = "close" | "differs" | "unknown";

export type ExportCompare = {
  level: ExportCompareLevel;
  // Her iki kaynakta da bulunan gün sayısı
  days: number;
  sessionsDiffPct: number | null;
  usersDiffPct: number | null;
};

export type ExportDayCounts = { day: string; sessions: number; users: number };

// En az bu kadar ortak gün yoksa karşılaştırma yapılmaz.
export const COMPARE_MIN_DAYS = 7;
// Bu yüzdenin içi "yakın" sayılır.
export const COMPARE_CLOSE_PCT = 10;

export const EXPORT_CHECK_NOTE =
  "Small differences are normal: Google Analytics applies thresholding, modeling and the property time zone to its own reports, while the export holds the raw events. Revenue is not compared.";

function diffPct(exported: number, api: number): number {
  if (api === 0) return exported === 0 ? 0 : 100;
  return Math.round((Math.abs(exported - api) / api) * 1000) / 10;
}

export function compareExportToApi(input: {
  exported: readonly ExportDayCounts[];
  api: readonly ExportDayCounts[];
}): ExportCompare {
  const apiByDay = new Map(input.api.map((row) => [row.day, row]));
  let days = 0;
  let exportSessions = 0;
  let apiSessions = 0;
  let exportUsers = 0;
  let apiUsers = 0;
  const seen = new Set<string>();
  for (const row of input.exported) {
    if (seen.has(row.day)) continue;
    const other = apiByDay.get(row.day);
    if (!other) continue;
    seen.add(row.day);
    days += 1;
    exportSessions += row.sessions;
    apiSessions += other.sessions;
    exportUsers += row.users;
    apiUsers += other.users;
  }
  if (days < COMPARE_MIN_DAYS) {
    return { level: "unknown", days, sessionsDiffPct: null, usersDiffPct: null };
  }
  const sessionsDiffPct = diffPct(exportSessions, apiSessions);
  const usersDiffPct = diffPct(exportUsers, apiUsers);
  const close =
    sessionsDiffPct <= COMPARE_CLOSE_PCT && usersDiffPct <= COMPARE_CLOSE_PCT;
  return {
    level: close ? "close" : "differs",
    days,
    sessionsDiffPct,
    usersDiffPct,
  };
}
