import { gunzipSync } from "node:zlib";

import { afterEach, describe, expect, it } from "vitest";

import type { GuardedRequest } from "@/server/security/guarded-transport";

import {
  currentMockSiteOverrides,
  MOCK_SITE_PATHS,
  MOCK_VERIFICATION_TOKEN,
  mockSiteTransport,
  setMockSiteOverrides,
  type MockRequestLog,
} from "./mock-site";

const REQUEST: GuardedRequest = {
  userAgent: "AgentelseSiteAudit/1.0 (+https://agentelse.com/bot)",
  accept: "*/*",
  maxBytes: 2_000_000,
  timeoutMs: 12_000,
};

const get = (url: string, extra: Partial<GuardedRequest> = {}) =>
  mockSiteTransport()(new URL(url), { ...REQUEST, ...extra });

afterEach(() => {
  setMockSiteOverrides(null);
});

describe("mockSiteTransport", () => {
  it("serves deterministic bodies and ETags on any host", async () => {
    const a = await get("https://shop.example/pricing");
    const b = await get("https://shop.example/pricing");
    expect(a.status).toBe(200);
    expect(a.body.equals(b.body)).toBe(true);
    expect(a.headers.etag).toBe(b.headers.etag);
    expect(a.headers.etag).toMatch(/^"[0-9a-f]{8}"$/);
    const other = await get("https://other.example/pricing");
    expect(other.status).toBe(200);
  });

  it("serves every listed path with a known status", async () => {
    for (const path of MOCK_SITE_PATHS) {
      const response = await get(`https://shop.example${path}`);
      expect([200, 301, 302, 404]).toContain(response.status);
    }
    expect((await get("https://shop.example/missing")).status).toBe(404);
    expect((await get("https://shop.example/hreflang-tr")).status).toBe(404);
  });

  it("links the homepage to the audit pages, the twin host and carries the verification meta", async () => {
    const html = (await get("https://shop.example/")).body.toString("utf8");
    for (const path of [
      "/pricing",
      "/about",
      "/blog/",
      "/dup-a",
      "/dup-b",
      "/noindex-page",
      "/missing",
      "/old-page",
      "/chain-1",
      "/mixed",
      "/schema-broken",
      "/hreflang-en",
      "/private/secret",
    ]) {
      expect(html).toContain(`href="${path}"`);
    }
    expect(html).toContain('href="https://www.shop.example/about"');
    expect(html).toContain(
      `<meta name="agentelse-site-verification" content="${MOCK_VERIFICATION_TOKEN}">`,
    );
    const www = (await get("https://www.shop.example/")).body.toString("utf8");
    expect(www).not.toContain("https://www.www.shop.example");
  });

  it("redirects as the audit drills expect", async () => {
    const old = await get("https://shop.example/old-page");
    expect(old.status).toBe(301);
    expect(old.headers.location).toBe("/");
    expect(old.body.length).toBe(0);
    expect((await get("https://shop.example/chain-1")).headers.location).toBe(
      "/chain-2",
    );
    expect((await get("https://shop.example/chain-2")).headers.location).toBe(
      "/chain-3",
    );
    expect((await get("https://shop.example/chain-3")).headers.location).toBe(
      "/pricing",
    );
    const plain = await get("http://shop.example/about?x=1");
    expect(plain.status).toBe(301);
    expect(plain.headers.location).toBe("https://shop.example/about?x=1");
  });

  it("builds the audit edge cases into the pages", async () => {
    const text = async (path: string) =>
      (await get(`https://shop.example${path}`)).body.toString("utf8");
    expect(await text("/noindex-page")).toContain(
      '<meta name="robots" content="noindex">',
    );
    expect(await text("/mixed")).toContain('src="http://shop.example/');
    expect(await text("/schema-broken")).toContain("application/ld+json");
    expect(await text("/hreflang-en")).toContain(
      'hreflang="tr" href="https://shop.example/hreflang-tr"',
    );

    const dupA = await text("/dup-a");
    const dupB = await text("/dup-b");
    const bodyOf = (html: string) => html.slice(html.indexOf("<body>"));
    expect(bodyOf(dupA)).toBe(bodyOf(dupB));

    const blog = await text("/blog/");
    for (let index = 1; index <= 8; index += 1) {
      expect(blog).toContain(`href="/blog/post-${index}"`);
      const post = await text(`/blog/post-${index}`);
      const visible = bodyOf(post)
        .replace(/<[^>]+>/g, " ")
        .split(/\s+/)
        .filter(Boolean);
      expect(visible.length).toBeGreaterThanOrEqual(280);
      expect(visible.length).toBeLessThanOrEqual(330);
    }
    expect(await text("/blog/post-1")).not.toBe(await text("/blog/post-2"));
  });

  it("serves robots.txt and a sitemap index with a real gzip child", async () => {
    const robots = await get("https://shop.example/robots.txt");
    expect(robots.body.toString("utf8")).toBe(
      "User-agent: *\nDisallow: /private/\nSitemap: https://shop.example/sitemap.xml\n",
    );
    const index = (await get("https://shop.example/sitemap.xml")).body.toString(
      "utf8",
    );
    expect(index).toContain("<sitemapindex");
    expect(index).toContain(
      "<loc>https://shop.example/sitemap-pages.xml</loc>",
    );
    expect(index).toContain(
      "<loc>https://shop.example/sitemap-posts.xml.gz</loc>",
    );

    const pages = (
      await get("https://shop.example/sitemap-pages.xml")
    ).body.toString("utf8");
    expect(pages).toContain("<loc>https://shop.example/noindex-page</loc>");
    expect(pages).toContain("<loc>https://shop.example/old-page</loc>");

    const gz = await get("https://shop.example/sitemap-posts.xml.gz");
    expect(gz.headers["content-type"]).toBe("application/gzip");
    expect(gz.headers["content-encoding"]).toBeUndefined();
    expect(gz.body[0]).toBe(0x1f);
    expect(gz.body[1]).toBe(0x8b);
    const posts = gunzipSync(gz.body).toString("utf8");
    expect(posts).toContain("<loc>https://shop.example/blog/post-8</loc>");
    const again = await get("https://shop.example/sitemap-posts.xml.gz");
    expect(again.body.equals(gz.body)).toBe(true);
  });

  it("answers a matching If-None-Match with 304 and no body", async () => {
    const first = await get("https://shop.example/about");
    const etag = String(first.headers.etag);
    const second = await get("https://shop.example/about", {
      headers: { "If-None-Match": etag },
    });
    expect(second.status).toBe(304);
    expect(second.body.length).toBe(0);
    expect(second.headers.etag).toBe(etag);
    const stale = await get("https://shop.example/about", {
      headers: { "if-none-match": '"00000000"' },
    });
    expect(stale.status).toBe(200);
  });

  it("applies per-path overrides", async () => {
    const transport = mockSiteTransport({
      overrides: {
        "/robots.txt": { html: "User-agent: *\nDisallow: /" },
        "/": {
          html: '<html><head><meta name="robots" content="noindex"></head></html>',
        },
        "/sitemap.xml": { status: 500 },
        "/old-page": { status: 200, html: "<p>back</p>" },
      },
    });
    const at = (path: string) =>
      transport(new URL(`https://shop.example${path}`), REQUEST);
    expect((await at("/robots.txt")).body.toString("utf8")).toBe(
      "User-agent: *\nDisallow: /",
    );
    expect((await at("/")).body.toString("utf8")).toContain("noindex");
    expect((await at("/sitemap.xml")).status).toBe(500);
    const restored = await at("/old-page");
    expect(restored.status).toBe(200);
    expect(restored.headers.location).toBeUndefined();
    expect((await at("/pricing")).status).toBe(200);
  });

  it("keeps module overrides until cleared", () => {
    setMockSiteOverrides({ "/": { status: 503 } });
    expect(currentMockSiteOverrides()).toEqual({ "/": { status: 503 } });
    setMockSiteOverrides(null);
    expect(currentMockSiteOverrides()).toBeNull();
  });

  it("logs every request with the clock and lowercased headers", async () => {
    const log: MockRequestLog = [];
    let now = 5_000;
    const transport = mockSiteTransport({ log, now: () => now });
    await transport(new URL("https://shop.example/"), REQUEST);
    now += 1_000;
    await transport(new URL("https://shop.example/old-page"), REQUEST);
    expect(log).toEqual([
      expect.objectContaining({ url: "https://shop.example/", at: 5_000 }),
      expect.objectContaining({
        url: "https://shop.example/old-page",
        at: 6_000,
      }),
    ]);
    expect(log[0]!.headers["user-agent"]).toBe(REQUEST.userAgent);
  });

  it("skips non-matching bodies and truncates at maxBytes", async () => {
    const skipped = await get("https://shop.example/robots.txt", {
      bodyContentTypes: /^text\/html/i,
    });
    expect(skipped.bodySkipped).toBe(true);
    expect(skipped.body.length).toBe(0);
    const cut = await get("https://shop.example/", { maxBytes: 100 });
    expect(cut.truncated).toBe(true);
    expect(cut.body.length).toBe(100);
  });
});
