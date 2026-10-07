import { describe, expect, it } from "vitest";

import { parseWpIndex, parseWpMe, parseWpObject } from "./parse";
import { wpFixtures } from "./test-support";

// Bu dosyanın kanıtladığı: REST dizini, users/me ve edit bağlamlı nesne
// fixture'ları ayrıştırılır; WordPress olmayan JSON null verir; modified'a 'Z'
// eklenir; eksik isteğe bağlı alanlar toleranslıdır.

describe("parseWpObject", () => {
  it("reads a post in edit context", () => {
    const object = parseWpObject(wpFixtures.postEdit, "post");
    expect(object).toMatchObject({
      id: 42,
      type: "post",
      status: "publish",
      slug: "ornek-yazi",
      link: "https://example.com/ornek-yazi/",
      title: "Örnek yazı",
      excerpt: "",
    });
    expect(object?.content).toContain("<!-- wp:paragraph -->");
    expect(object?.meta).toMatchObject({
      _yoast_wpseo_title: "%%title%% %%sep%% %%sitename%%",
    });
  });

  it("appends Z to modified_gmt", () => {
    expect(parseWpObject(wpFixtures.postEdit, "post")?.modified).toBe(
      "2026-09-10T12:30:00Z",
    );
    expect(parseWpObject(wpFixtures.pageEdit, "page")?.modified).toBe(
      "2026-08-20T08:00:00Z",
    );
  });

  it("keeps an existing time zone and falls back to modified", () => {
    const base = { id: 1, status: "publish", link: "https://a.com/x/" };
    expect(
      parseWpObject({ ...base, modified_gmt: "2026-01-01T00:00:00Z" }, "post")
        ?.modified,
    ).toBe("2026-01-01T00:00:00Z");
    expect(
      parseWpObject({ ...base, modified: "2026-01-01T00:00:00" }, "post")
        ?.modified,
    ).toBe("2026-01-01T00:00:00Z");
  });

  it("treats an empty meta array as no meta", () => {
    expect(parseWpObject(wpFixtures.pageEdit, "page")?.meta).toEqual({});
  });

  it("is tolerant of missing optional fields", () => {
    const object = parseWpObject(
      { id: 9, status: "draft", link: "https://a.com/?p=9" },
      "post",
    );
    expect(object).toEqual({
      id: 9,
      type: "post",
      status: "draft",
      link: "https://a.com/?p=9",
      slug: "",
      modified: "",
      title: "",
      excerpt: "",
      content: null,
      meta: {},
    });
  });

  it("falls back to rendered text and nulls protected content", () => {
    const object = parseWpObject(
      {
        id: 3,
        status: "publish",
        link: "https://a.com/x/",
        title: { rendered: "Rendered" },
        content: { rendered: "<p>x</p>", protected: true },
      },
      "page",
    );
    expect(object?.title).toBe("Rendered");
    expect(object?.content).toBeNull();
  });

  it("returns null without id, status or link", () => {
    expect(parseWpObject(null, "post")).toBeNull();
    expect(parseWpObject([], "post")).toBeNull();
    expect(parseWpObject({ status: "publish", link: "x" }, "post")).toBeNull();
    expect(parseWpObject({ id: 1, link: "x" }, "post")).toBeNull();
    expect(parseWpObject({ id: 1, status: "publish" }, "post")).toBeNull();
    expect(
      parseWpObject({ id: "1", status: "publish", link: "x" }, "post"),
    ).toBeNull();
  });
});

describe("parseWpIndex", () => {
  it("reads the Yoast index", () => {
    const index = parseWpIndex(wpFixtures.indexYoast);
    expect(index?.namespaces).toContain("yoast/v1");
    expect(index?.appPasswords).toBe(true);
    expect(index?.url).toBe("https://example.com");
    expect(index?.name).toBe("Örnek Yoast Sitesi");
  });

  it("reads the Rank Math index", () => {
    expect(parseWpIndex(wpFixtures.indexRankMath)?.namespaces).toContain(
      "rankmath/v1",
    );
  });

  it("reports application passwords off", () => {
    expect(parseWpIndex(wpFixtures.indexPlain)?.appPasswords).toBe(false);
  });

  it("returns null for non-WordPress JSON", () => {
    expect(parseWpIndex({ name: "x" })).toBeNull();
    expect(parseWpIndex({ namespaces: "wp/v2" })).toBeNull();
    expect(parseWpIndex({ namespaces: ["oembed/1.0"] })).toBeNull();
    expect(parseWpIndex("<html>")).toBeNull();
    expect(parseWpIndex(null)).toBeNull();
  });
});

describe("parseWpMe", () => {
  it("reads roles and capabilities", () => {
    const me = parseWpMe(wpFixtures.meEditor);
    expect(me?.roles).toEqual(["editor"]);
    expect(me?.capabilities.edit_others_posts).toBe(true);
    expect(me?.name).toBe("Agentelse");
  });

  it("drops non-boolean capability values and tolerates missing fields", () => {
    expect(
      parseWpMe({ id: 4, capabilities: { a: true, b: false, c: "yes" } }),
    ).toEqual({ id: 4, name: null, roles: [], capabilities: { a: true, b: false } });
  });

  it("returns null without an id", () => {
    expect(parseWpMe({ roles: ["editor"] })).toBeNull();
    expect(parseWpMe(undefined)).toBeNull();
  });
});
