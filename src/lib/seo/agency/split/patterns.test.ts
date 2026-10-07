import { describe, expect, it } from "vitest";

import { applyTitlePattern, sameSite, validatePattern } from "./patterns";

// Bu dosyanın kanıtladığı: yalnız dört belirteç geçerlidir (en çok üç adet,
// başka süslü parantez yok); boş belirteç ya da fazla uzun sonuç null döner
// (hiç kesilmez); {year} her zaman dolu; sameSite adresi alan adına göre
// (www ve büyük/küçük harf yok sayılarak) denetler.

const CTX = { title: "Blue Widgets", h1: "Widgets", site: "example.com", year: 2026 };

describe("validatePattern", () => {
  it("accepts the four tokens and plain text", () => {
    expect(validatePattern("{title} | {site}", 120)).toBe(true);
    expect(validatePattern("Best {h1} of {year}", 120)).toBe(true);
    expect(validatePattern("Plain text", 120)).toBe(true);
  });

  it("rejects unknown tokens, stray braces, too many tokens and over-length", () => {
    expect(validatePattern("{name}", 120)).toBe(false);
    expect(validatePattern("{title", 120)).toBe(false);
    expect(validatePattern("title}", 120)).toBe(false);
    expect(validatePattern("{title}{h1}{site}{year}", 120)).toBe(false);
    expect(validatePattern("x".repeat(121), 120)).toBe(false);
    expect(validatePattern("", 120)).toBe(false);
  });
});

describe("applyTitlePattern", () => {
  it("fills the tokens including the year", () => {
    expect(applyTitlePattern("{title} | {site} {year}", CTX, 70)).toBe(
      "Blue Widgets | example.com 2026",
    );
  });

  it("returns null when a needed token is empty", () => {
    expect(applyTitlePattern("{title} | {site}", { ...CTX, title: null }, 70)).toBeNull();
    expect(applyTitlePattern("{h1}", { ...CTX, h1: "   " }, 70)).toBeNull();
  });

  it("does not need tokens the pattern does not use", () => {
    expect(applyTitlePattern("Hello {year}", { ...CTX, title: null }, 70)).toBe("Hello 2026");
  });

  it("returns null instead of truncating a long result", () => {
    expect(applyTitlePattern("{title} {title} {title}", { ...CTX, title: "x".repeat(30) }, 70)).toBeNull();
  });

  it("returns null for an invalid pattern", () => {
    expect(applyTitlePattern("{nope}", CTX, 70)).toBeNull();
  });
});

describe("sameSite", () => {
  const hosts = ["www.Example.com"];

  it("ignores www and letter case", () => {
    expect(sameSite("https://example.com/a", hosts)).toBe(true);
    expect(sameSite("HTTPS://WWW.EXAMPLE.COM/a", hosts)).toBe(true);
  });

  it("refuses another host, a subdomain and non-http URLs", () => {
    expect(sameSite("https://other.com/a", hosts)).toBe(false);
    expect(sameSite("https://blog.example.com/a", hosts)).toBe(false);
    expect(sameSite("ftp://example.com/a", hosts)).toBe(false);
    expect(sameSite("not a url", hosts)).toBe(false);
    expect(sameSite("https://example.com", [])).toBe(false);
  });
});
