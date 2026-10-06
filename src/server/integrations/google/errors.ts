import {
  classifyGoogleError,
  type GoogleErrorClass,
  type GoogleErrorSignal,
} from "./error-catalog";

type GoogleErrorDetails = Omit<GoogleErrorSignal, "code" | "message"> & {
  errorClass?: GoogleErrorClass;
  // Yanıttaki `Retry-After` başlığı (ms); yalnız tekrar kararında kullanılır.
  retryAfterMs?: number;
};

// Google'dan gelen her hata bu sınıfla taşınır. `googleErrorCode` geriye
// uyum için korunur: OAuth hatalarında `invalid_grant` gibi kod, API
// hatalarında `PERMISSION_DENIED` gibi durum taşır (google-actions.ts ve
// modules/analytics/google.ts bunu okur). Sınıf kurulurken bir kez belirlenir.
export class GoogleApiError extends Error {
  readonly googleErrorCode?: string;
  readonly httpStatus?: number;
  readonly reason?: string;
  readonly retryAfterMs?: number;
  readonly errorClass: GoogleErrorClass;

  constructor(
    message: string,
    googleErrorCode?: string,
    details: GoogleErrorDetails = {},
  ) {
    super(message);
    this.name = "GoogleApiError";
    this.googleErrorCode = googleErrorCode;
    this.httpStatus = details.httpStatus;
    this.reason = details.reason;
    this.retryAfterMs = details.retryAfterMs;
    this.errorClass =
      details.errorClass ??
      classifyGoogleError({ ...details, code: googleErrorCode, message });
  }
}

type GoogleErrorBody = {
  // OAuth biçimi: { error: "invalid_grant", error_description, error_subtype }
  // API biçimi:   { error: { code, message, status, details[], errors[] } }
  error?:
    | string
    | {
        code?: number;
        message?: string;
        status?: string;
        details?: Array<{ "@type"?: string; reason?: string }>;
        errors?: Array<{ reason?: string; message?: string }>;
      };
  error_description?: string;
  error_subtype?: string;
};

// Başarısız bir yanıtı GoogleApiError'a çevirir. Gövde boş ya da JSON değilse
// yalnız HTTP durumu kullanılır.
export function googleErrorFromResponse(
  httpStatus: number,
  body: unknown,
  retryAfterMs?: number,
): GoogleApiError {
  const parsed = (body ?? null) as GoogleErrorBody | null;
  const error = parsed?.error;

  if (typeof error === "string") {
    return new GoogleApiError(parsed?.error_description ?? error, error, {
      httpStatus,
      retryAfterMs,
    });
  }

  const reason =
    error?.details?.find((detail) => typeof detail.reason === "string")
      ?.reason ?? error?.errors?.find((item) => item.reason)?.reason;
  return new GoogleApiError(
    error?.message ?? `Google API error (HTTP ${httpStatus})`,
    error?.status,
    { httpStatus, reason, retryAfterMs },
  );
}
