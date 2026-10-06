import { afterEach, describe, expect, it, vi } from "vitest";

import { SEO_CRAWLER_USER_AGENT } from "@/lib/seo/audit-constants";
import type { CrawlScope } from "@/lib/seo/crawl-url";
import {
  GuardedTimeoutError,
  type GuardedTransport,
} from "@/server/security/guarded-transport";
import { UnsafeUrlError } from "@/server/security/safe-fetch";

import { parseRetryAfter, siteFetch, type SiteFetchDeps } from "./fetcher";
import {
  mockSiteTransport,
  type MockPageOverride,
  type MockRequestLog,
} from "./mock-site";
import { createHostPacer } from "./pacer";

const SCOPE: CrawlScope = {
  kind: "VERIFIED_DOMAIN",
  root: "shop.com",
  prefix: null,
  key: "VERIFIED_DOMAIN:shop.com:",
};
const DOMAIN_SCOPE: CrawlScope = {
  kind: "GSC_DOMAIN",
  root: "shop.com",
  prefix: null,
  key: "GSC_DOMAIN:shop.com:",
};

// Sahte saat: pacer'ın uykusu saati ilerletir, mock site aynı saatle loglar.
function setup(overrides?: Readonly<Record<string, MockPageOverride>>) {
  let clock = 1_000_000;
  const log: MockRequestLog = [];
  const now = () => clock;
  const deps: SiteFetchDeps = {
    transport: mockSiteTransport({
      log,
      now,
      ...(overrides ? { overrides } : {}),
    }),
    pacer: createHostPacer({
      now,
      sleep: async (ms) => {
        clock += ms;
      },
    }),
  };
  return { deps, log };
}

const base = { scope: SCOPE, originHost: "shop.com", accept: "html" } as const;

afterEach(() => {
  vi.restoreAllMocks();
});

