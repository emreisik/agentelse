import { addDays } from "@/lib/website-analytics/days";

// GA-F3 denetim zamanlaması (docs/measurement-health.md "Çalışma"). Saf
// fonksiyonlar: runner yalnız bunların söylediğini yapar.

export const GA_HEALTH_VERSION = 1;
// Parmak izi değişmese de tam değerlendirme en geç bu aralıkla yenilenir.
export const GA_HEALTH_EVERY_MS = 6 * 3_600_000;
export const GA_HEALTH_LEASE_MS = 3 * 60_000;
export const GA_SITE_SCAN_EVERY_MS = 7 * 24 * 3_600_000;
export const GA_PII_PROBE_EVERY_MS = 7 * 24 * 3_600_000;
// "Check again" / "I fixed it" en çok bu sıklıkta.
export const GA_RECHECK_EVERY_MS = 10 * 60_000;

// Değerlendirmeyi etkileyen durumun özeti: mülk günü, günlük çekimin
// tamamladığı gün ve son metadata günü.
export function gaHealthFingerprint(input: {
  today: string;
  lastDailyDate: string | null;
  lastMetadataAt: Date | null;
}): string {
  const metadataDay = input.lastMetadataAt
    ? input.lastMetadataAt.toISOString().slice(0, 10)
    : "-";
  return `v${GA_HEALTH_VERSION}|${input.today}|${input.lastDailyDate ?? "-"}|${metadataDay}`;
}

export function gaHealthDue(input: {
  fingerprint: string;
  run: {
    fingerprint: string | null;
    evaluatedAt: Date | null;
    recheckRequestedAt: Date | null;
  } | null;
  now: Date;
}): boolean {
  const { run } = input;
  if (!run || !run.evaluatedAt) return true;
  if (run.fingerprint !== input.fingerprint) return true;
  if (input.now.getTime() - run.evaluatedAt.getTime() >= GA_HEALTH_EVERY_MS) {
    return true;
  }
  // "I fixed it" sonrası satır içi tur başarısız olduysa sıradaki tick alır.
  return (
    run.recheckRequestedAt !== null &&
    run.recheckRequestedAt.getTime() > run.evaluatedAt.getTime()
  );
}

// Haftalık site taraması / PII yoklaması; force ("I fixed it") her zaman.
export function weeklyProbeDue(
  lastAt: Date | null,
  now: Date,
  everyMs: number,
  force: boolean,
): boolean {
  return force || !lastAt || now.getTime() - lastAt.getTime() >= everyMs;
}

// Yeniden denetim isteği 10 dakikada bir; süre dolmadıysa açılacağı an.
export function recheckThrottledUntil(
  requestedAt: Date | null,
  now: Date,
): Date | null {
  if (!requestedAt) return null;
  const until = new Date(requestedAt.getTime() + GA_RECHECK_EVERY_MS);
  return until.getTime() > now.getTime() ? until : null;
}

// Günlük çekimin bitirdiği son mülk günü: lastDailyDate "bugün" olarak
// yazılır, tamamlanan gün bir öncekidir.
export function completeThroughOf(lastDailyDate: string | null): string | null {
  return lastDailyDate ? addDays(lastDailyDate, -1) : null;
}
