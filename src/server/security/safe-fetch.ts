import "server-only";

import { lookup as dnsLookup } from "node:dns";
import type { LookupAddress } from "node:dns";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import zlib from "node:zlib";
import type { Readable } from "node:stream";

// The app's ONLY way to fetch a URL a user typed (site scan). Everything that
// makes such a fetch dangerous is handled here rather than at call sites:
//
//  - SSRF: the request must never reach a private, loopback, link-local,
//    metadata (169.254.169.254), CGNAT or otherwise non-public address. The
//    check happens at CONNECTION time, inside the socket's own DNS lookup, so
//    a hostname that resolves to a public IP when validated and to 127.0.0.1
//    when connected (DNS rebinding) cannot slip through; IP-literal hosts are
//    checked up front.
//  - Redirects are followed manually and every hop is validated again.
//  - Bounded time and size (decompressed size too, against zip bombs).
//  - http/https only, default ports only, no embedded credentials.

export class UnsafeUrlError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UnsafeUrlError";
  }
}

// --- IP classification ------------------------------------------------------

function ipv4ToBytes(ip: string): number[] | null {
  const parts = ip.split(".");
  if (parts.length !== 4) return null;
  const bytes = parts.map((part) =>
    /^\d{1,3}$/.test(part) ? Number(part) : NaN,
  );
  return bytes.every((b) => b >= 0 && b <= 255) ? bytes : null;
}

function isBlockedIpv4(bytes: number[]): boolean {
  const [a, b, c] = bytes as [number, number, number, number];
  return (
    a === 0 || // "this" network
    a === 10 || // private
    (a === 100 && b >= 64 && b <= 127) || // CGNAT
    a === 127 || // loopback
    (a === 169 && b === 254) || // link-local incl. cloud metadata
    (a === 172 && b >= 16 && b <= 31) || // private
    (a === 192 && b === 0 && c === 0) || // IETF protocol assignments
    (a === 192 && b === 0 && c === 2) || // TEST-NET-1
    (a === 192 && b === 168) || // private
    (a === 198 && (b === 18 || b === 19)) || // benchmarking
    (a === 198 && b === 51 && c === 100) || // TEST-NET-2
    (a === 203 && b === 0 && c === 113) || // TEST-NET-3
    a >= 224 // multicast, reserved, broadcast
  );
}

// Expands any textual IPv6 (including "::" and an embedded dotted IPv4 tail)
// to its 16 bytes, or null when it isn't valid.
function ipv6ToBytes(input: string): number[] | null {
  let ip = input;
  const zone = ip.indexOf("%");
  if (zone !== -1) ip = ip.slice(0, zone);

  let tail: number[] = [];
  const lastColon = ip.lastIndexOf(":");
  if (ip.includes(".")) {
    const v4 = ipv4ToBytes(ip.slice(lastColon + 1));
    if (!v4) return null;
    tail = v4;
    ip = `${ip.slice(0, lastColon + 1)}0:0`;
  }

  const halves = ip.split("::");
  if (halves.length > 2) return null;
  const parse = (chunk: string): number[] | null => {
    if (chunk === "") return [];
    const groups = chunk.split(":");
    const out: number[] = [];
    for (const group of groups) {
      if (!/^[0-9a-fA-F]{1,4}$/.test(group)) return null;
      const value = parseInt(group, 16);
      out.push(value >> 8, value & 0xff);
    }
    return out;
  };
  const head = parse(halves[0]!);
  const rest = halves.length === 2 ? parse(halves[1]!) : [];
  if (!head || !rest) return null;

  let bytes: number[];
  if (halves.length === 2) {
    const missing = 16 - head.length - rest.length;
    if (missing < 0) return null;
    bytes = [...head, ...new Array<number>(missing).fill(0), ...rest];
  } else {
    bytes = head;
  }
  if (bytes.length !== 16) return null;
  if (tail.length) bytes.splice(12, 4, ...tail);
  return bytes;
}

