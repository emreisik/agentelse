import { significanceRatio } from "./stats";

// Gölge modun ölçümü (docs/meta-ads-autonomy.md): optimizer SHADOW'da kararını
// yazar ama uygulamaz. Bir hafta sonra iki şey ölçülür:
//  1. Sinyal sürdü mü? (karar gerçek bir sorunu mu işaret etti, yoksa kendi
//     kendine geçen gürültüyü mü?)
//  2. Sen aynısını yaptın mı? (insanla uyum)
// Bu bir karşı-olgusal DEĞİLDİR: "uygulansaydı şu olurdu" demez, çünkü
// uygulanmayan değişikliğin etkisi ölçülemez. Etki yalnız uygulanan kararlarda
// (decisions.ts evaluateDue) ölçülür. Saf ve belirleyici.

export type ShadowVerdict = "PERSISTED" | "RESOLVED" | "INCONCLUSIVE";

type Side = { spendMinor: number; results: number };

// Riski azaltan türler: sorun sürüyorsa karar haklıydı.
const RISK_KINDS = new Set(["PAUSE", "BUDGET_DOWN", "ARCHIVE", "CREATIVE_REFRESH"]);
export const SCORED_KINDS = [...RISK_KINDS, "BUDGET_UP"] as const;

// Sonuç başına maliyetin "düzelmedi" sayılması için alt sınır (%15'ten az iyileşme).
const NO_IMPROVEMENT = 0.85;
const MIN_N = 5;

function cpa(side: Side): number | null {
  return side.results > 0 ? side.spendMinor / side.results : null;
}

export function shadowVerdict(
  kind: string,
  before: Side,
  after: Side,
): { verdict: ShadowVerdict; ratio: number | null; exposureMinor: number } {
  const none = { verdict: "INCONCLUSIVE" as const, ratio: null, exposureMinor: 0 };
  if (!SCORED_KINDS.includes(kind as (typeof SCORED_KINDS)[number])) return none;
  // Sonraki hafta hiç harcama olmadıysa nesne durmuş ya da bitmiş: ölçülecek şey yok.
  if (after.spendMinor <= 0) return none;
  const cpaBefore = cpa(before);
  const cpaAfter = cpa(after);
  const ratio =
    cpaBefore !== null && cpaAfter !== null ? cpaAfter / cpaBefore : null;
  const n = Math.min(before.results, after.results);
  const gate = significanceRatio(n);

  if (kind === "BUDGET_UP") {
    // Ölçek önerisi: verim sürdüyse sinyal geçerliydi; belirgin bozulduysa değildi.
    if (cpaBefore === null || cpaAfter === null || n < MIN_N) return none;
    if (ratio !== null && ratio <= 1.1) return { verdict: "PERSISTED", ratio, exposureMinor: 0 };
    if (ratio !== null && ratio >= gate) return { verdict: "RESOLVED", ratio, exposureMinor: 0 };
    return { verdict: "INCONCLUSIVE", ratio, exposureMinor: 0 };
  }

  // Riski azaltan karar: harcama sürüyor ve sonuç gelmiyorsa ya da maliyet
  // düzelmediyse sorun sürdü; maliyet anlamlı biçimde kendiliğinden düştüyse geçti.
  if (cpaAfter === null) {
    // Harcama var, sonuç yok.
    return { verdict: "PERSISTED", ratio, exposureMinor: after.spendMinor };
  }
  if (cpaBefore === null) {
    // Önce sonuçsuzdu, şimdi sonuç getiriyor: kendiliğinden düzeldi.
    return { verdict: "RESOLVED", ratio, exposureMinor: 0 };
  }
  if (n < MIN_N) return { ...none, ratio };
  if (ratio !== null && ratio <= 1 / gate) {
    return { verdict: "RESOLVED", ratio, exposureMinor: 0 };
  }
  if (ratio !== null && ratio >= NO_IMPROVEMENT) {
    return { verdict: "PERSISTED", ratio, exposureMinor: after.spendMinor };
  }
  return { verdict: "INCONCLUSIVE", ratio, exposureMinor: 0 };
}

