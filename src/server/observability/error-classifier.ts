import "server-only";

// Hata sınıflandırma: sistemdeki her hata mesajı (sağlayıcı adaptörleri,
// ReasoningService, outbox worker) serbest metin olarak kaydediliyor.
// Otomatik kurtarma kararı verebilmek için önce bu metnin NE anlama
// geldiğini bilmek gerekir — "kredi bitti" ile "ağ zaman aşımı" aynı
// müdahaleyi almaz.
//
// Sınıflandırma bilinçli olarak metin eşleştirmesine dayanıyor: sağlayıcı
// SDK'ları hata tiplerini birbirinden farklı modelliyor ve hepsi sonunda
// tek bir `errorMessage` string'ine düşüyor.

export type ErrorCategory =
  | "BILLING" // kredi/kota bitti — para gerektirir
  | "AUTH" // anahtar geçersiz/eksik — yapılandırma gerektirir
  | "RATE_LIMIT" // geçici, bekleyip yeniden dene
  | "TIMEOUT" // geçici, yeniden dene
  | "NETWORK" // geçici, yeniden dene
  | "PROVIDER_UNAVAILABLE" // yetenek için sağlayıcı yok — yapılandırma
  | "CONFIGURATION" // eksik ajan/profil/model ayarı
  | "INVALID_RESULT" // sağlayıcı beklenen şemayı döndürmedi
  | "REFUSED" // model isteği reddetti
  | "UNKNOWN";

export type RecoveryStrategy =
  | "RETRY" // otomatik yeniden kuyruğa al
  | "RETRY_AFTER_COOLDOWN" // sağlayıcı soğuyunca yeniden dene
  | "NEEDS_CONFIG" // insan yapılandırma yapmadan anlamsız
  | "NEEDS_HUMAN"; // insan kararı gerekir

export type ErrorClassification = {
  category: ErrorCategory;
  strategy: RecoveryStrategy;
  // Sağlayıcı sağlığını bozmalı mı? Kota/anahtar hataları sağlayıcıyı
  // devre dışı bırakır; şema hatası tek bir işin sorunudur.
  degradesProvider: boolean;
  summary: string;
};

const RULES: Array<{
  category: ErrorCategory;
  patterns: RegExp[];
  strategy: RecoveryStrategy;
  degradesProvider: boolean;
  summary: string;
}> = [
  {
    category: "BILLING",
    patterns: [
      /credit balance is too low/i,
      /insufficient[_ ]quota/i,
      /quota exceeded/i,
      /billing/i,
      /payment required/i,
    ],
    strategy: "NEEDS_CONFIG",
    degradesProvider: true,
    summary: "Sağlayıcı bakiyesi/kotası yetersiz — hesaba kredi eklenmeli.",
  },
  {
    category: "AUTH",
    patterns: [
      /invalid[_ ]api[_ ]key/i,
      /unauthorized/i,
      /authentication[_ ]error/i,
      /permission denied/i,
      /\b401\b/,
      /\b403\b/,
      /is not configured/i,
    ],
    strategy: "NEEDS_CONFIG",
    degradesProvider: true,
    summary: "Kimlik doğrulama başarısız — API anahtarı eksik veya geçersiz.",
  },
  {
    category: "RATE_LIMIT",
    patterns: [
      /rate[_ ]limit/i,
      /too many requests/i,
      /\b429\b/,
      /overloaded/i,
    ],
    strategy: "RETRY_AFTER_COOLDOWN",
    degradesProvider: true,
    summary:
      "Hız sınırına takıldı — sağlayıcı soğuduktan sonra yeniden denenecek.",
  },
  {
    category: "TIMEOUT",
    patterns: [/timeout/i, /timed out/i, /\baborted\b/i, /ETIMEDOUT/],
    strategy: "RETRY",
    degradesProvider: false,
    summary: "İşlem zaman aşımına uğradı — yeniden denenebilir.",
  },
  {
    category: "NETWORK",
    patterns: [
      /ECONNREFUSED/,
      /ECONNRESET/,
      /ENOTFOUND/,
      /socket hang up/i,
      /fetch failed/i,
      /network/i,
      /\b50[234]\b/,
    ],
    strategy: "RETRY",
    degradesProvider: true,
    summary: "Ağ/sağlayıcı erişilemedi — yeniden denenebilir.",
  },
  {
    category: "PROVIDER_UNAVAILABLE",
    patterns: [/no execution provider available/i, /PROVIDER_UNAVAILABLE/],
    strategy: "NEEDS_CONFIG",
    degradesProvider: false,
    summary:
      "Bu yetenek için yapılandırılmış sağlayıcı yok — entegrasyon gerekir.",
  },
  {
    category: "CONFIGURATION",
    patterns: [
      /unknown agent id/i,
      /no browser profile/i,
      /unknown model/i,
      /model not found/i,
    ],
    strategy: "NEEDS_CONFIG",
    degradesProvider: false,
    summary: "Eksik/yanlış yapılandırma — ajan, profil veya model bulunamadı.",
  },
  {
    category: "INVALID_RESULT",
    patterns: [
      /did not return the confirmed schema/i,
      /non-JSON output/i,
      /returned no text/i,
      /INVALID_PROVIDER_RESULT/,
    ],
    strategy: "RETRY",
    degradesProvider: false,
    summary: "Sağlayıcı beklenen biçimde yanıt vermedi — yeniden denenebilir.",
  },
  {
    category: "REFUSED",
    patterns: [/declined the request/i, /\brefusal\b/i, /safety/i],
    strategy: "NEEDS_HUMAN",
    degradesProvider: false,
    summary:
      "Model isteği reddetti — brief insan tarafından gözden geçirilmeli.",
  },
];

const UNKNOWN: ErrorClassification = {
  category: "UNKNOWN",
  strategy: "NEEDS_HUMAN",
  degradesProvider: false,
  summary: "Sınıflandırılamayan hata — insan incelemesi gerekir.",
};

export function classifyError(
  message: string | null | undefined,
): ErrorClassification {
  if (!message) return UNKNOWN;
  for (const rule of RULES) {
    if (rule.patterns.some((pattern) => pattern.test(message))) {
      return {
        category: rule.category,
        strategy: rule.strategy,
        degradesProvider: rule.degradesProvider,
        summary: rule.summary,
      };
    }
  }
  return UNKNOWN;
}

// Otomatik kurtarma yalnızca geçici hatalarda anlamlı: yapılandırma veya
// bakiye sorununu yeniden denemek yalnızca aynı hatayı üretir.
export function isAutoRecoverable(
  classification: ErrorClassification,
): boolean {
  return (
    classification.strategy === "RETRY" ||
    classification.strategy === "RETRY_AFTER_COOLDOWN"
  );
}
