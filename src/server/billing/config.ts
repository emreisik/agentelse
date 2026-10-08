import "server-only";

import { getEnv } from "@/lib/env";
import type { BillingConfig } from "@/lib/billing/entitlements-core";

// Yalnız ISO 8601 (YYYY-MM-DD ya da tam zaman damgası): "15.11.2026" gibi yerel
// biçimler sessizce yanlış okunmasın ya da null olup mevcut müşterileri LEGACY
// saymaktan çıkarmasın.
const ISO_DATE =
  /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}(:\d{2}(\.\d{1,3})?)?(Z|[+-]\d{2}:\d{2}))?$/;

type ParsedDate = { date: Date | null; invalid: boolean };

function parseDate(value: string | undefined): ParsedDate {
  const trimmed = (value ?? "").trim();
  if (!trimmed) return { date: null, invalid: false };
  if (!ISO_DATE.test(trimmed)) return { date: null, invalid: true };
  const parsed = new Date(trimmed);
  return Number.isNaN(parsed.getTime())
    ? { date: null, invalid: true }
    : { date: parsed, invalid: false };
}

let warnedInvalid = false;

// Ortamdan faturalama ayarı. BILLING_MODE yazım hatası "off" okunur. Geçersiz bir
// BILLING_LEGACY_* tarihi "enforce"u "shadow"a DÜŞÜRÜR: yazım hatası hiçbir müşteriyi
// engelleyemez (hata yüksek sesle loglanır, ölçüm sürer).
export function getBillingConfig(): BillingConfig {
  const env = getEnv();
  const legacyBefore = parseDate(env.BILLING_LEGACY_BEFORE);
  const legacyUntil = parseDate(env.BILLING_LEGACY_UNTIL);
  // Kısmi env taklitlerinde (testler) alan olmayabilir: "off" (hiçbir şey değişmez).
  let mode = env.BILLING_MODE ?? "off";

  if (legacyBefore.invalid || legacyUntil.invalid) {
    if (!warnedInvalid) {
      warnedInvalid = true;
      console.error(
        "[billing] BILLING_LEGACY_BEFORE / BILLING_LEGACY_UNTIL must be ISO 8601 (YYYY-MM-DD or a full timestamp); ignoring the invalid value" +
          (mode === "enforce" ? " and running in shadow mode instead of enforce" : ""),
      );
    }
    if (mode === "enforce") mode = "shadow";
  }

  return {
    mode,
    legacyBefore: legacyBefore.date,
    legacyUntil: legacyUntil.date,
  };
}

// Testler için: tek seferlik uyarıyı sıfırla.
export function resetBillingConfigWarning(): void {
  warnedInvalid = false;
}
