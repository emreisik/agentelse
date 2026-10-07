import { gscToday } from "@/lib/seo/dates";

import { INSPECTION_ALERT_KINDS } from "./kinds";
import type {
  SeoActionStatus,
  SeoFixKind,
  SeoOutcome,
  VerificationMethod,
} from "./types";

// SEO eylem yaşam döngüsü (docs/google-search-console-plan.md SC-F6): durum
// makinesi, zamanlamalar ve ölçüm çapası. Saf; hiçbir yerde Date.now()
// çağrılmaz, bütün zamanlar girdi olarak gelir.

const DAY_MS = 86_400_000;

// Eylem türüne göre ölçüm penceresi (gün); W3'ün bulgu penceresiyle aynıdır,
// CWV_FIX ve SITEMAP_FIX yalnız eylem tarafında vardır.
export const ACTION_WINDOW_DAYS: Readonly<Record<SeoFixKind, number>> = {
  TITLE_META: 28,
  CONTENT_REFRESH: 56,
  NEW_CONTENT: 90,
  LOCALIZE: 90,
  INTERNAL_LINKS: 42,
  CONSOLIDATE: 56,
  TECH_FIX: 28,
  SCHEMA: 28,
  CWV_FIX: 56,
  SITEMAP_FIX: 14,
};

export const VERIFY_EVERY_MS = 86_400_000;
export const VERIFY_RETRY_MS = 1_800_000;
export const VERIFY_QUICK_RETRIES_PER_DAY = 3;
export const RECENT_CHANGE_DAYS = 14;
export const ALERT_MIN_HOLD_DAYS = 7;
export const GOOGLE_RECHECK_MS = 259_200_000;
export const GOOGLE_WAIT_DAYS = 21;
export const EXPIRE_PROPOSED_DAYS = 60;
export const EXPIRE_ACCEPTED_DAYS = 90;
export const EVAL_RETRY_MS = 86_400_000;
export const EVAL_GIVE_UP_DAYS = 21;
export const ACTION_LEASE_MS = 300_000;
export const ACTION_RETENTION_DAYS = 1095;
export const CHECK_NOW_MIN_GAP_MS = 600_000;
export const ACTIONS_PER_RUN = 10;
export const ACTIONS_PER_PROJECT_RUN = 5;
export const PAGES_PER_ACTION = 5;
export const FETCHES_PER_ACTION = 6;
export const VERIFY_RUN_BUDGET_MS = 45_000;

export type SeoActionEvent =
  | "ACCEPT"
  | "DISMISS"
  | "APPLY"
  | "UNDO_APPLY"
  | "CONFIRM_LIVE"
  | "VERIFIED"
  | "START_MEASURING"
  | "EVALUATED"
  | "EXPIRE";

// Geçerli geçişin yeni durumu; geçersizse null.
export function nextActionStatus(
  event: SeoActionEvent,
  current: SeoActionStatus,
  outcome?: SeoOutcome,
): SeoActionStatus | null {
  const open = current === "PROPOSED" || current === "ACCEPTED";
  switch (event) {
    case "ACCEPT":
      return open ? "ACCEPTED" : null;
    case "DISMISS":
      return open ? "DISMISSED" : null;
    case "APPLY":
      return open ? "APPLIED" : null;
    case "UNDO_APPLY":
      return current === "APPLIED" ? "ACCEPTED" : null;
    case "CONFIRM_LIVE":
    case "VERIFIED":
      return current === "APPLIED" ? "VERIFIED" : null;
    case "START_MEASURING":
      return current === "APPLIED" || current === "VERIFIED"
        ? "EVALUATING"
        : null;
    case "EVALUATED":
      return current === "EVALUATING" && outcome ? outcome : null;
    case "EXPIRE":
      return open || current === "APPLIED" ? "EXPIRED" : null;
  }
}

export function isTerminal(status: SeoActionStatus): boolean {
  return (
    status === "WORKED" ||
    status === "DIDNT" ||
    status === "INCONCLUSIVE" ||
    status === "DISMISSED" ||
    status === "EXPIRED"
  );
}

const GOOGLE_STAGE_KINDS: ReadonlySet<SeoFixKind> = new Set([
  "CONTENT_REFRESH",
  "TECH_FIX",
  "SCHEMA",
  "NEW_CONTENT",
  "LOCALIZE",
]);

// "Yayında ama Google bekleniyor" aşaması: yalnız Google'ın yeniden taramasının
// ölçümü etkilediği türlerde, uyarıdan doğmayan ve URL Inspection kullanılabilen
// eylemlerde.
export function needsGoogleStage(
  kind: SeoFixKind,
  inspectionAvailable: boolean,
  fromAlert: boolean,
): boolean {
  return inspectionAvailable && !fromAlert && GOOGLE_STAGE_KINDS.has(kind);
}

export type MeasuringFields = {
  measureFrom: Date;
  evaluateAfter: Date;
  nextCheckAt: Date;
};