describe("siteFetch", () => {
  it("keeps consecutive requests to one host at least 1000 ms apart", async () => {
    const { deps, log } = setup();
    await siteFetch("https://shop.com/chain-1", base, deps);
    await siteFetch("https://shop.com/about", base, deps);
    expect(log).toHaveLength(5);
    for (let index = 1; index < log.length; index += 1) {
      expect(log[index]!.at - log[index - 1]!.at).toBeGreaterThanOrEqual(1_000);
    }
  });

  it("never requests a robots-disallowed URL", async () => {
    const { deps, log } = setup();
    const result = await siteFetch(
      "https://shop.com/private/secret",
      {
        ...base,
        isAllowed: (url) => !new URL(url).pathname.startsWith("/private/"),
      },
      deps,
    );
    expect(result.blockedByRobots).toBe(true);
    expect(result.blockedHop).toBe(false);
    expect(result.status).toBeNull();
    expect(result.hops).toEqual([]);
    expect(log).toEqual([]);
  });

  it("awaits an async robots check on every hop", async () => {
    const { deps, log } = setup();
    const checked: string[] = [];
    const result = await siteFetch(
      "https://shop.com/chain-1",
      {
        ...base,
        isAllowed: async (url) => {
          checked.push(url);
          await Promise.resolve();
          return !url.endsWith("/chain-3");
        },
      },
      deps,
    );
    expect(checked).toEqual([
      "https://shop.com/chain-1",
      "https://shop.com/chain-2",
      "https://shop.com/chain-3",
    ]);
    expect(result.blockedByRobots).toBe(false);
    expect(result.blockedHop).toBe(true);
    expect(result.hops.map((hop) => hop.status)).toEqual([301, 302]);
    expect(result.finalUrl).toBe("https://shop.com/chain-3");
    expect(log.map((entry) => entry.url)).toEqual([
      "https://shop.com/chain-1",
      "https://shop.com/chain-2",
    ]);
  });

  it("follows a redirect chain hop by hop", async () => {
    const { deps } = setup();
    const result = await siteFetch("https://shop.com/chain-1", base, deps);
    expect(result.hops).toEqual([
      { url: "https://shop.com/chain-1", status: 301 },
      { url: "https://shop.com/chain-2", status: 302 },
      { url: "https://shop.com/chain-3", status: 301 },
      { url: "https://shop.com/pricing", status: 200 },
    ]);
    expect(result.finalUrl).toBe("https://shop.com/pricing");
    expect(result.status).toBe(200);
    expect(result.body?.toString("utf8")).toContain("<title>");
    expect(result.contentType).toMatch(/^text\/html/);
    expect(result.etag).toMatch(/^"/);
    expect(result.errorKind).toBeNull();
  });

  it("follows http → https on the origin host", async () => {
    const { deps } = setup();
    const result = await siteFetch(
      "http://shop.com/",
      { ...base, accept: "any" },
      deps,
    );
    expect(result.hops.map((hop) => hop.status)).toEqual([301, 200]);
    expect(result.finalUrl).toBe("https://shop.com/");
  });

  it("detects a redirect loop", async () => {
    const { deps, log } = setup({
      "/loop-a": { status: 301, headers: { Location: "/loop-b" } },
      "/loop-b": { status: 302, headers: { Location: "/loop-a?utm_source=x" } },
    });
    const result = await siteFetch("https://shop.com/loop-a", base, deps);
    expect(result.redirectLoop).toBe(true);
    expect(result.tooManyRedirects).toBe(false);
    expect(log).toHaveLength(2);
    expect(result.status).toBe(302);
  });

  it("stops after too many redirects", async () => {
    const overrides: Record<string, MockPageOverride> = {};
    for (let index = 1; index <= 8; index += 1) {
      overrides[`/r${index}`] = {
        status: 301,
        headers: { location: `/r${index + 1}` },
      };
    }
    const { deps, log } = setup(overrides);
    const result = await siteFetch("https://shop.com/r1", base, deps);
    expect(result.tooManyRedirects).toBe(true);
    expect(result.redirectLoop).toBe(false);
    // İlk istek + 4 yönlendirme = 5 istek.
    expect(log).toHaveLength(5);
    expect(result.hops).toHaveLength(5);
  });

  it("stops with leftScope when a redirect leaves the scope", async () => {
    const { deps, log } = setup({
      "/out": { status: 301, headers: { location: "https://elsewhere.net/" } },
    });
    const result = await siteFetch("https://shop.com/out", base, deps);
    expect(result.leftScope).toBe(true);
    expect(result.finalUrl).toBe("https://elsewhere.net/");
    expect(result.status).toBe(301);
    expect(log).toHaveLength(1);
  });

  it("stops with leftScope on a host outside the allowed origin and twin", async () => {
    const { deps, log } = setup({
      "/sub": { status: 301, headers: { location: "https://blog.shop.com/" } },
      "/www": {
        status: 301,
        headers: { location: "https://www.shop.com/about" },
      },
    });
    const options = { ...base, scope: DOMAIN_SCOPE };
    const sub = await siteFetch("https://shop.com/sub", options, deps);
    expect(sub.leftScope).toBe(true);
    expect(log).toHaveLength(1);

    const twin = await siteFetch("https://shop.com/www", options, deps);
    expect(twin.leftScope).toBe(false);
    expect(twin.finalUrl).toBe("https://www.shop.com/about");
    expect(twin.status).toBe(200);

    // originHost null: kapsamdaki her alan adı izlenir.
    const any = await siteFetch(
      "https://shop.com/sub",
      { ...options, originHost: null },
      deps,
    );
    expect(any.leftScope).toBe(false);
    expect(any.finalUrl).toBe("https://blog.shop.com/");
  });

  it("treats an out-of-scope first URL as leftScope without a request", async () => {
    const { deps, log } = setup();
    const result = await siteFetch("https://other.org/", base, deps);
    expect(result.leftScope).toBe(true);
    expect(log).toEqual([]);
  });

  it("sends If-None-Match on a conditional GET and reports notModified", async () => {
    const { deps, log } = setup();
    const first = await siteFetch("https://shop.com/about", base, deps);
    expect(first.etag).toBeTruthy();
    const second = await siteFetch(
      "https://shop.com/about",
      {
        ...base,
        conditional: {
          etag: first.etag,
          lastModified: "Mon, 05 Oct 2026 00:00:00 GMT",
        },
      },
      deps,
    );
    expect(log[1]!.headers["if-none-match"]).toBe(first.etag);
    expect(log[1]!.headers["if-modified-since"]).toBe(
      "Mon, 05 Oct 2026 00:00:00 GMT",
    );
    expect(log[0]!.headers["if-none-match"]).toBeUndefined();
    expect(second.status).toBe(304);
    expect(second.notModified).toBe(true);
    expect(second.body).toBeNull();
  });

  it("sends conditional headers on hop 0 only", async () => {
    const { deps, log } = setup();
    await siteFetch(
      "https://shop.com/old-page",
      { ...base, conditional: { etag: '"abc"', lastModified: null } },
      deps,
    );
    expect(log[0]!.headers["if-none-match"]).toBe('"abc"');
    expect(log[1]!.headers["if-none-match"]).toBeUndefined();
  });

  it("identifies itself exactly with SEO_CRAWLER_USER_AGENT", async () => {
    const { deps, log } = setup();
    await siteFetch("https://shop.com/", base, deps);
    expect(log[0]!.headers["user-agent"]).toBe(SEO_CRAWLER_USER_AGENT);
    expect(log[0]!.headers.accept).toBe("text/html,application/xhtml+xml");
    await siteFetch(
      "https://shop.com/robots.txt",
      { ...base, accept: "any" },
      deps,
    );
    expect(log[1]!.headers["user-agent"]).toBe(SEO_CRAWLER_USER_AGENT);
    expect(log[1]!.headers.accept).toBe("*/*");
  });

  it("exposes Retry-After on a 429", async () => {
    const { deps } = setup({
      "/busy": { status: 429, headers: { "Retry-After": "120" } },
    });
    const result = await siteFetch("https://shop.com/busy", base, deps);
    expect(result.status).toBe(429);
    expect(result.retryAfterMs).toBe(120_000);
  });

  it("parses Retry-After from seconds or an HTTP date", () => {
    const now = Date.parse("2026-10-06T12:00:00Z");
    expect(parseRetryAfter("30", now)).toBe(30_000);
    expect(parseRetryAfter("Tue, 06 Oct 2026 12:05:00 GMT", now)).toBe(300_000);
    expect(parseRetryAfter("Tue, 06 Oct 2026 11:00:00 GMT", now)).toBe(0);
    expect(parseRetryAfter("soon", now)).toBeNull();
    expect(parseRetryAfter(null, now)).toBeNull();
  });

  it("skips a non-HTML body when HTML is asked for", async () => {
    const { deps } = setup();
    const skipped = await siteFetch("https://shop.com/robots.txt", base, deps);
    expect(skipped.status).toBe(200);
    expect(skipped.bodySkipped).toBe(true);
    expect(skipped.body).toBeNull();
    const kept = await siteFetch(
      "https://shop.com/robots.txt",
      { ...base, accept: "any" },
      deps,
    );
    expect(kept.bodySkipped).toBe(false);
    expect(kept.body?.toString("utf8")).toContain("Disallow: /private/");
  });

  it("exposes X-Robots-Tag values", async () => {
    const { deps } = setup({
      "/tagged": {
        status: 200,
        html: "<p>x</p>",
        headers: { "X-Robots-Tag": "noindex" },
      },
    });
    const result = await siteFetch("https://shop.com/tagged", base, deps);
    expect(result.xRobotsTag).toEqual(["noindex"]);
  });

  it.each<[Error, "NETWORK" | "TIMEOUT" | "UNSAFE"]>([
    [new Error("socket hang up"), "NETWORK"],
    [
      Object.assign(new Error("connect ETIMEDOUT"), { code: "ETIMEDOUT" }),
      "TIMEOUT",
    ],
    [new GuardedTimeoutError(), "TIMEOUT"],
    [
      new UnsafeUrlError("That host resolves to a non-public address"),
      "UNSAFE",
    ],
  ])(
    "turns a transport rejection (%s) into errorKind %s without throwing",
    async (error, kind) => {
      const warn = vi
        .spyOn(console, "warn")
        .mockImplementation(() => undefined);
      const transport: GuardedTransport = async () => {
        throw error;
      };
      const { deps } = setup();
      const result = await siteFetch("https://shop.com/", base, {
        ...deps,
        transport,
      });
      expect(result.errorKind).toBe(kind);
      expect(result.error).toBe(error.message);
      expect(result.status).toBeNull();
      expect(result.hops).toEqual([]);
      // Güvenlik reddi hata olarak loglanmaz.
      expect(warn).toHaveBeenCalledTimes(kind === "UNSAFE" ? 0 : 1);
    },
  );

  it("rejects private IP literals as UNSAFE without a request", async () => {
    const { deps, log } = setup();
    const scope: CrawlScope = {
      kind: "VERIFIED_DOMAIN",
      root: "127.0.0.1",
      prefix: null,
      key: "x",
    };
    const result = await siteFetch(
      "http://127.0.0.1/",
      { ...base, scope, originHost: null },
      deps,
    );
    expect(result.errorKind).toBe("UNSAFE");
    expect(log).toEqual([]);
  });

  it("never throws on an invalid URL or a failing robots check", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const { deps, log } = setup();
    const invalid = await siteFetch("not a url", base, deps);
    expect(invalid.errorKind).toBe("UNSAFE");
    const failing = await siteFetch(
      "https://shop.com/",
      {
        ...base,
        isAllowed: () => {
          throw new Error("robots store down");
        },
      },
      deps,
    );
    expect(failing.blockedByRobots).toBe(true);
    expect(log).toEqual([]);
    expect(warn).toHaveBeenCalled();
  });
});
