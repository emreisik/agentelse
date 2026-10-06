// Günlük toplamlardan dönem değerleri (docs/google-analytics-plan.md §3.4
// "dürüst sayı"). Yalnız toplanabilir metrikler toplanır; oranlar
// bileşenlerinden kesin hesaplanır. Dönem kullanıcıları günlüklerden
// toplanamaz (aynı kişi her gün sayılır): onlar kayan pencere raporundan gelir.

export type GaTotalsRow = {
  activeUsers: number;
  newUsers: number;
  sessions: number;
  engagedSessions: number;
  engagementSec: number;
  sessionDurationSec: number;
  screenPageViews: number;
  keyEvents: number;
  revenueMicros: bigint;
  transactions: number;
};

export type GaPeriodTotals = Omit<GaTotalsRow, "activeUsers"> & {
  // Günlük aktif kullanıcıların toplamı; tekil kullanıcı DEĞİLDİR.
  dailyActiveUsersSum: number;
};

export function sumTotals(rows: GaTotalsRow[]): GaPeriodTotals {
  const sum: GaPeriodTotals = {
    dailyActiveUsersSum: 0,
    newUsers: 0,
    sessions: 0,
    engagedSessions: 0,
    engagementSec: 0,
    sessionDurationSec: 0,
    screenPageViews: 0,
    keyEvents: 0,
    revenueMicros: BigInt(0),
    transactions: 0,
  };
  for (const row of rows) {
    sum.dailyActiveUsersSum += row.activeUsers;
    sum.newUsers += row.newUsers;
    sum.sessions += row.sessions;
    sum.engagedSessions += row.engagedSessions;
    sum.engagementSec += row.engagementSec;
    sum.sessionDurationSec += row.sessionDurationSec;
    sum.screenPageViews += row.screenPageViews;
    sum.keyEvents += row.keyEvents;
    sum.revenueMicros += row.revenueMicros;
    sum.transactions += row.transactions;
  }
  return sum;
}

// Etkileşimli oturum oranı (yüzde); oturum yoksa null.
export function engagementRate(totals: GaPeriodTotals): number | null {
  return totals.sessions > 0
    ? (totals.engagedSessions / totals.sessions) * 100
    : null;
}

// Ortalama oturum süresi (saniye; GA'nın averageSessionDuration'ı).
export function averageSessionSeconds(totals: GaPeriodTotals): number | null {
  return totals.sessions > 0
    ? totals.sessionDurationSec / totals.sessions
    : null;
}

// Oturum başına ortalama etkileşim süresi (saniye).
export function engagementSecondsPerSession(
  totals: GaPeriodTotals,
): number | null {
  return totals.sessions > 0 ? totals.engagementSec / totals.sessions : null;
}

// Gelir, mülkün para biriminde.
export function revenue(totals: GaPeriodTotals): number {
  return Number(totals.revenueMicros) / 1_000_000;
}