const GOOGLE_ANCHOR_KINDS: ReadonlySet<SeoFixKind> = new Set([
  "CONTENT_REFRESH",
  "NEW_CONTENT",
  "LOCALIZE",
]);

function addDaysTo(date: Date, days: number): Date {
  return new Date(date.getTime() + days * DAY_MS);
}

// Tek ölçüm çapası kuralı: ölçüme geçen her yol (doğrulayıcı, CONFIRM_LIVE,
// DETECTED) bunu çağırır, değerlendirici yeniden hesaplamaz.
export function measuringFields(input: {
  kind: SeoFixKind;
  appliedAt: Date;
  verifiedAt: Date | null;
  googleCrawlAt: Date | null;
  method: VerificationMethod | null;
  fromAlert: boolean;
}): MeasuringFields {
  // Kullanıcı değişikliğin appliedAt'ta yayına girdiğini söyler; doğrulama
  // zamanı çapa olmaz.
  const verifiedAt = input.method === "USER" ? null : input.verifiedAt;
  const measureFrom = GOOGLE_ANCHOR_KINDS.has(input.kind)
    ? (input.googleCrawlAt ?? verifiedAt ?? input.appliedAt)
    : input.appliedAt;
  let evaluateAfter = addDaysTo(measureFrom, ACTION_WINDOW_DAYS[input.kind]);
  if (input.fromAlert) {
    // "Düzeltilmiş kaldı" en az bir hafta kapsasın.
    const hold = addDaysTo(verifiedAt ?? input.appliedAt, ALERT_MIN_HOLD_DAYS);
    if (hold.getTime() > evaluateAfter.getTime()) evaluateAfter = hold;
  }
  return { measureFrom, evaluateAfter, nextCheckAt: evaluateAfter };
}

// Sorma ve süre aşımı günleri (uygulandığı andan itibaren).
export function verifyTimingFor(
  kind: SeoFixKind,
  alertKind: string | null,
): { askDays: number; expireDays: number } {
  if (kind === "CWV_FIX") return { askDays: 35, expireDays: 70 };
  if (alertKind !== null && INSPECTION_ALERT_KINDS.includes(alertKind)) {
    return { askDays: 21, expireDays: 60 };
  }
  return { askDays: 14, expireDays: 45 };
}

export type VerifyPlan = {
  nextCheckAt: Date;
  ask: boolean;
  expire: boolean;
  quickRetries: { day: string; count: number };
};

// Doğrulanamayan APPLIED eylemin bir sonraki kontrolü. Getirme hatasında 30 dk
// sonra yeniden dener (PT günü başına en çok 3 kez), aksi hâlde 24 saat sonra.
export function verifySchedule(input: {
  now: Date;
  appliedAt: Date;
  askedAt: Date | null;
  fetchFailed: boolean;
  quickRetries: { day: string; count: number } | null;
  timing: { askDays: number; expireDays: number };
}): VerifyPlan {
  const { now, appliedAt, timing } = input;
  const day = gscToday(now);
  const counter =
    input.quickRetries && input.quickRetries.day === day
      ? input.quickRetries
      : { day, count: 0 };
  const expire =
    now.getTime() >= addDaysTo(appliedAt, timing.expireDays).getTime();
  const ask =
    input.askedAt === null &&
    now.getTime() >= addDaysTo(appliedAt, timing.askDays).getTime();
  if (input.fetchFailed && counter.count < VERIFY_QUICK_RETRIES_PER_DAY) {
    return {
      nextCheckAt: new Date(now.getTime() + VERIFY_RETRY_MS),
      ask,
      expire,
      quickRetries: { day, count: counter.count + 1 },
    };
  }
  return {
    nextCheckAt: new Date(now.getTime() + VERIFY_EVERY_MS),
    ask,
    expire,
    quickRetries: counter,
  };
}

// VERIFIED aşaması: 3 günde bir yeniden tarama iste, 21 günde vazgeç.
export function googleSchedule(input: {
  now: Date;
  verifiedAt: Date;
  requestedAt: Date | null;
}): { request: boolean; nextCheckAt: Date; giveUp: boolean } {
  const { now } = input;
  const giveUp =
    now.getTime() >= addDaysTo(input.verifiedAt, GOOGLE_WAIT_DAYS).getTime();
  const due =
    input.requestedAt === null ||
    now.getTime() >= input.requestedAt.getTime() + GOOGLE_RECHECK_MS;
  return {
    request: !giveUp && due,
    nextCheckAt: new Date(now.getTime() + GOOGLE_RECHECK_MS),
    giveUp,
  };
}

// Dokunulmayan öneri/kabul edilmiş eylemlerin süre aşımı sınırları.
export function staleOpenCutoffs(now: Date): {
  proposedBefore: Date;
  acceptedBefore: Date;
} {
  return {
    proposedBefore: addDaysTo(now, -EXPIRE_PROPOSED_DAYS),
    acceptedBefore: addDaysTo(now, -EXPIRE_ACCEPTED_DAYS),
  };
}
