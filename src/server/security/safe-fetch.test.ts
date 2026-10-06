import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  assertPublicAddresses,
  assertSafeUrl,
  isBlockedIp,
  safeFetch,
  UnsafeUrlError,
  type HopResponse,
  type Transport,
} from "./safe-fetch";

describe("isBlockedIp", () => {
  it.each([
    "0.0.0.0",
    "10.1.2.3",
    "100.64.0.1",
    "127.0.0.1",
    "127.255.255.254",
    "169.254.169.254", // cloud metadata
    "172.16.0.1",
    "172.31.255.255",
    "192.168.1.1",
    "198.18.0.1",
    "224.0.0.1",
    "255.255.255.255",
    "::",
    "::1",
    "fc00::1",
    "fd12:3456::1",
    "fe80::1",
    "ff02::1",
    "::ffff:127.0.0.1", // IPv4-mapped loopback
    "::ffff:10.0.0.1",
    "::ffff:7f00:1", // same, hex form
    "64:ff9b::a00:1", // NAT64 wrapping 10.0.0.1
    "2001:db8::1",
    "not-an-ip", // unparseable must never mean allowed
    "999.1.1.1",
  ])("blocks %s", (ip) => {
    expect(isBlockedIp(ip)).toBe(true);
  });

  it.each([
    "8.8.8.8",
    "1.1.1.1",
    "93.184.216.34",
    "172.15.0.1", // just outside 172.16/12
    "172.32.0.1",
    "100.63.255.255", // just outside CGNAT
    "2606:4700:4700::1111",
    "2a00:1450:4001:81b::200e",
  ])("allows public %s", (ip) => {
    expect(isBlockedIp(ip)).toBe(false);
  });
});

describe("assertSafeUrl", () => {
  it("accepts ordinary public http(s) URLs", () => {
    expect(assertSafeUrl("https://example.com/path?q=1").hostname).toBe(
      "example.com",
    );
    expect(assertSafeUrl("http://example.com:80/").port).toBe("");
  });

  it.each([
    ["file:///etc/passwd", /http and https/],
    ["ftp://example.com", /http and https/],
    ["javascript:alert(1)", /http and https/],
    ["https://user:pass@example.com", /credentials/],
    ["https://example.com:6379", /default web ports/],
    ["http://127.0.0.1/", /not publicly reachable/],
    ["http://169.254.169.254/latest/meta-data", /not publicly reachable/],
    ["http://[::1]/", /not publicly reachable/],
    ["http://[::ffff:127.0.0.1]/", /not publicly reachable/],
    ["http://2130706433/", /not publicly reachable/], // decimal 127.0.0.1
    ["not a url", /Invalid URL/],
  ])("rejects %s", (url, message) => {
    expect(() => assertSafeUrl(url)).toThrow(message);
  });
});

describe("assertPublicAddresses", () => {
  it("fails when ANY resolved record is non-public", () => {
    expect(() => assertPublicAddresses(["8.8.8.8", "10.0.0.5"])).toThrow(
      UnsafeUrlError,
    );
    expect(() => assertPublicAddresses([])).toThrow(UnsafeUrlError);
    expect(() => assertPublicAddresses(["8.8.8.8", "1.1.1.1"])).not.toThrow();
  });
});

function hop(partial: Partial<HopResponse> = {}): HopResponse {
  return {
    status: 200,
    headers: { "content-type": "text/html" },
    body: Buffer.from("<html></html>"),
    truncated: false,
    ...partial,
  };
}

describe("safeFetch redirects and limits", () => {
  const opts = { maxBytes: 1024 };

  it("follows redirects and validates each hop", async () => {
    const calls: string[] = [];
    const transport: Transport = async (url) => {
      calls.push(url.toString());
      return calls.length === 1
        ? hop({ status: 301, headers: { location: "/final" } })
        : hop({ body: Buffer.from("ok") });
    };
    const result = await safeFetch(
      "https://example.com/start",
      opts,
      transport,
    );
    expect(calls).toEqual([
      "https://example.com/start",
      "https://example.com/final",
    ]);
    expect(result.url).toBe("https://example.com/final");
    expect(result.body.toString()).toBe("ok");
  });

  it("refuses a redirect into a private address", async () => {
    const transport: Transport = async () =>
      hop({
        status: 302,
        headers: { location: "http://169.254.169.254/latest" },
      });
    await expect(
      safeFetch("https://example.com/", opts, transport),
    ).rejects.toThrow(/not publicly reachable/);
  });

  it("refuses a redirect to a non-http scheme", async () => {
    const transport: Transport = async () =>
      hop({ status: 302, headers: { location: "file:///etc/passwd" } });
    await expect(
      safeFetch("https://example.com/", opts, transport),
    ).rejects.toThrow(/http and https/);
  });

  it("gives up after too many redirects", async () => {
    const transport: Transport = async () =>
      hop({ status: 302, headers: { location: "/again" } });
    await expect(
      safeFetch(
        "https://example.com/",
        { ...opts, maxRedirects: 3 },
        transport,
      ),
    ).rejects.toThrow(/too many times/);
  });

  it("rejects error statuses and disallowed content types", async () => {
    await expect(
      safeFetch("https://example.com/", opts, async () => hop({ status: 404 })),
    ).rejects.toThrow(/HTTP 404/);
    await expect(
      safeFetch(
        "https://example.com/",
        { ...opts, allowedContentTypes: /^image\//i },
        async () => hop({ headers: { "content-type": "application/zip" } }),
      ),
    ).rejects.toThrow(/Unexpected content type/);
  });

  it("passes the truncated flag through", async () => {
    const result = await safeFetch(
      "https://example.com/",
      { ...opts, truncate: true },
      async () => hop({ truncated: true }),
    );
    expect(result.truncated).toBe(true);
  });
});

describe("safeFetch with the real transport", () => {
  it("blocks a hostname that resolves to loopback (checked at connect time)", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    // "localhost" passes the up-front URL check (it is a name, not an IP
    // literal) and is stopped by the guarded DNS lookup — no network needed.
    await expect(
      safeFetch("http://localhost/", { maxBytes: 1024, timeoutMs: 3000 }),
    ).rejects.toThrow(/non-public address/);
  });
});

