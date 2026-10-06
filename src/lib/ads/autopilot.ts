// Otomatik pilot kuralları (docs/meta-ads-plan.md §1.2, F7). Saf: sunucu
// tarafı kapıları (token, ayna, sayaç, aylık harcama) toplar, karar buradadır.
//
//   SUGGEST  her yazma onay ister (varsayılan).
//   GUARDED  yalnız riski azaltan eylemler kendiliğinden: kaçak harcamada ve
//            zarf dolunca duraklatma, platform içi sonuçta (mesaj, anında
//            form) sonuçsuz harcamada duraklatma, 72 saatte bir en çok %30
//            bütçe düşürme. Arşivleme otomatik değildir: Meta'da geri
//            alınamaz, her otomatik eylem ise geri alınabilir olmalı.
//   FULL     GUARDED'a ek olarak aylık tavan içinde, 72 saat arayla en çok
//            %20 bütçe artışı (önkoşullu; hesap saatiyle 18:00'den sonra yok).
// Proje başına 24 saatte en çok 5 otomatik eylem; aşılırsa karar insan
// onayına düşer.

export type AutonomyLevel = "SUGGEST" | "GUARDED" | "FULL";

export type AutoKind = "PAUSE" | "BUDGET_DOWN" | "BUDGET_UP";

export type AutoCandidate = {
  ruleKey: string;
  kind: AutoKind;
  // Bütçe kararında mevcut ve önerilen günlük bütçe (alt birim).
  fromBudgetMinor?: number | null;
  toBudgetMinor?: number | null;
  // Sonuç platform içi bir olay mı? Site dışı dönüşümde geç atıf yüzünden
  // sonuçsuz harcama duraklatması öneri kalır.
  onPlatformResult?: boolean;
};

export type FullGates = {
  prerequisitesMet: boolean;
  monthlyCapMinor: number | null;
  monthToDateSpendMinor: number;
  // Artışın ay sonuna kadarki ek maliyeti.
  projectedExtraMinor: number;
  accountLocalHour: number;
};

export type AutoGates = {
  level: AutonomyLevel;
  flagOn: boolean;
  tokenHealthy: boolean;
  mirrorFresh: boolean;
  writesDisabled: boolean;
  // Projede son 24 saatte denenen otomatik eylem sayısı.
  actionsLast24h: number;
  // Aynı nesnede son bütçe değişikliği (bizim kararımız ya da yazmamız).
  lastBudgetChangeAt: Date | null;
  now: Date;
  full?: FullGates;
};

export type AutoVerdict =
  { auto: true; riskReducing: boolean } | { auto: false; reason: AutoRefusal };

export type AutoRefusal =
  | "suggest_only"
  | "token"
  | "stale_mirror"
  | "daily_limit"
  | "rule_not_automatic"
  | "offsite_result"
  | "writes_disabled"
  | "not_risk_reducing"
  | "budget_changed_recently"
  | "needs_full_auto"
  | "full_prerequisites"
  | "raise_too_large"
  | "late_in_day"
  | "no_monthly_cap"
  | "over_monthly_cap";

export const AUTO_ACTIONS_PER_DAY = 5;
export const MAX_AUTO_CUT = 0.3;
export const MAX_AUTO_RAISE = 0.2;
export const AUTO_BUDGET_GAP_MS = 72 * 60 * 60_000;
export const LATE_RAISE_HOUR = 18;

// Kendiliğinden çalışabilen kurallar. Listede olmayan kural (ör. O5 kaybeden
// reklam, kreatif yenileme) hangi seviyede olursa olsun öneri kalır.
const AUTO_PAUSE_RULES: ReadonlySet<string> = new Set([
  "G1_RUNAWAY",
  "G2_ENVELOPE",
  "G2_MONTHLY_CAP",
  "G3_ZERO_RESULTS",
]);
const AUTO_CUT_RULES: ReadonlySet<string> = new Set([
  "O2_HIGH_CPA",
  "O10_PACE",
]);
const AUTO_RAISE_RULES: ReadonlySet<string> = new Set(["O3_SCALE"]);

// Mesaj ve anında form: sonuç Meta'nın içinde, gecikmesiz sayılır.
const ON_PLATFORM_GOALS: ReadonlySet<string> = new Set([
  "CONVERSATIONS",
  "REPLIES",
  "MESSAGING_PURCHASE_CONVERSION",
  "MESSAGING_APPOINTMENT_CONVERSION",
  "LEAD_GENERATION",
  "QUALITY_LEAD",
]);

export function onPlatformGoal(goal: string | null | undefined): boolean {
  return Boolean(goal && ON_PLATFORM_GOALS.has(goal));
}

function validBudget(value: number | null | undefined): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

// Riski azaltan eylem: duraklatma ya da en çok %30'luk bütçe düşürme.
// Yürütücü (MetaApiProvider) aynı denetimi bağımsız olarak yeniden yapar.
export function isRiskReducing(candidate: AutoCandidate): boolean {
  if (candidate.kind === "PAUSE") return true;
  if (candidate.kind !== "BUDGET_DOWN") return false;
  const { fromBudgetMinor: from, toBudgetMinor: to } = candidate;
  if (!validBudget(from) || !validBudget(to)) return false;
  return to < from && to >= Math.ceil(from * (1 - MAX_AUTO_CUT));
}

