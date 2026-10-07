import { GoogleApiError } from "../errors";

// BigQuery hatalarının tek kapısı. Google'ın ham mesajı ASLA saklanmaz
// (içinde proje/veri kümesi adı ya da sorgu parçası olabilir); kullanıcıya
// yalnız sabit İngilizce metin gider.

export type BqErrorCode =
  | "NOT_CONFIGURED"
  | "SA_AUTH"
  | "NO_ACCESS"
  | "NOT_FOUND"
  | "BILLING_DISABLED"
  | "COST_CAP"
  | "RATE_LIMIT"
  | "INVALID_REQUEST"
  | "INVALID_QUERY"
  | "TIMEOUT"
  | "UNAVAILABLE"
  | "UNKNOWN";

export const BQ_ERROR_TEXT: Readonly<Record<BqErrorCode, string>> = {
  NOT_CONFIGURED: "BigQuery export isn't available on this server yet.",
  SA_AUTH: "Agentelse couldn't sign in to Google BigQuery. Try again later.",
  NO_ACCESS:
    "Agentelse's service account can't read this dataset. Grant it BigQuery Data Viewer on the dataset and BigQuery Job User on the project.",
  NOT_FOUND: "The project, dataset or table wasn't found.",
  BILLING_DISABLED: "Billing isn't enabled on this Google Cloud project.",
  COST_CAP: "This query would read more data than your cost cap allows.",
  RATE_LIMIT: "BigQuery is rate limiting requests. Try again in a few minutes.",
  INVALID_REQUEST: "The BigQuery request isn't valid.",
  INVALID_QUERY: "BigQuery rejected the query.",
  TIMEOUT: "BigQuery took too long to answer. Try again later.",
  UNAVAILABLE: "BigQuery is temporarily unavailable. Try again later.",
  UNKNOWN: "BigQuery returned an unexpected error.",
};

export class BigQueryError extends Error {
  readonly code: BqErrorCode;
  readonly httpStatus?: number;

  constructor(code: BqErrorCode, httpStatus?: number) {
    super(BQ_ERROR_TEXT[code]);
    this.name = "BigQueryError";
    this.code = code;
    this.httpStatus = httpStatus;
  }
}

const RATE_REASONS = new Set([
  "rateLimitExceeded",
  "quotaExceeded",
  "jobRateLimitExceeded",
  "userRateLimitExceeded",
]);

// Karar HTTP durumu ve Google `reason` ile verilir; metin yalnız Google'ın
// kodla ayırmadığı birkaç durumda (faturalama, izin) yedektir. Faturalama
// yedeği yalnız Google'ın kesin cümlelerini arar; "billing" geçen bir veri
// kümesi adı erişim hatasını faturalama sanmasın.
export function classifyBigQueryError(error: unknown): BigQueryError {
  if (error instanceof BigQueryError) return error;
  if (!(error instanceof GoogleApiError)) return new BigQueryError("UNKNOWN");

  const status = error.httpStatus;
  const reason = error.reason ?? "";
  const message = error.message;
  const make = (code: BqErrorCode) => new BigQueryError(code, status);

  if (status === 401) return make("SA_AUTH");
  if (status === 403 || status === 429) {
    if (reason === "billingNotEnabled" ||
      /billing (has not been|is not) enabled|billingNotEnabled/i.test(message)) {
      return make("BILLING_DISABLED");
    }
    if (RATE_REASONS.has(reason)) return make("RATE_LIMIT");
    if (status === 429) return make("RATE_LIMIT");
    return make("NO_ACCESS");
  }
  if (status === 404) return make("NOT_FOUND");
  if (status === 400) {
    if (reason === "bytesBilledLimitExceeded" || /bytes billed/i.test(message)) {
      return make("COST_CAP");
    }
    return make("INVALID_QUERY");
  }
  // Zaman aşımı ve ağ hataları da TRANSIENT sınıfındadır.
  if (error.errorClass === "TRANSIENT") return make("TIMEOUT");
  if (status !== undefined && status >= 500) return make("UNAVAILABLE");
  if (error.errorClass === "RATE_LIMIT") return make("RATE_LIMIT");
  return make("UNKNOWN");
}