describe("safeFetch hardDeadline (G110)", () => {
  it("hands the transport exactly today's options without the flag", async () => {
    const seen: unknown[] = [];
    const transport: Transport = async (_url, options) => {
      seen.push(options);
      return hop();
    };
    await safeFetch("https://example.com/", { maxBytes: 10 }, transport);
    await safeFetch(
      "https://example.com/",
      { maxBytes: 10, hardDeadline: false },
      transport,
    );
    for (const options of seen) {
      expect(options).toEqual({
        maxBytes: 10,
        truncate: false,
        timeoutMs: expect.any(Number),
        accept: "*/*",
      });
      expect(Object.keys(options as object)).not.toContain("hardDeadline");
    }
  });

  it("forwards the flag to the transport only when it is true", async () => {
    let seen: Record<string, unknown> = {};
    await safeFetch(
      "https://example.com/",
      { maxBytes: 10, hardDeadline: true },
      async (_url, options) => {
        seen = options;
        return hop();
      },
    );
    expect(seen.hardDeadline).toBe(true);
  });

  it("passes a custom user agent to the transport only when set", async () => {
    const seen: Record<string, unknown>[] = [];
    const transport: Transport = async (_url, options) => {
      seen.push(options);
      return hop();
    };
    await safeFetch(
      "https://example.com/",
      { maxBytes: 10, userAgent: "AgentelseSiteCheck/1.0" },
      transport,
    );
    await safeFetch("https://example.com/", { maxBytes: 10 }, transport);
    expect(seen[0]!.userAgent).toBe("AgentelseSiteCheck/1.0");
    expect("userAgent" in seen[1]!).toBe(false);
  });
});

// The real transport against a fake node:https: a server that keeps the
// socket "active" (so the idle timeout never fires) by trickling bytes.
describe("nodeTransport hard deadline (G110)", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.doUnmock("node:https");
    vi.doUnmock("node:http");
    vi.resetModules();
  });

  async function loadWithTrickle() {
    const destroyed = vi.fn();
    const request = Object.assign(new EventEmitter(), {
      destroy: (error?: Error) => {
        destroyed(error);
        if (error) request.emit("error", error);
        request.emit("close");
      },
      end: () => undefined,
    });
    const fakeClient = {
      request: (
        _url: URL,
        _opts: unknown,
        onResponse: (res: PassThrough) => void,
      ) => {
        const res = Object.assign(new PassThrough(), {
          statusCode: 200,
          headers: { "content-type": "text/html" },
        });
        setTimeout(() => onResponse(res), 0);
        // One byte every second: never idle for the 5 s socket timeout.
        const timer = setInterval(() => res.write("x"), 1000);
        request.on("close", () => clearInterval(timer));
        return request;
      },
    };
    vi.resetModules();
    vi.doMock("node:https", () => ({ default: fakeClient }));
    vi.doMock("node:http", () => ({ default: fakeClient }));
    const mod = await import("./safe-fetch");
    return { mod, destroyed };
  }

  it("aborts a trickling response at the TOTAL timeout", async () => {
    vi.useFakeTimers();
    const { mod, destroyed } = await loadWithTrickle();
    const pending = mod.safeFetch("https://example.com/", {
      maxBytes: 1024 * 1024,
      timeoutMs: 8000,
      hardDeadline: true,
    });
    const outcome = pending.then(
      () => "resolved",
      (error: Error) => error.message,
    );
    await vi.advanceTimersByTimeAsync(7900);
    expect(destroyed).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(200);
    expect(await outcome).toBe("The site took too long to respond");
    expect(destroyed).toHaveBeenCalledTimes(1);
  });

  it("does not arm the total deadline without the flag", async () => {
    vi.useFakeTimers();
    const { mod, destroyed } = await loadWithTrickle();
    const pending = mod.safeFetch("https://example.com/", {
      maxBytes: 1024 * 1024,
      timeoutMs: 8000,
    });
    void pending.catch(() => undefined);
    await vi.advanceTimersByTimeAsync(20_000);
    expect(destroyed).not.toHaveBeenCalled();
  });
});