export type ObjectNow = {
  configuredStatus: string | null;
  dailyBudgetMinor: number | null;
  gone: boolean;
};

// İnsan aynı yönde bir değişiklik yaptı mı? Bilinmiyorsa null.
export function humanAgreed(
  kind: string,
  change: { field?: unknown; from?: unknown; to?: unknown } | null,
  now: ObjectNow,
): boolean | null {
  if (kind === "PAUSE" || kind === "ARCHIVE") {
    if (now.gone) return true;
    if (!now.configuredStatus) return null;
    return ["PAUSED", "ARCHIVED", "DELETED"].includes(now.configuredStatus);
  }
  if (kind === "BUDGET_DOWN" || kind === "BUDGET_UP") {
    const from = typeof change?.from === "number" ? change.from : null;
    if (from === null || now.dailyBudgetMinor === null) return null;
    return kind === "BUDGET_DOWN"
      ? now.dailyBudgetMinor < from
      : now.dailyBudgetMinor > from;
  }
  return null;
}

export type ShadowRow = {
  kind: string;
  verdict: ShadowVerdict;
  exposureMinor: number;
  humanAgreed: boolean | null;
};

export type ShadowKindScore = {
  kind: string;
  evaluated: number;
  persisted: number;
  resolved: number;
  inconclusive: number;
  // Sürenin payı: persisted / (persisted + resolved); karar verilemeyen sayılmaz.
  persistence: number | null;
  agreedOf: number;
  agreed: number;
  exposureMinor: number;
};

export type ShadowScorecard = {
  kinds: ShadowKindScore[];
  total: number;
  persistence: number | null;
  agreement: number | null;
  exposureMinor: number;
  // READY: kararlar geçerli ve yeterli sayıda; NOISY: çok fazla gürültü;
  // NOT_YET: henüz yeterli örnek yok.
  readiness: "READY" | "NOISY" | "NOT_YET";
};

// Terfi eşiği: yeterli karar ve çoğunun gerçek bir sorunu işaret etmesi.
export const READY_MIN_DECIDED = 20;
export const READY_MIN_PERSISTENCE = 0.7;

export function scorecardOf(rows: readonly ShadowRow[]): ShadowScorecard {
  const kinds = new Map<string, ShadowKindScore>();
  for (const row of rows) {
    const score =
      kinds.get(row.kind) ??
      {
        kind: row.kind,
        evaluated: 0,
        persisted: 0,
        resolved: 0,
        inconclusive: 0,
        persistence: null,
        agreedOf: 0,
        agreed: 0,
        exposureMinor: 0,
      };
    score.evaluated += 1;
    if (row.verdict === "PERSISTED") score.persisted += 1;
    else if (row.verdict === "RESOLVED") score.resolved += 1;
    else score.inconclusive += 1;
    score.exposureMinor += row.exposureMinor;
    if (row.humanAgreed !== null) {
      score.agreedOf += 1;
      if (row.humanAgreed) score.agreed += 1;
    }
    kinds.set(row.kind, score);
  }
  const list = [...kinds.values()].map((score) => ({
    ...score,
    persistence:
      score.persisted + score.resolved > 0
        ? score.persisted / (score.persisted + score.resolved)
        : null,
  }));
  const persisted = list.reduce((sum, s) => sum + s.persisted, 0);
  const resolved = list.reduce((sum, s) => sum + s.resolved, 0);
  const agreedOf = list.reduce((sum, s) => sum + s.agreedOf, 0);
  const agreed = list.reduce((sum, s) => sum + s.agreed, 0);
  const decided = persisted + resolved;
  const persistence = decided > 0 ? persisted / decided : null;
  return {
    kinds: list,
    total: rows.length,
    persistence,
    agreement: agreedOf > 0 ? agreed / agreedOf : null,
    exposureMinor: list.reduce((sum, s) => sum + s.exposureMinor, 0),
    readiness:
      decided < READY_MIN_DECIDED
        ? "NOT_YET"
        : (persistence ?? 0) >= READY_MIN_PERSISTENCE
          ? "READY"
          : "NOISY",
  };
}
