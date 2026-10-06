import { describe, expect, it } from "vitest";

import { MAX_SITE_SCAN_PATHS, siteTagTargets } from "./site-targets";

// Bu dosyanın kanıtladığı: geçersiz ya da boş alan adı taramayı kapatır;
// alan adı www'suz ve küçük harfe çevrilir; sorgulu, maskeli, boşluklu ve
// "(not set)" yollar atılır; ana sayfayla birlikte en çok 6 yol; GA akışı
// başka bir sitedeyse ya da bilinmiyorsa yalnız ana sayfa.

describe("siteTagTargets", () => {
  it("returns null for an empty or invalid project domain", () => {
    expect(
      siteTagTargets({ projectDomain: null, landingPaths: ["/a"] }),
    ).toBeNull();
    expect(siteTagTargets({ projectDomain: "", landingPaths: [] })).toBeNull();
    expect(
      siteTagTargets({ projectDomain: "not a domain", landingPaths: [] }),
    ).toBeNull();
    expect(
      siteTagTargets({ projectDomain: "localhost", landingPaths: [] }),
    ).toBeNull();
  });

  it("normalises www and the scheme", () => {
    expect(
      siteTagTargets({
        projectDomain: "https://WWW.Example.com/shop",
        landingPaths: [],
      }),
    ).toEqual({ host: "example.com", paths: ["/"] });
  });

  it("drops unusable paths and keeps unique ones", () => {
    const result = siteTagTargets({
      projectDomain: "example.com",
      streamUri: "https://www.example.com",
      landingPaths: [
        "/",
        "(not set)",
        "/search?q=x",
        "/a#b",
        "/user/[email]",
        "/with space",
        "relative",
        `/${"x".repeat(300)}`,
        "/blog",
        "/blog",
      ],
    });
    expect(result).toEqual({ host: "example.com", paths: ["/", "/blog"] });
  });

  it("checks at most six paths including the home page", () => {
    const result = siteTagTargets({
      projectDomain: "example.com",
      streamUri: "https://www.example.com",
      landingPaths: ["/1", "/2", "/3", "/4", "/5", "/6", "/7"],
    });
    expect(result?.paths).toEqual(["/", "/1", "/2", "/3", "/4", "/5"]);
    expect(result?.paths).toHaveLength(MAX_SITE_SCAN_PATHS);
  });

  it("scans only the home page when the GA stream is on another site", () => {
    for (const streamUri of [
      null,
      undefined,
      "not a url",
      "https://competitor.com",
      "https://shop.example.com",
    ]) {
      expect(
        siteTagTargets({
          projectDomain: "example.com",
          streamUri,
          landingPaths: ["/pricing", "/blog"],
        }),
      ).toEqual({ host: "example.com", paths: ["/"] });
    }
    expect(
      siteTagTargets({
        projectDomain: "www.example.com",
        streamUri: "https://example.com/",
        landingPaths: ["/pricing"],
      }),
    ).toEqual({ host: "example.com", paths: ["/", "/pricing"] });
  });
});
