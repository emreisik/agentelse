import { encodeForm, type FormValue } from "./form";

// Stripe REST istemcisi (resmî SDK yok: yeni bağımlılık eklenmedi). Tek iş: istek at,
// JSON'u döndür, hatayı StripeApiError yap. İstekler SABİT API sürümüyle gider; böylece
// nesne şekli hesabın varsayılan sürümü değişince değişmez (webhook uç noktasının
// sürümü ayrıdır: işleyiciler nesneyi bu istemciyle yeniden okur, olay gövdesine
// güvenmez).
//
// Yeniden deneme: ağ hatası, 409/429/5xx. POST yalnız Idempotency-Key varken denenir
// (Stripe aynı anahtara aynı yanıtı verir: çift tahsilat olmaz).

export const STRIPE_API_VERSION = "2024-06-20";
const DEFAULT_BASE_URL = "https://api.stripe.com";
const RETRYABLE_STATUS = new Set([409, 429, 500, 502, 503, 504]);

export class StripeApiError extends Error {
  readonly status: number;
  readonly code: string | null;
  readonly type: string | null;
  readonly param: string | null;
  readonly requestId: string | null;

  constructor(input: {
    status: number;
    code?: string | null;
    type?: string | null;
    param?: string | null;
    requestId?: string | null;
    message: string;
  }) {
    super(input.message);
    this.name = "StripeApiError";
    this.status = input.status;
    this.code = input.code ?? null;
    this.type = input.type ?? null;
    this.param = input.param ?? null;
    this.requestId = input.requestId ?? null;
  }

  get isNotFound(): boolean {
    return this.status === 404 || this.code === "resource_missing";
  }
}

// Ağ katmanı hatası (Stripe'a hiç ulaşılamadı ya da zaman aşımı).
export class StripeNetworkError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StripeNetworkError";
  }
}

export type StripeRequest = {
  method: "GET" | "POST" | "DELETE";
  // "/v1/subscriptions/sub_123"
  path: string;
  query?: Record<string, FormValue>;
  body?: Record<string, FormValue>;
  idempotencyKey?: string;
};

export type StripeHttp = (request: StripeRequest) => Promise<unknown>;

export type StripeHttpOptions = {
  secretKey: string;
  fetchImpl?: typeof fetch;
  baseUrl?: string;
  apiVersion?: string;
  timeoutMs?: number;
  maxRetries?: number;
  // Testlerde gerçek bekleme olmasın.
  sleep?: (ms: number) => Promise<void>;
};

function errorFrom(status: number, body: unknown, requestId: string | null) {
  const error =
    body && typeof body === "object" && "error" in body
      ? ((body as { error?: Record<string, unknown> }).error ?? {})
      : {};
  const text = (value: unknown) => (typeof value === "string" ? value : null);
  const code = text(error.code);
  const type = text(error.type);
  const message = text(error.message) ?? "request failed";
  return new StripeApiError({
    status,
    code,
    type,
    param: text(error.param),
    requestId,
    message: `Stripe ${status}${code ? ` ${code}` : type ? ` ${type}` : ""}: ${message}`,
  });
}

export function createStripeHttp(options: StripeHttpOptions): StripeHttp {
  const fetchImpl = options.fetchImpl ?? fetch;
  const baseUrl = options.baseUrl ?? DEFAULT_BASE_URL;
  const apiVersion = options.apiVersion ?? STRIPE_API_VERSION;
  const timeoutMs = options.timeoutMs ?? 20_000;
  const maxRetries = options.maxRetries ?? 2;
  const sleep =
    options.sleep ??
    ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));

  return async (request) => {
    const query = request.query ? encodeForm(request.query) : "";
    const url = `${baseUrl}${request.path}${query ? `?${query}` : ""}`;
    const headers: Record<string, string> = {
      Authorization: `Bearer ${options.secretKey}`,
      "Stripe-Version": apiVersion,
      "User-Agent": "agentelse-billing/1",
    };
    let body: string | undefined;
    if (request.method === "POST") {
      headers["Content-Type"] = "application/x-www-form-urlencoded";
      body = encodeForm(request.body ?? {});
      if (request.idempotencyKey) {
        headers["Idempotency-Key"] = request.idempotencyKey;
      }
    }
    const retryable =
      request.method !== "POST" || Boolean(request.idempotencyKey);

    let attempt = 0;
    for (;;) {
      let response: Response;
      try {
        response = await fetchImpl(url, {
          method: request.method,
          headers,
          body,
          signal: AbortSignal.timeout(timeoutMs),
        });
      } catch (cause) {
        if (retryable && attempt < maxRetries) {
          attempt += 1;
          await sleep(retryDelayMs(attempt));
          continue;
        }
        throw new StripeNetworkError(describeNetworkFailure(cause));
      }

      const requestId = response.headers.get("request-id");
      let parsed: unknown = null;
      try {
        parsed = await response.json();
      } catch {
        parsed = null;
      }
      if (response.ok) return parsed;

      const shouldRetryHeader = response.headers.get("stripe-should-retry");
      if (
        retryable &&
        attempt < maxRetries &&
        shouldRetryHeader !== "false" &&
        (RETRYABLE_STATUS.has(response.status) || shouldRetryHeader === "true")
      ) {
        attempt += 1;
        await sleep(retryDelayMs(attempt));
        continue;
      }
      throw errorFrom(response.status, parsed, requestId);
    }
  };
}

// Ağ hatasının nedeni (zaman aşımı, DNS, bağlantı reddi ...): teşhis için gerekli, sır
// içermez (istek adresi ve anahtar mesaja girmez).
function describeNetworkFailure(cause: unknown): string {
  if (!(cause instanceof Error)) return "network error";
  const code = (cause.cause as { code?: unknown } | undefined)?.code;
  return `${cause.name}: ${cause.message}${typeof code === "string" ? ` (${code})` : ""}`;
}

function retryDelayMs(attempt: number): number {
  return 400 * 2 ** (attempt - 1) + Math.floor(Math.random() * 150);
}