// FULL'ün sınırlı artışı: en çok %20.
export function isBoundedRaise(candidate: AutoCandidate): boolean {
  if (candidate.kind !== "BUDGET_UP") return false;
  const { fromBudgetMinor: from, toBudgetMinor: to } = candidate;
  if (!validBudget(from) || !validBudget(to)) return false;
  return to > from && to <= Math.floor(from * (1 + MAX_AUTO_RAISE));
}

function refuse(reason: AutoRefusal): AutoVerdict {
  return { auto: false, reason };
}

export function autopilotVerdict(
  candidate: AutoCandidate,
  gates: AutoGates,
): AutoVerdict {
  if (!gates.flagOn || gates.level === "SUGGEST") return refuse("suggest_only");
  if (!gates.tokenHealthy) return refuse("token");
  if (!gates.mirrorFresh) return refuse("stale_mirror");
  if (gates.actionsLast24h >= AUTO_ACTIONS_PER_DAY)
    return refuse("daily_limit");

  if (candidate.kind === "PAUSE") {
    if (!AUTO_PAUSE_RULES.has(candidate.ruleKey))
      return refuse("rule_not_automatic");
    if (
      candidate.ruleKey === "G3_ZERO_RESULTS" &&
      !candidate.onPlatformResult
    ) {
      return refuse("offsite_result");
    }
    return { auto: true, riskReducing: true };
  }

  // Acil durdurmada yalnız duraklatma geçer.
  if (gates.writesDisabled) return refuse("writes_disabled");
  const changedRecently =
    gates.lastBudgetChangeAt !== null &&
    gates.now.getTime() - gates.lastBudgetChangeAt.getTime() <
      AUTO_BUDGET_GAP_MS;

  if (candidate.kind === "BUDGET_DOWN") {
    if (!AUTO_CUT_RULES.has(candidate.ruleKey))
      return refuse("rule_not_automatic");
    if (!isRiskReducing(candidate)) return refuse("not_risk_reducing");
    if (changedRecently) return refuse("budget_changed_recently");
    return { auto: true, riskReducing: true };
  }

  // BUDGET_UP: yalnız FULL ve önkoşullarla.
  if (gates.level !== "FULL" || !gates.full) return refuse("needs_full_auto");
  if (!AUTO_RAISE_RULES.has(candidate.ruleKey))
    return refuse("rule_not_automatic");
  if (!gates.full.prerequisitesMet) return refuse("full_prerequisites");
  if (!isBoundedRaise(candidate)) return refuse("raise_too_large");
  if (changedRecently) return refuse("budget_changed_recently");
  if (gates.full.accountLocalHour >= LATE_RAISE_HOUR)
    return refuse("late_in_day");
  if (gates.full.monthlyCapMinor === null) return refuse("no_monthly_cap");
  if (
    gates.full.monthToDateSpendMinor + gates.full.projectedExtraMinor >
    gates.full.monthlyCapMinor
  ) {
    return refuse("over_monthly_cap");
  }
  return { auto: true, riskReducing: false };
}

// FULL önkoşulları (§1.2): her biri UI'da ayrı satır olarak gösterilir.
export type FullPrerequisites = {
  standardAccess: boolean;
  permanentToken: boolean;
  trackingHealthy: boolean;
  historyDays: number;
  monthlyCapSet: boolean;
};

export const FULL_HISTORY_DAYS = 30;

export function fullPrerequisitesMet(input: FullPrerequisites): boolean {
  return (
    input.standardAccess &&
    input.permanentToken &&
    input.trackingHealthy &&
    input.historyDays >= FULL_HISTORY_DAYS &&
    input.monthlyCapSet
  );
}

export function missingFullPrerequisites(input: FullPrerequisites): string[] {
  const missing: string[] = [];
  if (!input.standardAccess)
    missing.push("Meta has to give Agentelse standard Marketing API access");
  if (!input.permanentToken)
    missing.push(
      "Connect with a business (system user) login that doesn't expire",
    );
  if (!input.trackingHealthy)
    missing.push("The ad account and its tracking have to be healthy");
  if (input.historyDays < FULL_HISTORY_DAYS) {
    missing.push(
      `At least ${FULL_HISTORY_DAYS} days of ad history (now ${input.historyDays})`,
    );
  }
  if (!input.monthlyCapSet) missing.push("Set a monthly spending cap");
  return missing;
}

// Ay sonuna kadar kalan gün (bugün dahil); FULL artışının ek maliyeti için.
export function daysLeftInMonth(today: string): number {
  const [year, month, day] = today.split("-").map(Number) as [
    number,
    number,
    number,
  ];
  const last = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return Math.max(1, last - day + 1);
}

// Bildirim başlığı: "Auto-paused · Summer sale".
export function autoActionTitle(kind: AutoKind, name: string): string {
  if (kind === "PAUSE") return `Auto-paused · ${name}`;
  if (kind === "BUDGET_DOWN") return `Budget lowered automatically · ${name}`;
  return `Budget raised automatically · ${name}`;
}
