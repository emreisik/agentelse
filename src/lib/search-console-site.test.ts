import { describe, expect, it } from "vitest";

import {
  rankSearchConsoleSites,
  searchConsoleSiteCoversDomain,
} from "./search-console-site";

describe("searchConsoleSiteCoversDomain", () => {
  it("a Domain property covers the domain and its subdomains, not a parent", () => {
    expect(
      searchConsoleSiteCoversDomain("sc-domain:example.com", "example.com"),
    ).toBe(true);
    expect(
      searchConsoleSiteCoversDomain(
        "sc-domain:example.com",
        "shop.example.com",
      ),
    ).toBe(true);
    expect(
      searchConsoleSiteCoversDomain(
        "sc-domain:shop.example.com",
        "example.com",
      ),
    ).toBe(false);
    expect(
      searchConsoleSiteCoversDomain("sc-domain:example.org", "example.com"),
    ).toBe(false);
    // "notexample.com" bir alt alan adı değildir.
    expect(
      searchConsoleSiteCoversDomain("sc-domain:example.com", "notexample.com"),
    ).toBe(false);
  });

  it("a URL-prefix property covers only its own host, with or without www", () => {
    expect(
      searchConsoleSiteCoversDomain("https://www.example.com/", "example.com"),
    ).toBe(true);
    expect(
      searchConsoleSiteCoversDomain("http://example.com/blog/", "example.com"),
    ).toBe(true);
    expect(
      searchConsoleSiteCoversDomain("https://shop.example.com/", "example.com"),
    ).toBe(false);
  });

  it("does not warn when it cannot decide", () => {
    expect(searchConsoleSiteCoversDomain("https://example.org/", null)).toBe(
      true,
    );
    expect(searchConsoleSiteCoversDomain("https://example.org/", "")).toBe(
      true,
    );
    expect(searchConsoleSiteCoversDomain("not a url", "example.com")).toBe(
      true,
    );
  });
});

describe("rankSearchConsoleSites", () => {
  const sites = [
    { siteUrl: "https://other.com/" },
    { siteUrl: "https://www.example.com/" },
    { siteUrl: "sc-domain:other.com" },
    { siteUrl: "sc-domain:example.com" },
  ];

  it("puts the project's sites first, the Domain property ahead", () => {
    expect(
      rankSearchConsoleSites(sites, "example.com").map((s) => s.siteUrl),
    ).toEqual([
      "sc-domain:example.com",
      "https://www.example.com/",
      "sc-domain:other.com",
      "https://other.com/",
    ]);
  });

  it("without a project website, Domain properties lead and the rest keep their order", () => {
    expect(rankSearchConsoleSites(sites, null).map((s) => s.siteUrl)).toEqual([
      "sc-domain:other.com",
      "sc-domain:example.com",
      "https://other.com/",
      "https://www.example.com/",
    ]);
  });
});
