import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { gzipSync } from "node:zlib";
import { describe, expect, it, vi } from "vitest";

import { UnsafeUrlError } from "@/server/security/safe-fetch";

import {
  buildWpHeaders,
  createGuardedWpTransport,
  guardedLookup,
  WORDPRESS_USER_AGENT,
  WpTimeoutError,
  wpTransportFor,
  type WpNetDeps,
  type WpRequest,
} from "./transport";

type FakeResponse = {
  status: number;
  headers?: Record<string, string>;
  chunks?: Buffer[];
};

type Captured = {
  url: URL;
  options: { method?: string; headers?: Record<string, string> };
  body: string | undefined;
};

// Sahte soket katmanı: gerçek ağa çıkmaz; isteği yakalar, yanıtı kendisi verir.
function fakeNet(respond: FakeResponse | null) {
  const captured: Captured[] = [];
  const request = vi.fn(
    (
      url: URL,
      options: Captured["options"],
      callback: (response: PassThrough & { statusCode?: number; headers?: Record<string, string> }) => void,
    ) => {
      const req = new EventEmitter() as EventEmitter & {
        end: (body?: string) => void;
        destroy: (error?: Error) => void;
      };
      req.destroy = (error?: Error) => {
        if (error) req.emit("error", error);
      };
      req.end = (body?: string) => {
        captured.push({ url, options, body });
        if (!respond) return;
        const response = new PassThrough() as PassThrough & {
          statusCode?: number;
          headers?: Record<string, string>;
        };
        response.statusCode = respond.status;
        response.headers = respond.headers ?? {};
        callback(response);
        for (const chunk of respond.chunks ?? []) response.write(chunk);
        response.end();
      };
      return req;
    },
  );
  const deps = { http: { request }, https: { request } } as unknown as WpNetDeps;
  return { deps, captured, request };
}

function request(overrides: Partial<WpRequest> = {}): WpRequest {
  return {
    method: "GET",
    url: new URL("https://example.com/wp-json/"),
    headers: {},
    timeoutMs: 1_000,
    maxBytes: 1_000,
    ...overrides,
  };
}

describe("buildWpHeaders", () => {
  it("User-Agent her zaman sabittir ve çağıranın değeri ezilir", () => {
    const headers = buildWpHeaders(
      request({ headers: { "User-Agent": "evil", Accept: "text/plain" } }),
    );
    expect(headers["user-agent"]).toBe(WORDPRESS_USER_AGENT);
    expect(headers.accept).toBe("text/plain");
    expect(WORDPRESS_USER_AGENT).toBe("AgentelseSEO/1.0 (+https://agentelse.com)");
  });

  it("gövde varsa content-length ve content-type eklenir", () => {
    const headers = buildWpHeaders(request({ method: "POST", body: '{"a":"é"}' }));
    expect(headers["content-type"]).toBe("application/json");
    expect(headers["content-length"]).toBe(String(Buffer.byteLength('{"a":"é"}')));
  });

  it("kimlik başlığı https dışında reddedilir", () => {
    expect(() =>
      buildWpHeaders(
        request({
          url: new URL("http://example.com/wp-json/"),
          headers: { Authorization: "Basic abc" },
        }),
      ),
    ).toThrow(UnsafeUrlError);
  });
});

