import type { Features } from "./features";
import { floorBudget } from "./gates";

// Koruma (G3) ve optimizasyon (O2-O8, O13, O14) kuralları (docs/meta-ads-plan.md
// §6). Her kural saf bir fonksiyondur ve birden çok bulgu dönebilir (bugünkü
// "tek bulgu gölgelemesi" kalkar). Sayılar kanıt olarak döner; metin
// explain.ts'tedir. Hedef CPA yoksa hedef isteyen kurallar susar.

export type DecisionKind =
  | "PAUSE"
  | "BUDGET_DOWN"
  | "BUDGET_UP"
  | "CREATIVE_REFRESH"
  | "NOTIFY"
  | "ROLLBACK";

export type RuleCandidate = {
  ruleKey: string;
  ruleVersion: number;
  kind: DecisionKind;
  severity: "INFO" | "WARN" | "CRITICAL";
  // Acil kurallar öğrenme kapısına takılmaz.
  urgent: boolean;
  change?: { field: "dailyBudgetMinor" | "status"; from: number | string; to: number | string };
  evidence: Record<string, number | string | boolean | null>;
};

export type AdSetSubject = {
  externalId: string;
  name: string;
  dailyBudgetMinor: number | null;
  optimizationGoal: string | null;
  // Site dışı dönüşüm (geç atıf): son 24 saat değerlendirmeye girmez.
  offsite: boolean;
  features: Features;
  minDailyBudgetMinor: number | null;
  // Ad set'teki en yeni reklamın yaşı (gün).
  newestAdAgeDays: number | null;
};

export type AdSubject = {
  externalId: string;
  name: string;
  features: Features;
  // Aynı ad set'te açık başka reklam sayısı.
  siblingsActive: number;
  adSetSpend7dMinor: number;
  isVideo: boolean;
};

export type RuleTargets = {
  // Hedef CPA (minor unit): lansmanın KPI'ı ya da hesabın 28 günlük tabanı.
  targetCpaMinor: number | null;
  // Hesabın 28 günlük bağlantı tıklama oranı medyanı (0-1).
  accountLinkCtr: number | null;
};

const r = (value: number | null) =>
  value === null || !Number.isFinite(value) ? null : Math.round(value * 1000) / 1000;

export function adSetRules(subject: AdSetSubject, targets: RuleTargets): RuleCandidate[] {
  const out: RuleCandidate[] = [];
  const { features: f } = subject;
  const target = targets.targetCpaMinor;
  const daily = subject.dailyBudgetMinor;

  // G3: sonuçsuz harcama (site dışı dönüşümde son 24 saat hariç tutulur:
  // pencere dünden bir gün önce biter).
  const window = subject.offsite ? { ...f.d7, results: f.d7.results, spendMinor: f.d7.spendMinor - f.yesterday.spendMinor, impressions: f.d7.impressions - f.yesterday.impressions } : f.d7;
  const zeroThreshold = target ? 3 * target : daily ? daily * 7 * 0.5 : null;
  const resultsInWindow = subject.offsite
    ? (f.d7.results ?? 0) - (f.yesterday.results ?? 0)
    : f.d7.results;
  if (
    zeroThreshold &&
    resultsInWindow === 0 &&
    window.impressions >= 1000 &&
    window.spendMinor >= zeroThreshold
  ) {
    out.push({
      ruleKey: "G3_ZERO_RESULTS",
      ruleVersion: 1,
      kind: "PAUSE",
      severity: "WARN",
      urgent: true,
      change: { field: "status", from: "ACTIVE", to: "PAUSED" },
      evidence: {
        spendMinor: window.spendMinor,
        impressions: window.impressions,
        results: 0,
        thresholdMinor: zeroThreshold,
        offsite: subject.offsite,
      },
    });
  }

  if (target && daily && f.d7.cpaMinor !== null) {
    // O2: yüksek CPA → bütçe −%25 (P13 tabanıyla).
    if (f.d7.cpaMinor > 1.5 * target && f.d7.spendMinor >= 3 * target) {
      const to = floorBudget({
        proposedMinor: daily * 0.75,
        todaySpendMinor: f.today.spendMinor,
        minDailyBudgetMinor: subject.minDailyBudgetMinor,
      });
      if (to < daily) {
        out.push({
          ruleKey: "O2_HIGH_CPA",
          ruleVersion: 1,
          kind: "BUDGET_DOWN",
          severity: "WARN",
          urgent: false,
          change: { field: "dailyBudgetMinor", from: daily, to },
          evidence: {
            cpaMinor: Math.round(f.d7.cpaMinor),
            targetMinor: target,
            spendMinor: f.d7.spendMinor,
            results: f.d7.results,
          },
        });
      }
    }
    // O3: ölçek → +%20 (soğuk kitlede sıklık < 2,5, en az 10 sonuç).
    if (
      f.d7.cpaMinor <= 0.8 * target &&
      (f.d7.results ?? 0) >= 10 &&
      (f.frequency7d === null || f.frequency7d < 2.5)
    ) {
      out.push({
        ruleKey: "O3_SCALE",
        ruleVersion: 1,
        kind: "BUDGET_UP",
        severity: "INFO",
        urgent: false,
        change: { field: "dailyBudgetMinor", from: daily, to: Math.round(daily * 1.2) },
        evidence: {
          cpaMinor: Math.round(f.d7.cpaMinor),
          targetMinor: target,
          results: f.d7.results,
          frequency7d: r(f.frequency7d),
        },
      });
    }
  }

  // O8: learning limited ≥ 7 gün → bilgi.
  if (f.learningStatus === "FAIL" && f.ageDays >= 7) {
    out.push({
      ruleKey: "O8_LEARNING_LIMITED",
      ruleVersion: 1,
      kind: "NOTIFY",
      severity: "INFO",
      urgent: false,
      evidence: {
        ageDays: f.ageDays,
        suggestedDailyMinor: target ? Math.round((target * 50) / 7) : null,
      },
    });
  }

  // O14: kreatif ritmi (6 haftadır yeni reklam yok, harcama sürüyor).
  if (
    subject.newestAdAgeDays !== null &&
    subject.newestAdAgeDays >= 42 &&
    f.d7.spendMinor > 0
  ) {
    out.push({
      ruleKey: "O14_CREATIVE_CADENCE",
      ruleVersion: 1,
      kind: "CREATIVE_REFRESH",
      severity: "INFO",
      urgent: false,
      evidence: { newestAdAgeDays: subject.newestAdAgeDays },
    });
  }
  return out;
}

