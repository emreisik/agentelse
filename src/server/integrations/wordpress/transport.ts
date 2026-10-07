import "server-only";

import { lookup as dnsLookup } from "node:dns";
import type { LookupAddress } from "node:dns";
import http from "node:http";
import https from "node:https";
import type { Readable } from "node:stream";
import zlib from "node:zlib";

import {
  assertPublicAddresses,
  assertSafeUrl,
  UnsafeUrlError,
} from "@/server/security/safe-fetch";

import { createMockWpTransport } from "./mock-site";

// WordPress REST için korumalı taşıyıcı (docs/wordpress-plan.md). guarded-
// transport.ts yalnız GET yapar ve paylaşılan bir güvenlik dosyasıdır; o
// değiştirilmez. Burada aynı SSRF korumasını (assertSafeUrl, bağlantı
// anında assertPublicAddresses, yalnız 80/443) GET/POST/DELETE, gövde ve
// özel başlıklarla yeniden kurar:
//
//  - Yönlendirme İZLENMEZ; çağıran (istemci) gerekirse kendi izler.
//  - Kimlik doğrulamalı (Authorization başlıklı) istek yalnız https'e gider:
//    şifre asla düz metin gitmez.
//  - Sabit, tanınabilir User-Agent: güvenlik duvarı bu kimliği izin
//    listesine alabilir.
//  - Toplam süre sınırı ve açılmış boyut sınırı (zip bombası).

export const WORDPRESS_USER_AGENT = "AgentelseSEO/1.0 (+https://agentelse.com)";

export type WpRequest = {
  method: "GET" | "POST" | "DELETE";
  url: URL;
  headers: Record<string, string>;
  body?: string;
  timeoutMs: number;
  maxBytes: number;
};

export type WpResponse = {
  status: number;
  // Adlar küçük harfli; çok değerli başlıklar ", " ile birleşir.
  headers: Record<string, string>;
  body: string;
  truncated: boolean;
};

export type WpTransport = (request: WpRequest) => Promise<WpResponse>;

// Süre sınırı aşıldı; istemci bunu TRANSIENT olarak sınıflar.
export class WpTimeoutError extends Error {
  constructor() {
    super("The WordPress site took too long to respond");
    this.name = "WpTimeoutError";
  }
}

// http(s).request'e `lookup` olarak verilir: bağlantı anında çalışır, yani
// denetlenen adres bağlanılan adrestir (DNS rebinding araya giremez).
export function guardedLookup(
  hostname: string,
  options: { all?: boolean; family?: number },
  callback: (
    error: Error | null,
    address?: string | LookupAddress[],
    family?: number,
  ) => void,
  resolve: typeof dnsLookup = dnsLookup,
): void {
  resolve(hostname, { all: true, verbatim: true }, (error, addresses) => {
    if (error) return callback(error);
    try {
      assertPublicAddresses(addresses.map((a) => a.address));
    } catch (unsafe) {
      return callback(unsafe as Error);
    }
    if (options.all) return callback(null, addresses);
    const first = addresses[0]!;
    return callback(null, first.address, first.family);
  });
}

function decoderFor(
  encoding: string | undefined,
): NodeJS.ReadWriteStream | null {
  switch ((encoding ?? "").toLowerCase()) {
    case "gzip":
    case "x-gzip":
      return zlib.createGunzip();
    case "deflate":
      return zlib.createInflate();
    case "br":
      return zlib.createBrotliDecompress();
    default:
      return null;
  }
}

function flattenHeaders(
  headers: Record<string, string | string[] | undefined>,
): Record<string, string> {
  const flat: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    if (value === undefined) continue;
    flat[name.toLowerCase()] = Array.isArray(value) ? value.join(", ") : value;
  }
  return flat;
}