function isBlockedIpv6(bytes: number[]): boolean {
  const allZeroUntil = (n: number) => bytes.slice(0, n).every((b) => b === 0);
  // :: (unspecified) and ::1 (loopback)
  if (allZeroUntil(15) && (bytes[15] === 0 || bytes[15] === 1)) return true;
  // IPv4-mapped ::ffff:a.b.c.d and IPv4-compatible ::a.b.c.d
  if (allZeroUntil(10) && bytes[10] === 0xff && bytes[11] === 0xff) {
    return isBlockedIpv4(bytes.slice(12));
  }
  if (allZeroUntil(12)) return isBlockedIpv4(bytes.slice(12));
  // NAT64 64:ff9b::/96 embeds an IPv4 address
  if (
    bytes[0] === 0x00 &&
    bytes[1] === 0x64 &&
    bytes[2] === 0xff &&
    bytes[3] === 0x9b &&
    bytes.slice(4, 12).every((b) => b === 0)
  ) {
    return isBlockedIpv4(bytes.slice(12));
  }
  const first = bytes[0]!;
  const second = bytes[1]!;
  if ((first & 0xfe) === 0xfc) return true; // fc00::/7 unique local
  if (first === 0xfe && (second & 0xc0) === 0x80) return true; // fe80::/10 link-local
  if (first === 0xfe && (second & 0xc0) === 0xc0) return true; // fec0::/10 site-local
  if (first === 0xff) return true; // multicast
  if (
    first === 0x20 &&
    second === 0x01 &&
    bytes[2] === 0x0d &&
    bytes[3] === 0xb8
  ) {
    return true; // 2001:db8::/32 documentation
  }
  return false;
}

// True for anything that is not a routable public address — and for input we
// cannot parse, because "unknown" must never mean "allowed".
export function isBlockedIp(ip: string): boolean {
  const family = net.isIP(ip);
  if (family === 4) {
    const bytes = ipv4ToBytes(ip);
    return bytes ? isBlockedIpv4(bytes) : true;
  }
  if (family === 6) {
    const bytes = ipv6ToBytes(ip);
    return bytes ? isBlockedIpv6(bytes) : true;
  }
  return true;
}

// --- URL validation ---------------------------------------------------------

export function assertSafeUrl(input: string | URL): URL {
  let url: URL;
  try {
    url = typeof input === "string" ? new URL(input) : input;
  } catch {
    throw new UnsafeUrlError("Invalid URL");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new UnsafeUrlError("Only http and https URLs can be scanned");
  }
  if (url.username || url.password) {
    throw new UnsafeUrlError("URLs with embedded credentials are not allowed");
  }
  if (url.port && url.port !== "80" && url.port !== "443") {
    throw new UnsafeUrlError("Only the default web ports are allowed");
  }
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (!host) throw new UnsafeUrlError("Missing host");
  if (net.isIP(host) && isBlockedIp(host)) {
    throw new UnsafeUrlError("That address is not publicly reachable");
  }
  return url;
}

// Validates every address a name resolved to: ONE non-public record fails the
// whole lookup (an attacker can publish a public and a private A record).
export function assertPublicAddresses(addresses: readonly string[]): void {
  if (addresses.length === 0) {
    throw new UnsafeUrlError("The host did not resolve to any address");
  }
  for (const address of addresses) {
    if (isBlockedIp(address)) {
      throw new UnsafeUrlError("That host resolves to a non-public address");
    }
  }
}

// Passed to http(s).request as `lookup`: runs at connection time, so the
// address validated is the address connected to.
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

// --- transport --------------------------------------------------------------

export type SafeFetchOptions = {
  // Hard cap on the (decompressed) body.
  maxBytes: number;
  // true: stop reading at maxBytes and return what we have (fine for HTML,
  // whose useful part is at the top). false: exceeding the cap is an error.
  truncate?: boolean;
  timeoutMs?: number;
  maxRedirects?: number;
  accept?: string;
  // Rejected unless the response Content-Type matches.
  allowedContentTypes?: RegExp;
};

export type SafeFetchResult = {
  // Final URL after redirects.
  url: string;
  status: number;
  contentType: string;
  body: Buffer;
  truncated: boolean;
};

export type HopResponse = {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: Buffer;
  truncated: boolean;
};