function change(now: number | null, before: number | null): number | null {
  if (now === null || before === null || before === 0) return null;
  return (now - before) / before;
}

export function adRules(subject: AdSubject, targets: RuleTargets): RuleCandidate[] {
  const out: RuleCandidate[] = [];
  const { features: f } = subject;

  // O4: yorgunluk (en az iki sinyal; ≥ 14 gün, ≥ 5.000 gösterim).
  if (f.ageDays >= 14 && f.d28.impressions >= 5000) {
    const ctrDrop = change(f.d7.linkCtr, f.prev7.linkCtr);
    const cpmRise = change(f.d7.cpmMinor, f.prev7.cpmMinor);
    const hookDrop = change(f.d7.hookRate, f.prev7.hookRate);
    const signals = [
      ctrDrop !== null && ctrDrop <= -0.2,
      cpmRise !== null && cpmRise >= 0.15,
      hookDrop !== null && hookDrop <= -0.2,
      f.frequency7d !== null && f.frequency7d > 3,
    ].filter(Boolean).length;
    if (signals >= 2) {
      out.push({
        ruleKey: "O4_FATIGUE",
        ruleVersion: 1,
        kind: "CREATIVE_REFRESH",
        severity: "WARN",
        urgent: false,
        evidence: {
          ctrChange: r(ctrDrop),
          cpmChange: r(cpmRise),
          hookChange: r(hookDrop),
          frequency7d: r(f.frequency7d),
          signals,
        },
      });
    }
  }

  // O5: kaybeden reklam (Meta harcamayı zaten çekiyorsa önerilmez).
  const target = targets.targetCpaMinor;
  if (
    target &&
    f.d7.results === 0 &&
    f.d7.spendMinor >= 2.5 * target &&
    f.d7.impressions >= 1000 &&
    subject.siblingsActive >= 2 &&
    subject.adSetSpend7dMinor > 0 &&
    f.d7.spendMinor / subject.adSetSpend7dMinor >= 0.05
  ) {
    out.push({
      ruleKey: "O5_LOSER_AD",
      ruleVersion: 1,
      kind: "PAUSE",
      severity: "INFO",
      urgent: false,
      change: { field: "status", from: "ACTIVE", to: "PAUSED" },
      evidence: { spendMinor: f.d7.spendMinor, targetMinor: target, results: 0 },
    });
  }

  // O6: düşük bağlantı CTR'ı.
  if (
    targets.accountLinkCtr !== null &&
    f.d7.impressions >= 2000 &&
    f.d7.linkCtr !== null &&
    f.d7.linkCtr < 0.7 * targets.accountLinkCtr
  ) {
    out.push({
      ruleKey: "O6_LOW_CTR",
      ruleVersion: 1,
      kind: "NOTIFY",
      severity: "INFO",
      urgent: false,
      evidence: { linkCtr: r(f.d7.linkCtr), accountLinkCtr: r(targets.accountLinkCtr) },
    });
  }

  if (subject.isVideo) {
    // O7: zayıf açılış (ilk 3 saniye).
    if (f.d7.impressions >= 1500 && f.d7.hookRate !== null && f.d7.hookRate < 0.2) {
      out.push({
        ruleKey: "O7_WEAK_HOOK",
        ruleVersion: 1,
        kind: "NOTIFY",
        severity: "INFO",
        urgent: false,
        evidence: { hookRate: r(f.d7.hookRate) },
      });
    }
    // O13: izleyici videoda kalmıyor.
    if (f.d7.video3s >= 300 && f.d7.holdRate !== null && f.d7.holdRate < 0.15) {
      out.push({
        ruleKey: "O13_WEAK_HOLD",
        ruleVersion: 1,
        kind: "NOTIFY",
        severity: "INFO",
        urgent: false,
        evidence: { holdRate: r(f.d7.holdRate) },
      });
    }
  }
  return out;
}

// Kural + nesne + ISO haftası: aynı haftada çift kayıt olmaz.
export function decisionFingerprint(
  ruleKey: string,
  externalId: string,
  now: Date,
): string {
  const date = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const day = date.getUTCDay() || 7;
  date.setUTCDate(date.getUTCDate() + 4 - day);
  const yearStart = new Date(Date.UTC(date.getUTCFullYear(), 0, 1));
  const week = Math.ceil(((date.getTime() - yearStart.getTime()) / 86_400_000 + 1) / 7);
  return `${ruleKey}:${externalId}:${date.getUTCFullYear()}-W${String(week).padStart(2, "0")}`;
}