// İstek başlıklarını kurar: çağıranın başlıkları küçük harfe iner, kimlik
// (User-Agent) HER ZAMAN sabit değerdir ve https dışında Authorization yasaktır.
export function buildWpHeaders(request: WpRequest): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const [name, value] of Object.entries(request.headers)) {
    headers[name.toLowerCase()] = value;
  }
  if (headers.authorization !== undefined && request.url.protocol !== "https:") {
    throw new UnsafeUrlError("Authenticated requests need https");
  }
  headers["user-agent"] = WORDPRESS_USER_AGENT;
  headers.accept ??= "application/json";
  headers["accept-encoding"] = "gzip, deflate, br";
  if (request.body !== undefined) {
    headers["content-type"] ??= "application/json";
    headers["content-length"] = String(Buffer.byteLength(request.body));
  }
  return headers;
}

// Test için dışarıdan takılabilen ağ katmanı (sahte soket).
export type WpNetDeps = {
  http: Pick<typeof http, "request">;
  https: Pick<typeof https, "request">;
};

export function createGuardedWpTransport(
  deps: WpNetDeps = { http, https },
): WpTransport {
  return async (request) => {
    // IP yazımlı özel adresler ve kural dışı portlar bağlantı kurulmadan reddedilir.
    const target = assertSafeUrl(request.url);
    const headers = buildWpHeaders({ ...request, url: target });

    return new Promise<WpResponse>((resolve, reject) => {
      let settled = false;

      // req ve zamanlayıcı önceden bildirilir: client.request eşzamanlı fırlatırsa
      // zamanlayıcı geçici ölü bölgedeki req'e dokunup süreci düşürmesin.
      let req: ReturnType<typeof https.request> | undefined;
      const timer: { hard?: ReturnType<typeof setTimeout> } = {};

      function succeed(response: WpResponse): void {
        if (settled) return;
        settled = true;
        if (timer.hard) clearTimeout(timer.hard);
        resolve(response);
      }

      function fail(error: Error): void {
        if (settled) return;
        settled = true;
        if (timer.hard) clearTimeout(timer.hard);
        reject(error);
      }

      const client = target.protocol === "https:" ? deps.https : deps.http;
      try {
        req = client.request(
          target,
          {
            method: request.method,
            lookup: guardedLookup as never,
            headers,
            timeout: request.timeoutMs,
          },
          (response) => {
            const status = response.statusCode ?? 0;
            const responseHeaders = flattenHeaders(response.headers);
            // Bağlantı kapanınca gelen geç hatalar süreci düşürmesin.
            response.on("error", (error) => fail(error));

            // Yönlendirmenin gövdesi önemsiz; indirilmez ve izlenmez.
            if (status >= 300 && status < 400) {
              succeed({ status, headers: responseHeaders, body: "", truncated: false });
              response.destroy();
              return;
            }

            const decoder = decoderFor(responseHeaders["content-encoding"]);
            const source: Readable = decoder
              ? (response.pipe(
                  decoder as NodeJS.WritableStream,
                ) as unknown as Readable)
              : response;

            const chunks: Buffer[] = [];
            let total = 0;
            const finish = (truncated: boolean) => {
              succeed({
                status,
                headers: responseHeaders,
                body: Buffer.concat(chunks).toString("utf8"),
                truncated,
              });
              req?.destroy();
            };

            source.on("data", (chunk: Buffer) => {
              if (settled) return;
              total += chunk.length;
              // Sınır açılmış boyuta uygulanır; aşan kısım kesilir.
              if (total > request.maxBytes) {
                chunks.push(
                  chunk.subarray(0, chunk.length - (total - request.maxBytes)),
                );
                finish(true);
                return;
              }
              chunks.push(chunk);
            });
            source.on("end", () => finish(false));
            source.on("error", (error: Error) => fail(error));
          },
        );
      } catch (error) {
        fail(error instanceof Error ? error : new Error("request failed"));
        return;
      }
      const started = req;
      timer.hard = setTimeout(() => {
        fail(new WpTimeoutError());
        started.destroy();
      }, request.timeoutMs);
      started.on("timeout", () => {
        started.destroy(new WpTimeoutError());
      });
      started.on("error", (error) => fail(error));
      started.end(request.body);
    });
  };
}

export const guardedWpTransport: WpTransport = createGuardedWpTransport();

// Mock kipinde hiçbir istek süreçten çıkmaz (bellek içi WordPress).
export function wpTransportFor(mock: boolean): WpTransport {
  return mock ? createMockWpTransport() : guardedWpTransport;
}