export type Transport = (
  url: URL,
  options: Required<
    Pick<SafeFetchOptions, "maxBytes" | "truncate" | "timeoutMs">
  > & {
    accept: string;
  },
) => Promise<HopResponse>;

const USER_AGENT = "AgentelseBrandScanner/1.0 (+brand identity import)";

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

const nodeTransport: Transport = (url, options) =>
  new Promise<HopResponse>((resolve, reject) => {
    const client = url.protocol === "https:" ? https : http;
    const request = client.request(
      url,
      {
        method: "GET",
        lookup: guardedLookup as never,
        headers: {
          "user-agent": USER_AGENT,
          accept: options.accept,
          "accept-encoding": "gzip, deflate, br",
        },
        timeout: options.timeoutMs,
      },
      (response) => {
        const status = response.statusCode ?? 0;
        const headers = response.headers;
        // A redirect's body is irrelevant; don't download it.
        if (status >= 300 && status < 400) {
          response.resume();
          resolve({ status, headers, body: Buffer.alloc(0), truncated: false });
          return;
        }

        const decoder = decoderFor(
          headers["content-encoding"] as string | undefined,
        );
        const source: Readable = decoder
          ? (response.pipe(
              decoder as NodeJS.WritableStream,
            ) as unknown as Readable)
          : response;

        const chunks: Buffer[] = [];
        let total = 0;
        let settled = false;
        const finish = (truncated: boolean) => {
          if (settled) return;
          settled = true;
          request.destroy();
          resolve({ status, headers, body: Buffer.concat(chunks), truncated });
        };

        source.on("data", (chunk: Buffer) => {
          total += chunk.length;
          if (total > options.maxBytes) {
            if (options.truncate) {
              chunks.push(
                chunk.subarray(0, chunk.length - (total - options.maxBytes)),
              );
              finish(true);
            } else if (!settled) {
              settled = true;
              request.destroy();
              reject(new UnsafeUrlError("The response is too large"));
            }
            return;
          }
          chunks.push(chunk);
        });
        source.on("end", () => finish(false));
        source.on("error", (error) => {
          if (!settled) {
            settled = true;
            reject(error);
          }
        });
      },
    );
    request.on("timeout", () => {
      request.destroy(new Error("The site took too long to respond"));
    });
    request.on("error", reject);
    request.end();
  });

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

export async function safeFetch(
  input: string,
  options: SafeFetchOptions,
  transport: Transport = nodeTransport,
): Promise<SafeFetchResult> {
  const maxRedirects = options.maxRedirects ?? 4;
  const timeoutMs = options.timeoutMs ?? 10_000;
  const deadline = Date.now() + timeoutMs;

  let url = assertSafeUrl(input);
  for (let hop = 0; hop <= maxRedirects; hop += 1) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new Error("The site took too long to respond");

    const response = await transport(url, {
      maxBytes: options.maxBytes,
      truncate: options.truncate ?? false,
      timeoutMs: remaining,
      accept: options.accept ?? "*/*",
    });

    if (REDIRECT_STATUSES.has(response.status)) {
      const location = response.headers.location;
      const target = Array.isArray(location) ? location[0] : location;
      if (!target) throw new Error("The site redirected without a destination");
      // Relative redirects resolve against the current URL; the result is
      // validated exactly like the first URL (protocol, port, IP literal),
      // and its host is checked again at connection time.
      url = assertSafeUrl(new URL(target, url));
      continue;
    }

    if (response.status < 200 || response.status >= 300) {
      throw new Error(`The site answered with HTTP ${response.status}`);
    }

    const rawType = response.headers["content-type"];
    const contentType = (Array.isArray(rawType) ? rawType[0] : rawType) ?? "";
    if (
      options.allowedContentTypes &&
      !options.allowedContentTypes.test(contentType)
    ) {
      throw new UnsafeUrlError(
        `Unexpected content type: ${contentType || "unknown"}`,
      );
    }

    return {
      url: url.toString(),
      status: response.status,
      contentType,
      body: response.body,
      truncated: response.truncated,
    };
  }
  throw new Error("The site redirected too many times");
}
