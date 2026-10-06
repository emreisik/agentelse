import { describe, expect, it } from "vitest";

import {
  crawlHostAllowed,
  crawlUrlHash,
  fnv1a64Hex,
  gscPageKey,
  hostTwin,
  inScope,
  isHomepageUrl,
  normalizeCrawlUrl,
  pathOf,
  scopeFromGscSite,
  scopeFromVerifiedDomain,
  startUrlFor,
} from "./crawl-url";
import { normalizePageUrl } from "./normalize";

// Bu dosyanın kanıtladığı: tarayıcı adresleri tek biçime iner (tekrar
// verildiğinde değişmez), GSC sayfa anahtarı W1'in GscPage.url'iyle aynıdır,
// kapsam kuralları alt alan adı / önek / http adımı uç durumlarında doğrudur.

describe("normalizeCrawlUrl", () => {
  it("lowercases scheme and host, drops default port and fragment", () => {
    expect(normalizeCrawlUrl("HTTPS://WWW.Example.COM:443/Path/Page#top")).toBe(
      "https://www.example.com/Path/Page",
    );
    expect(normalizeCrawlUrl("http://example.com:80")).toBe(
      "http://example.com/",
    );
    expect(normalizeCrawlUrl("http://example.com:8080/x")).toBe(
      "http://example.com:8080/x",
    );
  });

  it("strips tracking parameters case-insensitively and keeps the rest in order", () => {
    expect(
      normalizeCrawlUrl(
        "https://x.com/p?b=2&UTM_Source=news&a=1&gclid=abc&FBCLID=1&msclkid=2&mc_cid=3&mc_eid=4&_ga=5",
      ),
    ).toBe("https://x.com/p?b=2&a=1");
    expect(normalizeCrawlUrl("https://x.com/p?utm_medium=x")).toBe(
      "https://x.com/p",
    );
    expect(normalizeCrawlUrl("https://x.com/p?")).toBe("https://x.com/p");
  });

  it("resolves against a base and adds an empty path", () => {
    expect(normalizeCrawlUrl("../b", "https://x.com/a/c/")).toBe(
      "https://x.com/a/b",
    );
    expect(normalizeCrawlUrl("https://x.com")).toBe("https://x.com/");
  });

  it("does not decode or case-fold the path", () => {
    expect(normalizeCrawlUrl("https://x.com/%7Ea/ÜRÜN")).toBe(
      "https://x.com/%7Ea/%C3%9CR%C3%9CN",
    );
  });

  it("is idempotent", () => {
    const inputs = [
      "HTTPS://X.com:443/a/B?z=1&utm_x=2#f",
      "https://x.com/ürün?q=a b",
      "http://x.com",
      "https://x.com/p?a=1&&b=2",
    ];
    for (const input of inputs) {
      const once = normalizeCrawlUrl(input);
      expect(once).not.toBeNull();
      expect(normalizeCrawlUrl(once ?? "")).toBe(once);
    }
  });

  it("rejects non-http, invalid and over-long URLs", () => {
    expect(normalizeCrawlUrl("mailto:a@b.com")).toBeNull();
    expect(normalizeCrawlUrl("javascript:alert(1)")).toBeNull();
    expect(normalizeCrawlUrl("ftp://x.com/")).toBeNull();
    expect(normalizeCrawlUrl("not a url")).toBeNull();
    expect(normalizeCrawlUrl(`https://x.com/${"a".repeat(2100)}`)).toBeNull();
  });
});

describe("hashes and keys", () => {
  it("crawlUrlHash is 32 hex characters and stable", () => {
    const hash = crawlUrlHash("https://x.com/");
    expect(hash).toMatch(/^[0-9a-f]{32}$/);
    expect(crawlUrlHash("https://x.com/")).toBe(hash);
  });

  it("gscPageKey equals normalizePageUrl(url).url", () => {
    const urls = [
      "https://x.com/blog/post?utm_source=a&id=1",
      "https://x.com/reset/3f2b1c4d-1111-2222-3333-444455556666",
      "https://x.com/account/AbCdEfGh1234567890IjKlMnOp",
      "https://x.com",
    ];
    for (const url of urls) {
      expect(gscPageKey(url)).toBe(normalizePageUrl(url)?.url);
    }
    expect(
      gscPageKey("https://x.com/reset/3f2b1c4d-1111-2222-3333-444455556666"),
    ).toBe("https://x.com/reset/[id]");
    expect(gscPageKey("https://x.com/a?b=1")).toBe("https://x.com/a");
    expect(gscPageKey("nope")).toBeNull();
  });

  it("fnv1a64Hex matches a BigInt reference", () => {
    const reference = (text: string) => {
      let hash = BigInt("0xcbf29ce484222325");
      const prime = BigInt("0x100000001b3");
      const mask = (BigInt(1) << BigInt(64)) - BigInt(1);
      for (const byte of new TextEncoder().encode(text)) {
        hash = ((hash ^ BigInt(byte)) * prime) & mask;
      }
      return hash.toString(16).padStart(16, "0");
    };
    for (const text of [
      "",
      "a",
      "hello world",
      "Şirket ürünleri 🚀",
      "x".repeat(1000),
    ]) {
      expect(fnv1a64Hex(text)).toBe(reference(text));
    }
    expect(fnv1a64Hex("")).toBe("cbf29ce484222325");
  });

  it("pathOf, isHomepageUrl and hostTwin", () => {
    expect(pathOf("https://x.com/a?b=1")).toBe("/a?b=1");
    expect(pathOf("https://x.com")).toBe("/");
    expect(pathOf("bad")).toBe("/");
    expect(isHomepageUrl("https://x.com/")).toBe(true);
    expect(isHomepageUrl("https://x.com/?a=1")).toBe(false);
    expect(isHomepageUrl("https://x.com/a")).toBe(false);
    expect(hostTwin("www.x.com")).toBe("x.com");
    expect(hostTwin("x.com")).toBe("www.x.com");
  });
});

