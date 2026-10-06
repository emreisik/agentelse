import type { GscQuotaKind } from "@/lib/seo/governor";
import { GoogleApiError } from "@/server/integrations/google/errors";

// Search Console'a özgü hata okuması (docs/google-search-console-plan.md
// §3.1 hata kataloğu, §3.3 kota yöneticisi). Genel sınıflama
// google/error-catalog.ts'tedir; burada yalnız kota türü ayrılır.

// Search Analytics "load" kotası Google'da ayrı bir kod taşımaz; 429
// RESOURCE_EXHAUSTED mesajındaki "load" kelimesinden tanınır (mesaj metni
// doğrulanmalı). Kelime sınırı "download" gibi sözcükleri dışarıda bırakır.
const LOAD_MESSAGE = /\bload\b/i;

export function gscQuotaKind(error: unknown): GscQuotaKind | null {
  if (!(error instanceof GoogleApiError)) return null;
  if (error.errorClass !== "RATE_LIMIT" && error.errorClass !== "QUOTA_DAILY") {
    return null;
  }
  if (LOAD_MESSAGE.test(error.message)) return "LOAD";
  return error.errorClass === "QUOTA_DAILY" ? "DAILY" : "RATE";
}

// Google isteği reddetti (geçersiz boyut birleşimi, RE2'nin kabul etmediği
// ifade vb.): tekrar denemek aynı sonucu verir.
export function isGscValidationError(error: unknown): boolean {
  return error instanceof GoogleApiError && error.errorClass === "VALIDATION";
}
