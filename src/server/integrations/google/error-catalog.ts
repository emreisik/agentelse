import {
  GOOGLE_RESOURCE_NOUN,
  GOOGLE_SERVICE_LABEL,
  type GoogleService,
} from "./services";

// Google hatalarının tek karar kaynağı (docs/google-analytics-plan.md §3.1).
// Karar mesaj metniyle değil HTTP durumu, Google `status` alanı ve
// `ErrorInfo.reason` ile verilir; metin yalnız Google'ın kodla ayırmadığı
// birkaç durumda (izin kapsamı, kapalı API, günlük kota) yedektir. Saf modül.

export type GoogleErrorClass =
  | "TRANSIENT"
  | "SERVER_ERROR"
  | "RATE_LIMIT"
  | "QUOTA_DAILY"
  | "AUTH"
  | "SCOPE_MISSING"
  | "PERMISSION"
  | "NOT_FOUND"
  | "VALIDATION"
  | "API_DISABLED"
  | "UNKNOWN";

export type GoogleErrorSignal = {
  httpStatus?: number;
  // OAuth hata kodu (`invalid_grant`) ya da API durumu (`PERMISSION_DENIED`).
  code?: string;
  // `error.details[].reason` (ErrorInfo) ya da eski biçimde `errors[].reason`.
  reason?: string;
  message?: string;
  timedOut?: boolean;
  network?: boolean;
};

const RATE_REASONS = new Set([
  "rateLimitExceeded",
  "userRateLimitExceeded",
  "quotaExceeded",
  "RATE_LIMIT_EXCEEDED",
]);
const DAILY_REASONS = new Set(["dailyLimitExceeded"]);
const DISABLED_REASONS = new Set(["SERVICE_DISABLED", "accessNotConfigured"]);

export function classifyGoogleError(
  signal: GoogleErrorSignal,
): GoogleErrorClass {
  const { httpStatus, code, reason } = signal;
  const message = signal.message ?? "";

  if (signal.timedOut || signal.network) return "TRANSIENT";

  // OAuth uç noktası (token yenileme, kod değişimi).
  if (code === "invalid_grant") return "AUTH";
  if (code === "invalid_client" || code === "unauthorized_client") {
    return "API_DISABLED";
  }

  if (
    reason === "ACCESS_TOKEN_SCOPE_INSUFFICIENT" ||
    code === "insufficient_scope" ||
    /insufficient authentication scopes/i.test(message)
  ) {
    return "SCOPE_MISSING";
  }
  if (
    (reason && DISABLED_REASONS.has(reason)) ||
    /has not been used in project|is disabled/i.test(message)
  ) {
    return "API_DISABLED";
  }
  // Eski Google API'leri kota aşımını 403 ile de döndürür; bu yüzden kota
  // nedenleri genel 403 → PERMISSION eşlemesinden önce bakılır.
  if (reason && DAILY_REASONS.has(reason)) return "QUOTA_DAILY";
  if (
    httpStatus === 429 ||
    code === "RESOURCE_EXHAUSTED" ||
    (reason && RATE_REASONS.has(reason))
  ) {
    return /per day|daily/i.test(message) ? "QUOTA_DAILY" : "RATE_LIMIT";
  }

  if (httpStatus === 401 || code === "UNAUTHENTICATED") return "AUTH";
  if (httpStatus === 403 || code === "PERMISSION_DENIED") return "PERMISSION";
  if (httpStatus === 404 || code === "NOT_FOUND") return "NOT_FOUND";
  if (
    httpStatus === 400 ||
    code === "INVALID_ARGUMENT" ||
    code === "FAILED_PRECONDITION"
  ) {
    return "VALIDATION";
  }
  // 500 ve 503, GA4'te proje↔mülk başına saatlik sunucu hatası kotasından
  // düşer (saatte 10); bu yüzden TRANSIENT'tan ayrı tutulur.
  if (
    httpStatus === 500 ||
    httpStatus === 503 ||
    code === "INTERNAL" ||
    code === "UNAVAILABLE"
  ) {
    return "SERVER_ERROR";
  }
  if (
    httpStatus === 502 ||
    httpStatus === 504 ||
    code === "DEADLINE_EXCEEDED"
  ) {
    return "TRANSIENT";
  }
  return "UNKNOWN";
}

