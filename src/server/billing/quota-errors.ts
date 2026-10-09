import "server-only";

import type { AccessReason } from "@/lib/billing/entitlements-core";
import type { UsageUnit } from "@/lib/billing/plans";
import { AgentelseError, isAgentelseError } from "@/server/security/errors";

// Plan hakkı yetmediğinde ücretli bir operasyonun başlamasını durduran iki hata.
// Bunlar HATA değil BEKLEME'dir: worker yeniden denemez ya da dead-letter yapmaz,
// işi WAITING_BUDGET'e park eder (execution-worker.ts); sohbet "hak bitti" kartı
// gösterir.
//
// MESAJ KURALI: error-classifier.ts düz metin eşleştirir ve /quota exceeded|
// billing|insufficient quota/ → "BILLING, sağlayıcıyı bozar" kuralı vardır. Buraya
// o sözcükleri (ya da 401/403/502-504 gibi sayıları, "safety", "network",
// "timeout") YAZMA: bir kiracının hakkı bitince OpenAI sağlayıcısı TÜM kiracılar
// için devre kesiciyle kapanmasın. Sayılar `meta`'dadır, mesajda değil
// (quota-errors.test.ts bunu sınıflandırıcıyla doğrular).

export type QuotaDetail = {
  unit: UsageUnit;
  // Operasyonun istediği miktar (IMAGE: adet, AI_MICROS: mikro-USD).
  needed: number;
  // Şu an kullanılabilir miktar.
  available: number;
  // Dönem havuzunun yenileneceği an (bilinmiyorsa null).
  resetsAt: Date | null;
};

export class QuotaExceededError extends AgentelseError {
  readonly detail: QuotaDetail;

  constructor(detail: QuotaDetail) {
    super("QUOTA_EXCEEDED", "Plan allowance used up for this period", {
      retryable: false,
      meta: {
        unit: detail.unit,
        needed: detail.needed,
        available: detail.available,
        resetsAt: detail.resetsAt?.toISOString() ?? null,
      },
    });
    this.name = "QuotaExceededError";
    this.detail = detail;
  }
}

export class NoPlanError extends AgentelseError {
  readonly reason: AccessReason | "UNIT_NOT_SOLD";

  constructor(reason: AccessReason | "UNIT_NOT_SOLD") {
    super("NO_PLAN", "This workspace has no active plan for this action", {
      retryable: false,
      meta: { reason },
    });
    this.name = "NoPlanError";
    this.reason = reason;
  }
}

// Worker, sohbet ve eylemler "park et / kullanıcıya hak kartı göster" kararını
// buradan verir. Kod karşılaştırması (instanceof değil): modül kopyaları ya da
// serileştirme sonrası da çalışır.
export function isQuotaError(
  error: unknown,
): error is QuotaExceededError | NoPlanError {
  return (
    isAgentelseError(error) &&
    (error.code === "QUOTA_EXCEEDED" || error.code === "NO_PLAN")
  );
}

// Motor çağrılarının (ReasoningService.run) tüketicileri bütçe duruşunu zaten
// BUDGET_EXCEEDED koduyla tanır ve zarifçe ele alır: sinyal/fikir/medya analizi
// ertelenir, tick adımı hata yazmadan atlar, kullanıcıya "limit" denir. Plan hakkı
// bitince de AYNI yoldan geçsinler diye sınırda BUDGET_EXCEEDED'a çevrilir;
// `meta.limit` günlük sayaçlardan ayırır (limit-notice.ts doğru kartı seçer).
// Yürütme işleri ve sohbet bu çeviriyi KULLANMAZ: onlar QUOTA_EXCEEDED/NO_PLAN'ı
// doğrudan işler (park, hak kartı).
export const PLAN_ALLOWANCE_LIMIT = "planAllowance";
export const NO_PLAN_LIMIT = "noPlan";

export function asBudgetStop(error: QuotaExceededError | NoPlanError) {
  return new AgentelseError("BUDGET_EXCEEDED", error.message, {
    retryable: false,
    meta: {
      ...error.meta,
      limit: error.code === "QUOTA_EXCEEDED" ? PLAN_ALLOWANCE_LIMIT : NO_PLAN_LIMIT,
    },
  });
}
