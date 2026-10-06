import { gaRule } from "./registry";
import { GA_ACCEPTED_EXPIRE_DAYS, GA_DISMISS_SUPPRESS_DAYS } from "./schedule";
import type {
  GaFindingEvidence,
  GaFindingSeverity,
  GaFindingStatus,
  GaRange,
  GaRuleKey,
} from "./types";

// GA-F4 bulgu yaşam döngüsü (docs/google-analytics-plan.md §3.6, §6.3;
// ayrıntı docs/website-insights.md "Veri modeli"). Saf kararlar; yazımı
// sunucu tarafı (persist.ts, sweep.ts, lifecycle.ts) yapar.
//
//   OPEN → ACCEPTED | DISMISSED
//   ACCEPTED → DONE (yalnız evaluable kurallar) | DISMISSED
//   DONE → EVALUATED (WORKED | DIDNT | INCONCLUSIVE)
//   OPEN → EXPIRED (TTL; AN15 ay sonunda) | SUPERSEDED | RESOLVED
//   ACCEPTED (Done yok) → EXPIRED (acceptedAt + 60 gün)
//
// Her kapanış closedAt ve closedReason yazar: EXPIRED "ttl", SUPERSEDED
// "newer" | "shadow", RESOLVED "measurement" | "revised" | "recovered",
// DISMISSED "dismissed" (+ dismissedAt), EVALUATED "evaluated"
// (+ evaluatedAt). Böylece her satır sonunda kapanır ve 24 aylık saklama
// eksiksizdir.

const DAY_MS = 86_400_000;

export type GaFindingAction = "accept" | "dismiss" | "done";

export function nextFindingStatus(
  status: GaFindingStatus,
  action: GaFindingAction,
  evaluable: boolean,
): GaFindingStatus | null {
  switch (action) {
    case "accept":
      return status === "OPEN" ? "ACCEPTED" : null;
    case "dismiss":
      return status === "OPEN" || status === "ACCEPTED" ? "DISMISSED" : null;
    case "done":
      return status === "ACCEPTED" && evaluable ? "DONE" : null;
  }
}

const SEVERITY_RANK: Record<GaFindingSeverity, number> = {
  INFO: 1,
  WARN: 2,
  CRITICAL: 3,
};

function severityRank(severity: GaFindingSeverity): number {
  return SEVERITY_RANK[severity] ?? 0;
}

// Aynı bağ + kural + konu için en son satıra göre adayın akıbeti. Adaylar
// periodStart artan sırada işlenir.
// - Üzerinde çalışılan (ACCEPTED/DONE) evaluable satır her yinelemede
//   bastırır.
// - Olay kuralları her dönem yeni satır alır: supersede, reddetme bastırması
//   ve "stale" yok.
// - Koşul kurallarında daha eski dönem "stale" (yeni satır eskisiyle
//   kapanmaz), OPEN satır SUPERSEDED olur, 56 gün içindeki reddetme ancak
//   önem derecesi yükselirse aşılır.
export function persistDecision(input: {
  recurrence: "event" | "condition";
  latest: {
    status: GaFindingStatus;
    severity: GaFindingSeverity;
    dismissedAt: Date | null;
    evaluable: boolean;
    periodStart: string;
  } | null;
  candidate: { severity: GaFindingSeverity; periodStart: string };
  now: Date;
}): "create" | "supersede" | "suppress" | "stale" {
  const { latest, candidate } = input;
  if (latest === null) return "create";
  if (
    latest.evaluable &&
    (latest.status === "ACCEPTED" || latest.status === "DONE")
  ) {
    return "suppress";
  }
  if (input.recurrence === "event") return "create";
  if (candidate.periodStart < latest.periodStart) return "stale";
  if (latest.status === "OPEN") return "supersede";
  if (
    latest.status === "DISMISSED" &&
    latest.dismissedAt !== null &&
    input.now.getTime() - latest.dismissedAt.getTime() <=
      GA_DISMISS_SUPPRESS_DAYS * DAY_MS &&
    severityRank(candidate.severity) <= severityRank(latest.severity)
  ) {
    return "suppress";
  }
  return "create";
}

// "ttl" üç durumda:
// - OPEN ve createdAt'ten bu yana kuralın TTL'i geçti (AN15: bugün dönem
//   sonunu, yani ay sonunu geçti);
// - ACCEPTED, Done yok ve acceptedAt 60 günden eski (evaluable olsun
//   olmasın).
export function expiryReason(input: {
  ruleKey: GaRuleKey;
  status: GaFindingStatus;
  createdAt: Date;
  acceptedAt: Date | null;
  doneAt: Date | null;
  evaluable: boolean;
  periodEnd: string;
  today: string;
  now: Date;
}): "ttl" | null {
  const now = input.now.getTime();
  if (input.status === "OPEN") {
    if (input.ruleKey === "AN15") {
      return input.today > input.periodEnd ? "ttl" : null;
    }
    const ttlMs = gaRule(input.ruleKey).ttlDays * DAY_MS;
    return now - input.createdAt.getTime() > ttlMs ? "ttl" : null;
  }
  if (input.status === "ACCEPTED" && input.doneAt === null) {
    // acceptedAt her kabulde yazılır; yoksa satır yine kapanabilsin diye
    // createdAt.
    const since = (input.acceptedAt ?? input.createdAt).getTime();
    return now - since > GA_ACCEPTED_EXPIRE_DAYS * DAY_MS ? "ttl" : null;
  }
  return null;
}

// `days` içinden aralığa düşenler, sıralı ve tekil.
export function rangesOverlap(a: GaRange, days: Iterable<string>): string[] {
  const inside = new Set<string>();
  for (const day of days) {
    if (day >= a.from && day <= a.to) inside.add(day);
  }
  return [...inside].sort();
}

// RESOLVED "measurement": yalnız OPEN satırlar ve şüpheli günleri kendisi
// dışlamayan kurallar; kural koşarken bilinmeyen şüpheli günler için.
// Pencere kuralları (AN3–AN8, AN10–AN12) şüpheli günleri zaten dışlayan
// yükleyicilerle çalışır, hiç çözülmez.
export function measurementResolvable(input: {
  ruleKey: GaRuleKey;
  status: GaFindingStatus;
  evidence: GaFindingEvidence;
  period: GaRange;
  suspect: ReadonlySet<string>;
}): boolean {
  const { evidence, period, suspect } = input;
  if (input.status !== "OPEN" || suspect.size === 0) return false;
  switch (input.ruleKey) {
    case "AN1":
      if (evidence.rule !== "AN1") return false;
      return evidence.mode === "day"
        ? suspect.has(evidence.target)
        : rangesOverlap(period, suspect).length > 0;
    case "AN2": {
      if (evidence.rule !== "AN2") return false;
      const known = new Set(evidence.suspectDays);
      return [
        ...rangesOverlap(evidence.current, suspect),
        ...rangesOverlap(evidence.previous, suspect),
      ].some((day) => !known.has(day));
    }
    case "AN9":
      return rangesOverlap(period, suspect).length > 0;
    case "AN15":
      if (evidence.rule !== "AN15") return false;
      return (
        rangesOverlap({ from: period.from, to: evidence.through }, suspect)
          .length > 0
      );
    default:
      return false;
  }
}
