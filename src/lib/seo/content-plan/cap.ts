// Aylık SEO makale sınırı (SK14 a): her proje için varsayılan 4, ayarlanabilir
// 1..12. Sınır planlamada, yerleştirmede ve AI üretim ön kontrolünde aynı
// aritmetikle uygulanır. Saf ve izomorfik.

export const PLAN_DEFAULT_CAP = 4;
export const PLAN_MIN_CAP = 1;
export const PLAN_MAX_CAP = 12;

export type SeoPlanSettings = { monthlyCap: number; autoPlan: boolean };

export const DEFAULT_PLAN_SETTINGS: SeoPlanSettings = {
  monthlyCap: PLAN_DEFAULT_CAP,
  autoPlan: true,
};

// Sonlu sayı ya da sayısal dizge; yuvarlanır ve 1..12'ye kırpılır. Okunamayan
// değer varsayılana düşer (0 ve negatifler okunabilir sayıdır: 1'e kırpılır).
export function clampCap(value: unknown): number {
  let parsed = Number.NaN;
  if (typeof value === "number") parsed = value;
  else if (typeof value === "string" && value.trim() !== "") {
    parsed = Number(value.trim());
  }
  if (!Number.isFinite(parsed)) return PLAN_DEFAULT_CAP;
  return Math.min(PLAN_MAX_CAP, Math.max(PLAN_MIN_CAP, Math.round(parsed)));
}

// Sınıra kalan boş yer; asla negatif değildir.
export function capacityOf(cap: unknown, existing: number): number {
  const used = Number.isFinite(existing) ? Math.max(0, Math.floor(existing)) : 0;
  return Math.max(0, clampCap(cap) - used);
}

export function trimToCapacity<T>(
  items: readonly T[],
  cap: unknown,
  existing: number,
): T[] {
  return items.slice(0, capacityOf(cap, existing));
}

// Satır yoksa (null/undefined) ya da alanlar bozuksa varsayılanlar.
export function parseSettings(
  row: { monthlyCap?: unknown; autoPlan?: unknown } | null | undefined,
): SeoPlanSettings {
  if (!row) return { ...DEFAULT_PLAN_SETTINGS };
  return {
    monthlyCap: clampCap(row.monthlyCap),
    autoPlan:
      typeof row.autoPlan === "boolean"
        ? row.autoPlan
        : DEFAULT_PLAN_SETTINGS.autoPlan,
  };
}