// Yalnız Google'ın kendisinden kaynaklanan sorunlar paylaşılan sağlayıcı
// sağlığını düşürür. Bir müşterinin süresi dolan bağlantısı, eksik izni ya
// da kaybolan mülkü yalnız o bağlantıda kalır; diğer müşterilerin işini
// durdurmaz.
export function googleClassDegradesProvider(
  errorClass: GoogleErrorClass,
): boolean {
  return (
    errorClass === "TRANSIENT" ||
    errorClass === "SERVER_ERROR" ||
    errorClass === "API_DISABLED"
  );
}

// Kaç kez tekrar denenebileceği: TRANSIENT iki kez, SERVER_ERROR bir kez
// (sunucu hatası kotası), diğerleri hiç (kör tekrar istemci hatası kotasını
// tüketir ve aynı hatayı yeniden alır).
export function googleRetryBudget(errorClass: GoogleErrorClass): number {
  if (errorClass === "TRANSIENT") return 2;
  if (errorClass === "SERVER_ERROR") return 1;
  return 0;
}

// Sağlık hesabına giden yapılandırılmış kod: `GOOGLE:<SINIF>`.
export const GOOGLE_ERROR_CODE_PREFIX = "GOOGLE:";

export function googleErrorCode(errorClass: GoogleErrorClass): string {
  return `${GOOGLE_ERROR_CODE_PREFIX}${errorClass}`;
}

export function parseGoogleErrorCode(
  errorCode: string | null | undefined,
): GoogleErrorClass | null {
  if (!errorCode?.startsWith(GOOGLE_ERROR_CODE_PREFIX)) return null;
  const errorClass = errorCode.slice(GOOGLE_ERROR_CODE_PREFIX.length);
  return GOOGLE_ERROR_CLASSES.has(errorClass as GoogleErrorClass)
    ? (errorClass as GoogleErrorClass)
    : null;
}

const GOOGLE_ERROR_CLASSES = new Set<GoogleErrorClass>([
  "TRANSIENT",
  "SERVER_ERROR",
  "RATE_LIMIT",
  "QUOTA_DAILY",
  "AUTH",
  "SCOPE_MISSING",
  "PERMISSION",
  "NOT_FOUND",
  "VALIDATION",
  "API_DISABLED",
  "UNKNOWN",
]);

// Arayüz metni (İngilizce). UNKNOWN için null: çağıran Google'ın kendi
// mesajını gösterir.
export function googleErrorUserMessage(
  errorClass: GoogleErrorClass,
  service: GoogleService,
): string | null {
  const label = GOOGLE_SERVICE_LABEL[service];
  const noun = GOOGLE_RESOURCE_NOUN[service];
  switch (errorClass) {
    case "TRANSIENT":
    case "SERVER_ERROR":
      return `${label} is having a temporary problem. We'll try again shortly.`;
    case "RATE_LIMIT":
      return "Google asked us to slow down. Updates resume shortly.";
    case "QUOTA_DAILY":
      return `Daily ${label} limit reached. Data refreshes tomorrow.`;
    case "AUTH":
      return `Reconnect ${label}: access expired or was removed.`;
    case "SCOPE_MISSING":
      return `Agentelse needs permission to read ${label}. Reconnect and tick the box.`;
    case "PERMISSION":
      return `Your Google account no longer has access to this ${label} ${noun}.`;
    case "NOT_FOUND":
      return `This ${label} ${noun} no longer exists.`;
    case "API_DISABLED":
      return `${label} is temporarily unavailable in Agentelse.`;
    case "VALIDATION":
    case "UNKNOWN":
      return null;
  }
}
