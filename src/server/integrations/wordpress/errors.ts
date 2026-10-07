import type { SeoChangeErrorCode } from "@/lib/seo/apply/types";

// WordPress REST hatalarının sınıfı (docs/wordpress-plan.md). WordPress'in
// yanıt gövdesi hiçbir zaman mesaja, loga ya da veritabanına girmez: bu
// dosyadaki sabit İngilizce metinler ve kod (wpCode, yalnız küçük harf/rakam/_)
// yeter. Saf modül; ağ yok.

export type WpErrorClass =
  | "AUTH"
  | "APP_PASSWORDS_DISABLED"
  | "FORBIDDEN"
  | "NOT_FOUND"
  | "REST_DISABLED"
  | "NOT_WORDPRESS"
  | "VALIDATION"
  | "RATE_LIMIT"
  | "SERVER"
  | "TRANSIENT"
  | "UNSAFE"
  | "REDIRECT";

const CLASS_MESSAGES: Record<WpErrorClass, string> = {
  AUTH: "WordPress did not accept the username and Application Password.",
  APP_PASSWORDS_DISABLED:
    "Application Passwords are switched off on this WordPress site.",
  FORBIDDEN: "The WordPress user is not allowed to do this.",
  NOT_FOUND: "WordPress could not find that item.",
  REST_DISABLED: "The site blocked the WordPress REST API.",
  NOT_WORDPRESS: "The address did not answer like a WordPress site.",
  VALIDATION: "WordPress rejected the request.",
  RATE_LIMIT: "The site asked Agentelse to slow down.",
  SERVER: "The WordPress site reported an error.",
  TRANSIENT: "The WordPress site did not answer in time.",
  UNSAFE: "That address cannot be used.",
  REDIRECT: "The site redirected the request somewhere it cannot follow.",
};

const RETRYABLE: ReadonlySet<WpErrorClass> = new Set([
  "RATE_LIMIT",
  "SERVER",
  "TRANSIENT",
]);

export class WordPressApiError extends Error {
  readonly errorClass: WpErrorClass;
  readonly httpStatus: number | null;
  readonly wpCode: string | null;
  readonly retryable: boolean;

  constructor(
    errorClass: WpErrorClass,
    options: { httpStatus?: number | null; wpCode?: string | null; retryable?: boolean } = {},
  ) {
    super(CLASS_MESSAGES[errorClass]);
    this.name = "WordPressApiError";
    this.errorClass = errorClass;
    this.httpStatus = options.httpStatus ?? null;
    // Kod yalnız güvenli karakterlerle saklanır (gövdeden gelen serbest metin değil).
    this.wpCode = safeCode(options.wpCode ?? null);
    this.retryable = options.retryable ?? RETRYABLE.has(errorClass);
  }
}

function safeCode(code: string | null): string | null {
  if (!code) return null;
  return /^[a-z0-9_-]{1,64}$/i.test(code) ? code.toLowerCase() : null;
}

function wpCodeOf(body: unknown): string | null {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return null;
  }
  const code = (body as Record<string, unknown>).code;
  return typeof code === "string" ? safeCode(code) : null;
}

// REST'i kapatan eklentilerin ve "giriş zorunlu" siteleri kodları.
const REST_DISABLED_CODES: ReadonlySet<string> = new Set([
  "rest_disabled",
  "rest_api_disabled",
  "disabled_rest_api",
  "rest_login_required",
]);

// Çöp kutusu kapalıysa WordPress silmez, 501 döner: yazma reddedilmiş sayılır.
const REJECTED_CODES: ReadonlySet<string> = new Set([
  "rest_trash_not_supported",
]);

// Yanıt durumunu ve (varsa ayrıştırılmış) gövdeyi sınıflar; null = başarı.
// body: JSON ise ayrıştırılmış nesne, değilse ham metin (HTML, WAF sayfası).
export function classifyWpResponse(
  status: number,
  body: unknown,
): WpErrorClass | null {
  if (status >= 200 && status < 300) return null;
  if (status >= 300 && status < 400) return "REDIRECT";
  const code = wpCodeOf(body);
  const isJson = code !== null || (typeof body === "object" && body !== null);

  if (code === "application_passwords_disabled") return "APP_PASSWORDS_DISABLED";
  if (code && REST_DISABLED_CODES.has(code)) return "REST_DISABLED";
  if (code && REJECTED_CODES.has(code)) return "VALIDATION";

  if (status === 401) return "AUTH";
  if (status === 403) {
    // JSON olmayan 403 çoğunlukla bir güvenlik duvarının (WAF) sayfasıdır.
    return isJson ? "FORBIDDEN" : "REST_DISABLED";
  }
  if (status === 404) {
    // JSON olmayan 404: REST adresi hiç yok (WordPress değil ya da güzel
    // bağlantılar kapalı).
    return isJson ? "NOT_FOUND" : "NOT_WORDPRESS";
  }
  if (status === 408) return "TRANSIENT";
  if (status === 429) return "RATE_LIMIT";
  if (status === 502 || status === 503 || status === 504) return "TRANSIENT";
  if (status >= 500) return "SERVER";
  if (status >= 400) return "VALIDATION";
  return "SERVER";
}

// Motor için: hata sınıfını sabit hata koduna ve yeniden deneme sınıfına çevirir.
export function wpErrorToChangeCode(error: unknown): {
  code: SeoChangeErrorCode;
  retryable: boolean;
  errorClass: "RATE_LIMIT" | "TRANSIENT" | "SERVER" | "OTHER";
} {
  if (!(error instanceof WordPressApiError)) {
    return { code: "unknown", retryable: false, errorClass: "OTHER" };
  }
  switch (error.errorClass) {
    case "AUTH":
    case "APP_PASSWORDS_DISABLED":
      return { code: "reconnect", retryable: false, errorClass: "OTHER" };
    case "FORBIDDEN":
      return { code: "no_permission", retryable: false, errorClass: "OTHER" };
    case "NOT_FOUND":
      return { code: "page_not_found", retryable: false, errorClass: "OTHER" };
    case "REST_DISABLED":
    case "NOT_WORDPRESS":
    case "REDIRECT":
    case "UNSAFE":
      return { code: "site_unhealthy", retryable: false, errorClass: "OTHER" };
    case "VALIDATION":
      return { code: "rejected_by_site", retryable: false, errorClass: "OTHER" };
    case "RATE_LIMIT":
      return { code: "rate_limited", retryable: true, errorClass: "RATE_LIMIT" };
    case "SERVER":
      return {
        code: "site_unavailable",
        retryable: error.retryable,
        errorClass: "SERVER",
      };
    case "TRANSIENT":
      return {
        code: "site_unavailable",
        retryable: error.retryable,
        errorClass: "TRANSIENT",
      };
  }
}
