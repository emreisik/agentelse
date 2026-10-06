// İstatistik kapısı (docs/meta-ads-plan.md §6 O11, §3.5 adım 7). Poisson
// yaklaşımı: iki sonuç oranının farkı ancak oran ≥ exp(1,96·√(2/n)) ise
// anlamlı sayılır (n = küçük taraftaki sonuç sayısı). Saf.

export function significanceRatio(n: number): number {
  if (!(n > 0)) return Number.POSITIVE_INFINITY;
  return Math.exp(1.96 * Math.sqrt(2 / n));
}

export type Outcome = "WORKED" | "DIDNT" | "INCONCLUSIVE";

type Side = { spendMinor: number; results: number };

function cpa(side: Side): number | null {
  return side.results > 0 ? side.spendMinor / side.results : null;
}

// Karar türüne göre "işe yaradı mı?". Az veride kararsız kalır; tahmin etmez.
export function outcomeOf(
  kind: string,
  before: Side,
  after: Side,
): { outcome: Outcome; ratio: number | null } {
  const n = Math.min(before.results, after.results);
  const cpaBefore = cpa(before);
  const cpaAfter = cpa(after);
  if (cpaBefore === null || cpaAfter === null || n < 5) {
    return { outcome: "INCONCLUSIVE", ratio: null };
  }
  const ratio = cpaAfter / cpaBefore;
  const gate = significanceRatio(n);
  if (kind === "BUDGET_UP") {
    // Ölçek: daha çok sonuç, maliyet anlamlı biçimde kötüleşmeden.
    if (after.results > before.results && ratio <= 1.2) return { outcome: "WORKED", ratio };
    if (ratio >= gate) return { outcome: "DIDNT", ratio };
    return { outcome: "INCONCLUSIVE", ratio };
  }
  // Düşürme / duraklatma: maliyet düşmeli.
  if (ratio <= 1 / gate) return { outcome: "WORKED", ratio };
  if (ratio >= gate) return { outcome: "DIDNT", ratio };
  return { outcome: "INCONCLUSIVE", ratio };
}
