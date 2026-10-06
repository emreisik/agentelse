import { tokenizeFolded } from "@/lib/text-fold";

import { compactBrandTerm, isBrandQuery } from "./brand-terms";

// Yazım hatasına dayanıklı marka sınıflaması (docs/google-search-console-plan.md
// SC-F4): W1'in isBrandQuery eşleşmesine ek olarak sorgunun her sözcüğü (ya
// da bitişik iki sözcüğün birleşimi) ayraçsız marka terimine Damerau-
// Levenshtein (OSA) ile yakınsa marka sayılır: 5–8 harfte ≤1, 9+ harfte ≤2;
// 5 harften kısa terim yalnız birebir. Sonuç bellekte kullanılır, GscQuery.isBrand'e
// yazılmaz. Sahibin kendi sitesinde canlı ≥%90 doğruluk örneklemesi elle
// yapılan kabul adımıdır (docs); bu dosyadaki örneklem yalnız regresyon içindir.
// Saf ve izomorfik.

const SHORT_TERM = 5;
const LONG_TERM = 9;

// Kısıtlı Damerau-Levenshtein (bitişik takas = 1). Uzaklık `max`'ı aşınca
// erken çıkar ve max + 1 döner.
export function damerauLevenshtein(a: string, b: string, max: number): number {
  const left = Array.from(a);
  const right = Array.from(b);
  const limit = Math.max(0, Math.floor(max));
  if (Math.abs(left.length - right.length) > limit) return limit + 1;
  if (left.length === 0) return right.length;
  if (right.length === 0) return left.length;
  const width = right.length + 1;
  let before = new Array<number>(width).fill(0);
  let previous = Array.from({ length: width }, (_, index) => index);
  let current = new Array<number>(width).fill(0);
  for (let i = 1; i <= left.length; i += 1) {
    current[0] = i;
    let rowMin = current[0];
    for (let j = 1; j <= right.length; j += 1) {
      const cost = left[i - 1] === right[j - 1] ? 0 : 1;
      let value = Math.min(
        previous[j]! + 1,
        current[j - 1]! + 1,
        previous[j - 1]! + cost,
      );
      if (
        i > 1 &&
        j > 1 &&
        left[i - 1] === right[j - 2] &&
        left[i - 2] === right[j - 1]
      ) {
        value = Math.min(value, before[j - 2]! + 1);
      }
      current[j] = value;
      if (value < rowMin) rowMin = value;
    }
    if (rowMin > limit) return limit + 1;
    [before, previous, current] = [previous, current, before];
  }
  const distance = previous[right.length]!;
  return distance > limit ? limit + 1 : distance;
}

function allowedDistance(compactLength: number): number {
  if (compactLength < SHORT_TERM) return 0;
  return compactLength >= LONG_TERM ? 2 : 1;
}

export function isFuzzyBrandQuery(
  query: string,
  terms: readonly string[],
): boolean {
  if (terms.length === 0) return false;
  if (isBrandQuery(query, terms)) return true;
  const tokens = tokenizeFolded(query);
  if (tokens.length === 0) return false;
  const candidates = [...tokens];
  for (let index = 0; index + 1 < tokens.length; index += 1) {
    candidates.push(tokens[index]! + tokens[index + 1]!);
  }
  for (const term of terms) {
    const compact = compactBrandTerm(term);
    if (!compact) continue;
    const allowed = allowedDistance(Array.from(compact).length);
    for (const candidate of candidates) {
      if (allowed === 0) {
        if (candidate === compact) return true;
        continue;
      }
      if (damerauLevenshtein(candidate, compact, allowed) <= allowed) {
        return true;
      }
    }
  }
  return false;
}

// Elle etiketlenmiş örneklemde doğru sınıflanan oran; boş örneklem 0.
export function brandClassifierAccuracy(
  sample: readonly { query: string; brand: boolean }[],
  terms: readonly string[],
): number {
  if (sample.length === 0) return 0;
  const correct = sample.filter(
    (item) => isFuzzyBrandQuery(item.query, terms) === item.brand,
  ).length;
  return correct / sample.length;
}
