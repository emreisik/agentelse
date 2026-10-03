import { describe, expect, it } from "vitest";

import {
  MAX_LINKS_PER_REQUEST,
  imageUrlFromHtml,
  isSocialLink,
  parseLinkLines,
} from "./post-style-links";

describe("parseLinkLines", () => {
  it("takes links from lines, spaces and commas, once each", () => {
    expect(
      parseLinkLines(
        "https://a.com/1.jpg\nhttps://b.com/p, https://a.com/1.jpg   http://c.com/x.png",
      ),
    ).toEqual(["https://a.com/1.jpg", "https://b.com/p", "http://c.com/x.png"]);
  });

  it("drops what is not an http link and trailing punctuation", () => {
    expect(
      parseLinkLines("see (https://a.com/p). ftp://x.com/y javascript:alert(1) just text"),
    ).toEqual(["https://a.com/p"]);
    expect(parseLinkLines("")).toEqual([]);
  });

  it("stops at the limit and drops absurdly long links", () => {
    const many = Array.from({ length: 12 }, (_, i) => `https://a.com/${i}`).join("\n");
    expect(parseLinkLines(many)).toHaveLength(MAX_LINKS_PER_REQUEST);
    expect(parseLinkLines(`https://a.com/${"x".repeat(600)}`)).toEqual([]);
  });
});

describe("imageUrlFromHtml", () => {
  const html = (head: string) => `<html><head>${head}</head><body></body></html>`;

  it("reads the Open Graph picture, either attribute order, any quoting", () => {
    expect(
      imageUrlFromHtml(
        html('<meta property="og:image" content="https://cdn.x.com/p.jpg">'),
        "https://x.com/post/1",
      ),
    ).toBe("https://cdn.x.com/p.jpg");
    expect(
      imageUrlFromHtml(
        html("<meta content='https://cdn.x.com/q.jpg' property='og:image'/>"),
        "https://x.com/post/1",
      ),
    ).toBe("https://cdn.x.com/q.jpg");
  });

  it("prefers the secure Open Graph picture, then falls back to Twitter and image_src", () => {
    expect(
      imageUrlFromHtml(
        html(
          '<meta name="twitter:image" content="https://t.com/t.jpg"><meta property="og:image:secure_url" content="https://s.com/s.jpg">',
        ),
        "https://x.com",
      ),
    ).toBe("https://s.com/s.jpg");
    expect(
      imageUrlFromHtml(
        html('<meta name="twitter:image" content="https://t.com/t.jpg">'),
        "https://x.com",
      ),
    ).toBe("https://t.com/t.jpg");
    expect(
      imageUrlFromHtml(
        html('<link rel="image_src" href="/img/a.png">'),
        "https://x.com/page",
      ),
    ).toBe("https://x.com/img/a.png");
  });

  it("makes a relative address absolute and decodes entities", () => {
    expect(
      imageUrlFromHtml(
        html('<meta property="og:image" content="/p.jpg?a=1&amp;b=2">'),
        "https://x.com/post/1",
      ),
    ).toBe("https://x.com/p.jpg?a=1&b=2");
  });

  it("is null without a picture or with an address that is not http(s)", () => {
    expect(imageUrlFromHtml(html("<title>x</title>"), "https://x.com")).toBeNull();
    expect(
      imageUrlFromHtml(
        html('<meta property="og:image" content="javascript:alert(1)">'),
        "https://x.com",
      ),
    ).toBeNull();
  });
});

describe("isSocialLink", () => {
  it("knows the networks that keep their pictures to themselves", () => {
    expect(isSocialLink("https://www.instagram.com/p/abc/")).toBe(true);
    expect(isSocialLink("https://l.facebook.com/x")).toBe(true);
    expect(isSocialLink("https://example.com/post")).toBe(false);
    expect(isSocialLink("not a url")).toBe(false);
  });
});
