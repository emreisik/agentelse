import { describe, expect, it } from "vitest";

import { scopeFromVerifiedDomain } from "@/lib/seo/crawl-url";

import { validateLinks } from "./validate-links";

const scope = scopeFromVerifiedDomain("example.com");
if (!scope) throw new Error("scope fixture");
const ctx = { pageUrl: "https://example.com/blog/post", scope };

describe("validateLinks", () => {
  it("accepts same-site links and normalizes the target", () => {
    const result = validateLinks(
      [{ toUrl: "https://www.example.com/pricing#top?utm_source=x", anchor: "  our   pricing " }],
      ctx,
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.links).toHaveLength(1);
      expect(result.links[0]?.anchor).toBe("our pricing");
      expect(result.links[0]?.toUrl.startsWith("https://www.example.com/pricing")).toBe(true);
    }
  });

  it("allows at most 3 links and at least 1", () => {
    const mk = (n: number) =>
      Array.from({ length: n }, (_, i) => ({ toUrl: `https://example.com/p${i}`, anchor: `anchor${i}` }));
    expect(validateLinks(mk(3), ctx).ok).toBe(true);
    expect(validateLinks(mk(4), ctx).ok).toBe(false);
    expect(validateLinks([], ctx).ok).toBe(false);
    expect(validateLinks("nope", ctx).ok).toBe(false);
  });

  it("refuses links outside the site", () => {
    expect(validateLinks([{ toUrl: "https://other.com/x", anchor: "other site" }], ctx).ok).toBe(false);
    expect(validateLinks([{ toUrl: "ftp://example.com/x", anchor: "other site" }], ctx).ok).toBe(false);
    expect(validateLinks([{ toUrl: "not a url", anchor: "other site" }], ctx).ok).toBe(false);
  });

  it("refuses a link to the page itself", () => {
    expect(validateLinks([{ toUrl: "https://example.com/blog/post", anchor: "this post" }], ctx).ok).toBe(false);
  });

  it("refuses duplicates", () => {
    const same = { toUrl: "https://example.com/a", anchor: "Alpha" };
    expect(validateLinks([same, { ...same }], ctx).ok).toBe(false);
    expect(
      validateLinks(
        [same, { toUrl: "https://example.com/b", anchor: "alpha" }],
        ctx,
      ).ok,
    ).toBe(false);
  });

  it("checks the anchor length and characters", () => {
    const link = (anchor: string) => [{ toUrl: "https://example.com/a", anchor }];
    expect(validateLinks(link("a"), ctx).ok).toBe(false);
    expect(validateLinks(link("ab"), ctx).ok).toBe(true);
    expect(validateLinks(link("a".repeat(60)), ctx).ok).toBe(true);
    expect(validateLinks(link("a".repeat(61)), ctx).ok).toBe(false);
    expect(validateLinks(link("bad <b>anchor"), ctx).ok).toBe(false);
    expect(validateLinks(link("two\nlines"), ctx).ok).toBe(false);
  });

  it("refuses malformed items", () => {
    expect(validateLinks([null], ctx).ok).toBe(false);
    expect(validateLinks([{ toUrl: 3, anchor: "ok anchor" }], ctx).ok).toBe(false);
  });
});