describe("guardedWpTransport", () => {
  it("kimlik doğrulamalı istek http'ye gitmez ve ağa hiç çıkılmaz", async () => {
    const { deps, request: fn } = fakeNet({ status: 200 });
    const transport = createGuardedWpTransport(deps);
    await expect(
      transport(
        request({
          url: new URL("http://example.com/wp-json/"),
          headers: { authorization: "Basic abc" },
        }),
      ),
    ).rejects.toBeInstanceOf(UnsafeUrlError);
    expect(fn).not.toHaveBeenCalled();
  });

  it("özel IP adresi ve kural dışı port reddedilir", async () => {
    const { deps, request: fn } = fakeNet({ status: 200 });
    const transport = createGuardedWpTransport(deps);
    for (const target of [
      "https://127.0.0.1/wp-json/",
      "https://10.0.0.5/wp-json/",
      "https://169.254.169.254/latest/",
      "https://[::1]/wp-json/",
      "https://example.com:8443/wp-json/",
      "https://user:pass@example.com/wp-json/",
      "ftp://example.com/",
    ]) {
      await expect(
        transport(request({ url: new URL(target) })),
      ).rejects.toBeInstanceOf(UnsafeUrlError);
    }
    expect(fn).not.toHaveBeenCalled();
  });

  it("alan adı bağlantı anında özel adrese çözülürse düşer", () => {
    const callback = vi.fn();
    const resolve = ((_host: string, _options: unknown, done: (e: Error | null, a: { address: string; family: number }[]) => void) => {
      done(null, [
        { address: "93.184.216.34", family: 4 },
        { address: "10.0.0.1", family: 4 },
      ]);
    }) as unknown as typeof import("node:dns").lookup;
    guardedLookup("evil.example", {}, callback, resolve);
    expect(callback.mock.calls[0]![0]).toBeInstanceOf(UnsafeUrlError);
  });

  it("kamuya açık adres bağlantıya geçer", () => {
    const callback = vi.fn();
    const resolve = ((_host: string, _options: unknown, done: (e: Error | null, a: { address: string; family: number }[]) => void) => {
      done(null, [{ address: "93.184.216.34", family: 4 }]);
    }) as unknown as typeof import("node:dns").lookup;
    guardedLookup("example.com", {}, callback, resolve);
    expect(callback).toHaveBeenCalledWith(null, "93.184.216.34", 4);
  });

  it("yöntem, gövde ve sabit User-Agent ile gider", async () => {
    const { deps, captured } = fakeNet({
      status: 201,
      headers: { "Content-Type": "application/json" },
      chunks: [Buffer.from('{"id":1}')],
    });
    const transport = createGuardedWpTransport(deps);
    const response = await transport(
      request({
        method: "POST",
        url: new URL("https://example.com/wp-json/wp/v2/posts"),
        headers: { authorization: "Basic abc", "User-Agent": "evil" },
        body: '{"title":"x"}',
      }),
    );
    expect(response).toEqual({
      status: 201,
      headers: { "content-type": "application/json" },
      body: '{"id":1}',
      truncated: false,
    });
    expect(captured).toHaveLength(1);
    expect(captured[0]!.options.method).toBe("POST");
    expect(captured[0]!.body).toBe('{"title":"x"}');
    expect(captured[0]!.options.headers!["user-agent"]).toBe(WORDPRESS_USER_AGENT);
  });

  it("yönlendirmeyi izlemez: 301 olduğu gibi döner, tek istek atılır", async () => {
    const { deps, request: fn } = fakeNet({
      status: 301,
      headers: { location: "https://other.example/wp-json/" },
    });
    const transport = createGuardedWpTransport(deps);
    const response = await transport(request());
    expect(response.status).toBe(301);
    expect(response.headers.location).toBe("https://other.example/wp-json/");
    expect(response.body).toBe("");
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("gzip gövdeyi açar ve açılmış boyuta sınır uygular", async () => {
    const big = "a".repeat(5_000);
    const gz = gzipSync(Buffer.from(big));
    const { deps } = fakeNet({
      status: 200,
      headers: { "content-encoding": "gzip" },
      chunks: [gz],
    });
    const transport = createGuardedWpTransport(deps);
    const response = await transport(request({ maxBytes: 1_000 }));
    expect(response.truncated).toBe(true);
    expect(response.body.length).toBe(1_000);

    const small = fakeNet({
      status: 200,
      headers: { "content-encoding": "gzip" },
      chunks: [gzipSync(Buffer.from("hello"))],
    });
    const ok = await createGuardedWpTransport(small.deps)(request());
    expect(ok.body).toBe("hello");
    expect(ok.truncated).toBe(false);
  });

  it("yanıt gelmezse toplam süre sınırında düşer", async () => {
    const { deps } = fakeNet(null);
    const transport = createGuardedWpTransport(deps);
    await expect(transport(request({ timeoutMs: 20 }))).rejects.toBeInstanceOf(
      WpTimeoutError,
    );
  });

  it("istek kurulurken eşzamanlı hata fırlarsa reddeder ve zamanlayıcı süreci düşürmez", async () => {
    const throwing = vi.fn(() => {
      throw new Error("invalid header");
    });
    const deps = {
      http: { request: throwing },
      https: { request: throwing },
    } as unknown as WpNetDeps;
    const transport = createGuardedWpTransport(deps);
    await expect(transport(request({ timeoutMs: 20 }))).rejects.toThrow(
      "invalid header",
    );
    // Zamanlayıcı temizlenmiş olmalı: süre dolunca yakalanmamış hata oluşmaz.
    await new Promise((resolve) => setTimeout(resolve, 60));
  });
});

describe("wpTransportFor", () => {
  it("mock kipinde bellek içi taşıyıcı verir ve ağa çıkmaz", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const transport = wpTransportFor(true);
    const response = await transport(request({ url: new URL("https://mock.example/wp-json/") }));
    expect(response.status).toBe(200);
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });

  it("gerçek kipte korumalı taşıyıcıyı verir", () => {
    expect(wpTransportFor(false)).not.toBe(wpTransportFor(true));
  });
});
