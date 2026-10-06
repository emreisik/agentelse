// Optimizasyon kapıları (docs/meta-ads-plan.md §3.5 adım 3, O1): öğrenme
// koruması, hız sınırı ve asgari veri. Acil kurallar (G) öğrenme kapısına
// takılmaz. Saf.

export const LEARNING_QUIET_MS = 72 * 60 * 60_000;
export const BUDGET_CHANGE_GAP_MS = 24 * 60 * 60_000;
export const SIGNIFICANT_EDITS_PER_WEEK = 2;

export function learningBlocks(
  subject: { learningStatus: string | null; lastSigEditAt: Date | null },
  now: Date,
): boolean {
  if (subject.learningStatus === "LEARNING") return true;
  return Boolean(
    subject.lastSigEditAt && now.getTime() - subject.lastSigEditAt.getTime() < LEARNING_QUIET_MS,
  );
}

export type RecentChange = { kind: string; at: Date };

// Ad set başına 24 saatte en çok bir bütçe değişikliği; haftada en çok iki
// anlamlı düzenleme.
export function rateBlocks(
  kind: string,
  recent: readonly RecentChange[],
  now: Date,
): boolean {
  const budget = kind === "BUDGET_UP" || kind === "BUDGET_DOWN";
  if (
    budget &&
    recent.some(
      (change) =>
        (change.kind === "BUDGET_UP" || change.kind === "BUDGET_DOWN" || change.kind === "ROLLBACK") &&
        now.getTime() - change.at.getTime() < BUDGET_CHANGE_GAP_MS,
    )
  ) {
    return true;
  }
  const week = recent.filter(
    (change) =>
      change.kind !== "NOTIFY" &&
      change.kind !== "CREATIVE_REFRESH" &&
      now.getTime() - change.at.getTime() < 7 * 24 * 60 * 60_000,
  );
  return week.length >= SIGNIFICANT_EDITS_PER_WEEK && kind !== "PAUSE";
}

// Düşürmede yeni bütçe bugünkü harcamanın %110'unun ve asgari bütçenin
// altına inemez (P13).
export function floorBudget(input: {
  proposedMinor: number;
  todaySpendMinor: number;
  minDailyBudgetMinor: number | null;
}): number {
  return Math.max(
    Math.round(input.proposedMinor),
    Math.ceil((input.todaySpendMinor * 11) / 10),
    input.minDailyBudgetMinor ?? 0,
  );
}