describe("scopes", () => {
  it("builds a domain scope from sc-domain", () => {
    const scope = scopeFromGscSite("sc-domain:Example.com");
    expect(scope).toEqual({
      kind: "GSC_DOMAIN",
      root: "example.com",
      prefix: null,
      key: "GSC_DOMAIN:example.com:",
    });
    expect(scopeFromGscSite("sc-domain:")).toBeNull();
  });

  it("builds a prefix scope with a trailing slash and a lowercased host", () => {
    const scope = scopeFromGscSite("https://WWW.X.com/Blog");
    expect(scope).toEqual({
      kind: "GSC_PREFIX",
      root: "www.x.com",
      prefix: "https://www.x.com/Blog/",
      key: "GSC_PREFIX:www.x.com:https://www.x.com/Blog/",
    });
    expect(scopeFromGscSite("https://x.com/")?.prefix).toBe("https://x.com/");
    expect(scopeFromGscSite("ftp://x.com/")).toBeNull();
  });

  it("builds a verified-domain scope", () => {
    expect(scopeFromVerifiedDomain("https://www.Shop.com/")).toEqual({
      kind: "VERIFIED_DOMAIN",
      root: "shop.com",
      prefix: null,
      key: "VERIFIED_DOMAIN:shop.com:",
    });
    expect(scopeFromVerifiedDomain("not a domain")).toBeNull();
  });

  it("domain scope covers subdomains and both schemes", () => {
    const scope = scopeFromGscSite("sc-domain:x.com");
    if (!scope) throw new Error("scope");
    expect(inScope("https://x.com/a", scope)).toBe(true);
    expect(inScope("http://blog.x.com/a", scope)).toBe(true);
    expect(inScope("https://evilx.com/", scope)).toBe(false);
    expect(inScope("https://x.com.evil.com/", scope)).toBe(false);
    expect(inScope("mailto:a@x.com", scope)).toBe(false);
  });

  it("prefix scope: /blog/ is not /blogger, http hop allowed for an https prefix", () => {
    const scope = scopeFromGscSite("https://www.x.com/blog/");
    if (!scope) throw new Error("scope");
    expect(inScope("https://www.x.com/blog/post", scope)).toBe(true);
    expect(inScope("https://www.x.com/blog/", scope)).toBe(true);
    expect(inScope("https://www.x.com/blogger", scope)).toBe(false);
    expect(inScope("https://www.x.com/blog", scope)).toBe(false);
    expect(inScope("http://www.x.com/blog/post", scope)).toBe(true);
    expect(inScope("https://x.com/blog/post", scope)).toBe(false);
    expect(inScope("https://shop.www.x.com/blog/", scope)).toBe(false);
    const httpScope = scopeFromGscSite("http://www.x.com/");
    if (!httpScope) throw new Error("scope");
    expect(inScope("https://www.x.com/", httpScope)).toBe(false);
  });

  it("verified scope covers the root and www only", () => {
    const scope = scopeFromVerifiedDomain("x.com");
    if (!scope) throw new Error("scope");
    expect(inScope("https://x.com/", scope)).toBe(true);
    expect(inScope("http://www.x.com/a", scope)).toBe(true);
    expect(inScope("https://blog.x.com/", scope)).toBe(false);
  });

  it("startUrlFor", () => {
    const domain = scopeFromGscSite("sc-domain:x.com");
    const prefix = scopeFromGscSite("https://www.x.com/shop/");
    const verified = scopeFromVerifiedDomain("x.com");
    if (!domain || !prefix || !verified) throw new Error("scope");
    expect(startUrlFor(prefix, "x.com")).toBe("https://www.x.com/shop/");
    expect(startUrlFor(domain, "shop.x.com")).toBe("https://shop.x.com/");
    expect(startUrlFor(domain, "x.com")).toBe("https://x.com/");
    expect(startUrlFor(domain, "other.com")).toBe("https://x.com/");
    expect(startUrlFor(domain, null)).toBe("https://x.com/");
    expect(startUrlFor(verified, null)).toBe("https://x.com/");
  });

  it("crawlHostAllowed accepts the origin host and its twin only", () => {
    expect(crawlHostAllowed("https://www.x.com/a", "www.x.com")).toBe(true);
    expect(crawlHostAllowed("https://x.com/a", "www.x.com")).toBe(true);
    expect(crawlHostAllowed("https://www.x.com/a", "x.com")).toBe(true);
    expect(crawlHostAllowed("https://blog.x.com/a", "x.com")).toBe(false);
    expect(crawlHostAllowed("bad", "x.com")).toBe(false);
  });
});
