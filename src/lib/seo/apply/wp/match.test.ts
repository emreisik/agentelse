import { describe, expect, it } from "vitest";

import { matchWpObject, slugOfUrl } from "./match";
import { wpObjectFixture } from "./test-support";

// Bu dosyanın kanıtladığı: sondaki eğik çizgi, www ikizi, büyük/küçük harf ve sorgu
// dizesi eşleşmeyi bozmaz; bir, çok ve hiç sonuç ayrı döner; düz kalıcı bağlantıda
// ("/?p=12") sorgu ayırt edicidir.

describe("slugOfUrl", () => {
  it("takes the last path segment", () => {
    expect(slugOfUrl("https://example.com/blog/yerel-seo/")).toBe("yerel-seo");
    expect(slugOfUrl("https://example.com/yerel-seo?utm_source=x")).toBe("yerel-seo");
    expect(slugOfUrl("https://example.com/Yerel-SEO")).toBe("yerel-seo");
  });

  it("keeps percent-encoding", () => {
    expect(slugOfUrl("https://example.com/k%C3%BC%C3%A7%C3%BCk")).toBe("k%c3%bc%c3%a7%c3%bck");
  });

  it("is null for the homepage and invalid input", () => {
    expect(slugOfUrl("https://example.com/")).toBeNull();
    expect(slugOfUrl("https://example.com/?p=12")).toBeNull();
    expect(slugOfUrl("not a url")).toBeNull();
  });
});

describe("matchWpObject", () => {
  const post = wpObjectFixture({ id: 1, link: "https://example.com/blog/yerel-seo/" });
  const other = wpObjectFixture({ id: 2, link: "https://example.com/blog/baska/" });

  it("matches one object ignoring trailing slash, www and query", () => {
    for (const url of [
      "https://example.com/blog/yerel-seo/",
      "https://example.com/blog/yerel-seo",
      "https://www.example.com/blog/yerel-seo/",
      "https://example.com/blog/yerel-seo/?ref=newsletter",
      "https://example.com/blog/yerel-seo/?utm_source=x",
      "https://EXAMPLE.com/Blog/Yerel-SEO/",
    ]) {
      expect(matchWpObject([post, other], url)).toEqual({ kind: "one", object: post });
    }
  });

  it("matches when the object link carries www", () => {
    const www = wpObjectFixture({ id: 3, link: "https://www.example.com/hakkimizda/", type: "page" });
    expect(matchWpObject([www], "https://example.com/hakkimizda/")).toEqual({
      kind: "one",
      object: www,
    });
  });

  it("returns none for an unrelated path, host or invalid url", () => {
    expect(matchWpObject([post, other], "https://example.com/blog/yok/")).toEqual({ kind: "none" });
    expect(matchWpObject([post], "https://evil.com/blog/yerel-seo/")).toEqual({ kind: "none" });
    expect(matchWpObject([post], "nonsense")).toEqual({ kind: "none" });
    expect(matchWpObject([], "https://example.com/blog/yerel-seo/")).toEqual({ kind: "none" });
  });

  it("returns many when two different objects share the address", () => {
    const page = wpObjectFixture({ id: 9, type: "page", link: "https://example.com/blog/yerel-seo/" });
    expect(matchWpObject([post, page], "https://example.com/blog/yerel-seo/")).toEqual({ kind: "many" });
  });

  it("treats the same object listed twice as one", () => {
    expect(matchWpObject([post, post], "https://example.com/blog/yerel-seo/")).toEqual({
      kind: "one",
      object: post,
    });
  });

  it("separates plain permalinks by their query", () => {
    const a = wpObjectFixture({ id: 5, link: "https://example.com/?p=5" });
    const b = wpObjectFixture({ id: 6, link: "https://example.com/?p=6" });
    expect(matchWpObject([a, b], "https://example.com/?p=6")).toEqual({ kind: "one", object: b });
  });
});
