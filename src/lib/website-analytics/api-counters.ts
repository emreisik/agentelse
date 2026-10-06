// GA API sayaçları (docs/google-analytics-plan.md §3.9 "Gözlemlenebilirlik",
// GA-F2 bölüm 2): Data API ve Admin API çağrıları ve hata sınıfları saat
// başına sayılır, SystemHeartbeat "ga.api" satırında son 25 saat tutulur.
// Yalnız sayılar saklanır (mülk kimliği yok). Saf modül.

export type GaApiCounterData = {
  v: 1;
  // "YYYY-MM-DDTHH" (UTC) → sonuç ("ok" ya da hata sınıfı) → sayı.
  hours: Record<string, Partial<Record<string, number>>>;
};

const HOUR_MS = 3_600_000;
const KEEP_HOURS = 25;

export function gaHourKey(at: Date): string {
  return at.toISOString().slice(0, 13);
}

function hourStart(hour: string): number {
  return Date.parse(`${hour}:00:00.000Z`);
}

// Saklanan JSON'u okur; tanınmayan biçim null.
export function parseGaApiCounters(value: unknown): GaApiCounterData | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const data = value as { v?: unknown; hours?: unknown };
  if (data.v !== 1 || !data.hours || typeof data.hours !== "object") {
    return null;
  }
  const hours: GaApiCounterData["hours"] = {};
  for (const [hour, counts] of Object.entries(data.hours)) {
    if (!/^\d{4}-\d{2}-\d{2}T\d{2}$/.test(hour)) continue;
    if (!counts || typeof counts !== "object") continue;
    const clean: Partial<Record<string, number>> = {};
    for (const [outcome, count] of Object.entries(counts)) {
      if (typeof count === "number" && Number.isFinite(count)) {
        clean[outcome] = count;
      }
    }
    hours[hour] = clean;
  }
  return { v: 1, hours };
}

export function addCounts(
  data: GaApiCounterData | null,
  hour: string,
  counts: Record<string, number>,
): GaApiCounterData {
  const current = { ...(data?.hours[hour] ?? {}) };
  for (const [outcome, count] of Object.entries(counts)) {
    current[outcome] = (current[outcome] ?? 0) + count;
  }
  return { v: 1, hours: { ...(data?.hours ?? {}), [hour]: current } };
}

// Şu anki saat dahil son `keep` saat kalır.
export function trimHours(
  data: GaApiCounterData,
  now: Date,
  keep: number = KEEP_HOURS,
): GaApiCounterData {
  const oldest = hourStart(gaHourKey(now)) - (keep - 1) * HOUR_MS;
  const hours: GaApiCounterData["hours"] = {};
  for (const [hour, counts] of Object.entries(data.hours)) {
    if (hourStart(hour) >= oldest) hours[hour] = counts;
  }
  return { v: 1, hours };
}

// Şu anki saat dahil son `hours` saatin toplamları (sonuç başına).
export function sumLastHours(
  data: GaApiCounterData | null,
  now: Date,
  hours: number,
): Record<string, number> {
  const totals: Record<string, number> = {};
  if (!data) return totals;
  const newest = hourStart(gaHourKey(now));
  const oldest = newest - (hours - 1) * HOUR_MS;
  for (const [hour, counts] of Object.entries(data.hours)) {
    const start = hourStart(hour);
    if (start < oldest || start > newest) continue;
    for (const [outcome, count] of Object.entries(counts)) {
      totals[outcome] = (totals[outcome] ?? 0) + (count ?? 0);
    }
  }
  return totals;
}
