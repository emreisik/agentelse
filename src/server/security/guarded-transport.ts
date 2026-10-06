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
  type HopResponse,
} from "./safe-fetch";

// Kendi kimliğiyle (User-Agent) tek adım GET yapan korumalı taşıyıcı
// (docs/google-search-console-plan.md SC-F3). safe-fetch.ts paylaşılan bir
// güvenlik dosyası olduğu için değiştirilmez; aynı SSRF korumasını onun
// dışa açtığı assertSafeUrl / assertPublicAddresses ile tekrar kurar:
//
//  - IP yazımlı adresler istekten önce, alan adları BAĞLANTI anında (soketin
//    kendi DNS çözümünde) denetlenir; DNS rebinding araya giremez.
//  - Yönlendirme İZLENMEZ: çağıran (site fetcher) her adımda kapsamı ve
//    robots.txt'i yeniden denetleyerek kendisi izler.
//  - Toplam (boşta değil) süre sınırı, açılmış boyut sınırı (zip bombası),
//    istenmeyen içerik türünde gövde hiç indirilmez.
//  - Her HTTP durumu çözülür; yalnız ağ, süre ve güvenlik hataları reddedilir.

export type GuardedRequest = {
  userAgent: string;
  accept: string;
  // Ek başlıklar (If-None-Match / If-Modified-Since); adlar küçük harfe iner.
  headers?: Readonly<Record<string, string>>;
  // Açılmış gövde sınırı; aşılınca kesilir (truncated = true).
  maxBytes: number;
  // Toplam süre sınırı (bağlantı + ilk bayt + gövde).
  timeoutMs: number;
  // Verilirse yalnız eşleşen Content-Type'ın gövdesi indirilir.
  bodyContentTypes?: RegExp;
};

export type GuardedResponse = HopResponse & {
  bodySkipped: boolean;
  elapsedMs: number;
  firstByteMs: number | null;
};

export type GuardedTransport = (
  url: URL,
  request: GuardedRequest,
) => Promise<GuardedResponse>;

// Süre sınırı aşıldı; fetcher bunu TIMEOUT olarak sınıflar.
export class GuardedTimeoutError extends Error {
  constructor(message = "The site took too long to respond") {
    super(message);
    this.name = "GuardedTimeoutError";
  }
}

export function buildRequestHeaders(
  request: GuardedRequest,
): Record<string, string> {
  const headers: Record<string, string> = {
    "user-agent": request.userAgent,
    accept: request.accept,
    "accept-encoding": "gzip, deflate, br",
  };
  for (const [name, value] of Object.entries(request.headers ?? {})) {
    headers[name.toLowerCase()] = value;
  }
  return headers;
}

// Kalıp yoksa her tür kabul; kalıp varken türü bilinmeyen gövde kabul
// edilmez ("bilinmiyor" hiçbir zaman "izinli" demek değildir).
export function isBodyAllowed(
  contentType: string | null,
  pattern: RegExp | undefined,
): boolean {
  if (!pattern) return true;
  if (!contentType) return false;
  // "g"/"y" bayraklı kalıp durum taşır; her denemede baştan başlasın.
  pattern.lastIndex = 0;
  return pattern.test(contentType.trim());
}

// http(s).request'e `lookup` olarak verilir: bağlantı anında çalışır, yani
// denetlenen adres bağlanılan adrestir. Bir tane bile kamuya açık olmayan
// kayıt bütün çözümü düşürür (safe-fetch ile aynı kural).
function guardedLookup(
  hostname: string,
  options: { all?: boolean; family?: number },
  callback: (
    error: Error | null,
    address?: string | LookupAddress[],
    family?: number,
  ) => void,
): void {
  dnsLookup(hostname, { all: true, verbatim: true }, (error, addresses) => {
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

function firstHeader(value: string | string[] | undefined): string | null {
  const first = Array.isArray(value) ? value[0] : value;
  return first ?? null;
}

export const guardedTransport: GuardedTransport = async (url, request) => {
  // IP yazımlı özel adresler bağlantı kurulmadan reddedilir.
  const target = assertSafeUrl(url);
  const startedAt = Date.now();

  return new Promise<GuardedResponse>((resolve, reject) => {
    let settled = false;
    let firstByteMs: number | null = null;
    const elapsed = () => Date.now() - startedAt;

    const hard = setTimeout(() => {
      fail(new GuardedTimeoutError());
      req.destroy();
    }, request.timeoutMs);

    function succeed(response: HopResponse, bodySkipped: boolean): void {
      if (settled) return;
      settled = true;
      clearTimeout(hard);
      resolve({ ...response, bodySkipped, elapsedMs: elapsed(), firstByteMs });
    }

    function fail(error: Error): void {
      if (settled) return;
      settled = true;
      clearTimeout(hard);
      reject(error);
    }

    const client = target.protocol === "https:" ? https : http;
    const req = client.request(
      target,
      {
        method: "GET",
        lookup: guardedLookup as never,
        headers: buildRequestHeaders(request),
        timeout: request.timeoutMs,
      },
      (response) => {
        firstByteMs = elapsed();
        const status = response.statusCode ?? 0;
        const headers = response.headers;
        // Bağlantı kapanınca gelen geç hatalar süreci düşürmesin.
        response.on("error", (error) => fail(error));

        // Yönlendirme ve 304'ün gövdesi önemsiz; indirilmez.
        if (status >= 300 && status < 400) {
          succeed(
            { status, headers, body: Buffer.alloc(0), truncated: false },
            false,
          );
          response.destroy();
          return;
        }

        const contentType = firstHeader(headers["content-type"]);
        if (!isBodyAllowed(contentType, request.bodyContentTypes)) {
          succeed(
            { status, headers, body: Buffer.alloc(0), truncated: false },
            true,
          );
          response.destroy();
          return;
        }

        const decoder = decoderFor(
          firstHeader(headers["content-encoding"]) ?? undefined,
        );
        const source: Readable = decoder
          ? (response.pipe(
              decoder as NodeJS.WritableStream,
            ) as unknown as Readable)
          : response;

        const chunks: Buffer[] = [];
        let total = 0;
        const finish = (truncated: boolean) => {
          succeed(
            { status, headers, body: Buffer.concat(chunks), truncated },
            false,
          );
          req.destroy();
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
    req.on("timeout", () => {
      req.destroy(new GuardedTimeoutError());
    });
    req.on("error", (error) => fail(error));
    req.end();
  });
};
