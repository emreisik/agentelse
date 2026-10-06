// Meta Graph / Marketing API hatası (docs/meta-ads-plan.md §3.1 Hata
// sınıflandırma). Karar mesaj metnine göre değil, kod, alt kod ve çağrı
// ailesine göre verilir (error-catalog.ts). Kullanıcıya Meta'nın kendi
// `error_user_msg`'i gösterilir; `blame_field_specs` hatalı alanın yoludur.

export type MetaErrorDetails = {
  type?: string;
  userTitle?: string;
  userMessage?: string;
  // ör. [["targeting", "age_min"]]
  blameFieldSpecs?: string[][];
  fbtraceId?: string;
  isTransient?: boolean;
  httpStatus?: number;
};

export class MetaApiError extends Error {
  readonly metaErrorCode?: number;
  readonly metaErrorSubcode?: number;
  readonly details: MetaErrorDetails;

  constructor(
    message: string,
    metaErrorCode?: number,
    metaErrorSubcode?: number,
    details: MetaErrorDetails = {},
  ) {
    super(message);
    this.name = "MetaApiError";
    this.metaErrorCode = metaErrorCode;
    this.metaErrorSubcode = metaErrorSubcode;
    this.details = details;
  }
}

type GraphErrorBody = {
  error?: {
    message?: string;
    type?: string;
    code?: number;
    error_subcode?: number;
    error_user_title?: string;
    error_user_msg?: string;
    fbtrace_id?: string;
    is_transient?: boolean;
    error_data?: unknown;
  };
  // Instagram Login token uç noktası daha düz bir biçimle yanıt verir.
  error_message?: string;
  code?: number;
} | null;

function blameFieldSpecsOf(errorData: unknown): string[][] | undefined {
  let data = errorData;
  if (typeof data === "string") {
    try {
      data = JSON.parse(data);
    } catch {
      return undefined;
    }
  }
  if (!data || typeof data !== "object") return undefined;
  const specs = (data as { blame_field_specs?: unknown }).blame_field_specs;
  if (!Array.isArray(specs)) return undefined;
  const paths = specs
    .map((spec) =>
      Array.isArray(spec)
        ? spec.filter((part): part is string => typeof part === "string")
        : typeof spec === "string"
          ? [spec]
          : [],
    )
    .filter((path) => path.length > 0);
  return paths.length > 0 ? paths : undefined;
}

// Bir Graph hata gövdesinden MetaApiError kurar.
export function metaErrorFromBody(
  body: unknown,
  httpStatus: number,
): MetaApiError {
  const errorBody = body as GraphErrorBody;
  const graphError = errorBody?.error;
  const message =
    graphError?.message ??
    errorBody?.error_message ??
    `Meta API error (HTTP ${httpStatus})`;
  return new MetaApiError(
    message,
    graphError?.code ?? errorBody?.code,
    graphError?.error_subcode,
    {
      type: graphError?.type,
      userTitle: graphError?.error_user_title,
      userMessage: graphError?.error_user_msg,
      blameFieldSpecs: blameFieldSpecsOf(graphError?.error_data),
      fbtraceId: graphError?.fbtrace_id,
      isTransient: graphError?.is_transient,
      httpStatus,
    },
  );
}
