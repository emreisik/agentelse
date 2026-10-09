export const ERROR_CODES = [
  "LOGIN_REQUIRED",
  "MFA_REQUIRED",
  "OTP_REQUIRED",
  "CAPTCHA_REQUIRED",
  "SESSION_EXPIRED",
  "ELEMENT_NOT_FOUND",
  "UI_CHANGED",
  "PERMISSION_DENIED",
  "PROJECT_MISMATCH",
  "BROWSER_PROFILE_MISMATCH",
  "PROVIDER_UNAVAILABLE",
  "PROVIDER_RATE_LIMITED",
  "INVALID_PROVIDER_RESULT",
  "APPROVAL_REQUIRED",
  "HUMAN_ACTION_REQUIRED",
  "TIMEOUT",
  "CANCELLED",
  "NOT_FOUND",
  "INVALID_STATE_TRANSITION",
  "BUDGET_EXCEEDED",
  // Plan hakkı (görsel adedi ya da AI bütçesi) bu dönem için bitti / çalışma
  // alanının geçerli planı yok (src/server/billing/operation.ts, Faz 3). Hata
  // DEĞİL, bekleme: worker bunları yeniden denemez ya da dead-letter yapmaz, işi
  // WAITING_BUDGET'e park eder. BUDGET_EXCEEDED'dan ayrı tutulur: o, günlük proje
  // sayaçlarıdır ve 15'ten fazla tüketicisi günlük sıfırlanma varsayar.
  "QUOTA_EXCEEDED",
  "NO_PLAN",
  // Hak defteri okunamadı (enforce'ta fail-closed): geçici, yeniden denenir.
  "BILLING_UNAVAILABLE",
  "DUPLICATE",
  // The request cannot run as stated: a required input is missing or not
  // supported (see execution/capability-input.ts). Not retryable.
  "INVALID_INPUT",
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

export class AgentelseError extends Error {
  readonly code: ErrorCode;
  readonly retryable: boolean;
  // Structured detail for surfaces that render the error (e.g. the chat's
  // limit-notice card): which cap was hit, its value, today's usage. The
  // message string stays the log-facing source of truth; meta is for UIs.
  readonly meta?: Record<string, unknown>;

  constructor(
    code: ErrorCode,
    message: string,
    options?: { retryable?: boolean; meta?: Record<string, unknown> },
  ) {
    super(message);
    this.name = "AgentelseError";
    this.code = code;
    this.retryable = options?.retryable ?? false;
    this.meta = options?.meta;
  }
}

export function isAgentelseError(error: unknown): error is AgentelseError {
  return error instanceof AgentelseError;
}
