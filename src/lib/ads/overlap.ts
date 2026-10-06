// Kitle çakışması (docs/meta-ads-plan.md F8): aynı hesapta aynı amaçla çalışan
// iki ad set aynı insanlara yöneliyorsa aynı açık artırmada birbirine karşı
// teklif verir ve maliyeti iter. Saf. Meta'nın kitle çakışma aracı API'de
// yok; hedeflemenin özeti (konum, yaş, cinsiyet, özel kitleler) karşılaştırılır.
// Kişisel veri yok: yalnız kimlikler ve aralıklar.

export type TargetingSummary = {
  // "TR" (ülkenin tamamı) ya da "TR:region:123" / "TR:city:456" / "TR:zip:..".
  locations: string[];
  ageMin: number;
  ageMax: number;
  // Boş: herkes. 1 = erkek, 2 = kadın (Meta).
  genders: number[];
  customAudiences: string[];
  excludedAudiences: string[];
};

type RawLocation = { key?: unknown; country?: unknown; country_code?: unknown };

function ids(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) =>
      typeof item === "string" || typeof item === "number"
        ? String(item)
        : item && typeof item === "object" && "id" in item
          ? String((item as { id: unknown }).id)
          : "",
    )
    .filter(Boolean)
    .sort();
}

function locationKeys(geo: Record<string, unknown>): string[] {
  const out = new Set<string>();
  for (const country of Array.isArray(geo.countries) ? geo.countries : []) {
    if (typeof country === "string") out.add(country.toUpperCase());
  }
  for (const [field, kind] of [
    ["regions", "region"],
    ["cities", "city"],
    ["zips", "zip"],
  ] as const) {
    const list = Array.isArray(geo[field]) ? (geo[field] as RawLocation[]) : [];
    for (const item of list) {
      const country = item?.country ?? item?.country_code;
      if (item?.key === undefined || typeof country !== "string") continue;
      out.add(`${country.toUpperCase()}:${kind}:${String(item.key)}`);
    }
  }
  return [...out].sort();
}

export function targetingSummary(raw: unknown): TargetingSummary | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const targeting = raw as Record<string, unknown>;
  const geo =
    targeting.geo_locations && typeof targeting.geo_locations === "object"
      ? (targeting.geo_locations as Record<string, unknown>)
      : {};
  const ageMin = Number(targeting.age_min ?? 18);
  const ageMax = Number(targeting.age_max ?? 65);
  return {
    locations: locationKeys(geo),
    ageMin: Number.isFinite(ageMin) ? ageMin : 18,
    ageMax: Number.isFinite(ageMax) ? ageMax : 65,
    genders: Array.isArray(targeting.genders)
      ? targeting.genders
          .map(Number)
          .filter((g) => g === 1 || g === 2)
          .sort()
      : [],
    customAudiences: ids(targeting.custom_audiences),
    excludedAudiences: ids(targeting.excluded_custom_audiences),
  };
}

function countryOf(location: string): string {
  return location.split(":")[0]!;
}

// İki konum listesi aynı insanları kapsıyor mu: ortak ülke ve (ikisinden biri
// ülkenin tamamıysa ya da aynı bölge / şehir anahtarıysa) evet.
function locationsOverlap(a: string[], b: string[]): boolean {
  for (const left of a) {
    for (const right of b) {
      if (countryOf(left) !== countryOf(right)) continue;
      if (left === right || !left.includes(":") || !right.includes(":"))
        return true;
    }
  }
  return false;
}

function agesOverlap(a: TargetingSummary, b: TargetingSummary): boolean {
  const low = Math.max(a.ageMin, b.ageMin);
  const high = Math.min(a.ageMax, b.ageMax);
  if (high < low) return false;
  const narrower = Math.min(a.ageMax - a.ageMin, b.ageMax - b.ageMin);
  return narrower <= 0 || (high - low) / narrower >= 0.5;
}

function gendersOverlap(a: number[], b: number[]): boolean {
  return a.length === 0 || b.length === 0 || a.some((g) => b.includes(g));
}

function audiencesOverlap(a: TargetingSummary, b: TargetingSummary): boolean {
  if (
    a.excludedAudiences.some((id) => b.customAudiences.includes(id)) ||
    b.excludedAudiences.some((id) => a.customAudiences.includes(id))
  ) {
    return false;
  }
  if (a.customAudiences.length > 0 && b.customAudiences.length > 0) {
    return a.customAudiences.some((id) => b.customAudiences.includes(id));
  }
  return true;
}

export type OverlapSubject = {
  externalId: string;
  name: string;
  optimizationGoal: string | null;
  targeting: TargetingSummary;
};

export function overlappingPairs(
  adSets: readonly OverlapSubject[],
): { a: OverlapSubject; b: OverlapSubject }[] {
  const out: { a: OverlapSubject; b: OverlapSubject }[] = [];
  for (let i = 0; i < adSets.length; i += 1) {
    for (let j = i + 1; j < adSets.length; j += 1) {
      const a = adSets[i]!;
      const b = adSets[j]!;
      if (!a.optimizationGoal || a.optimizationGoal !== b.optimizationGoal)
        continue;
      if (
        locationsOverlap(a.targeting.locations, b.targeting.locations) &&
        agesOverlap(a.targeting, b.targeting) &&
        gendersOverlap(a.targeting.genders, b.targeting.genders) &&
        audiencesOverlap(a.targeting, b.targeting)
      ) {
        out.push({ a, b });
      }
    }
  }
  return out;
}

export function overlapKey(a: string, b: string): string {
  return [a, b].sort().join("+");
}
