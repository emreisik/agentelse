import { describe, expect, it } from "vitest";

import noindex from "@/server/integrations/search-console/__fixtures__/url-inspection-noindex.json";
import notIndexed from "@/server/integrations/search-console/__fixtures__/url-inspection-not-indexed.json";
import pass from "@/server/integrations/search-console/__fixtures__/url-inspection-pass.json";

import {
  isCrawledNotIndexed,
  isIndexedVerdict,
  parseInspectionResult,
  richResultErrorCount,
  verdictLabel,
} from "./inspection";

// Bu dosyanın kanıtladığı: UrlInspectionResult fixture'ları (resmî biçim)
// doğru okunur, eksik alanlar null olur, "crawled - currently not indexed"
// yazım biçimleri tanınır ve karar etiketleri UI metnine çevrilir.

describe("parseInspectionResult", () => {
  it("parses an indexed page with rich results", () => {
    const parsed = parseInspectionResult(pass);
    expect(parsed).toMatchObject({
      verdict: "PASS",
      coverageState: "Submitted and indexed",
      indexingState: "INDEXING_ALLOWED",
      robotsTxtState: "ALLOWED",
      pageFetchState: "SUCCESSFUL",
      googleCanonical: "https://www.example.com/blog/post-1",
      userCanonical: "https://www.example.com/blog/post-1",
      crawledAs: "MOBILE",
      sitemaps: ["https://www.example.com/sitemap.xml"],
    });
    expect(parsed.lastCrawlTime?.toISOString()).toBe(
      "2026-10-03T07:41:12.000Z",
    );
    // En çok 5 yönlendiren adres saklanır.
    expect(parsed.referringUrls).toHaveLength(5);
    expect(parsed.richResults).toEqual({
      verdict: "PASS",
      items: [
        { type: "Article", issues: [] },
        {
          type: "Breadcrumbs",
          issues: [
            {
              severity: "WARNING",
              message: 'Missing field "item" (in "itemListElement")',
            },
          ],
        },
      ],
    });
    expect(richResultErrorCount(parsed.richResults)).toBe(0);
  });

  it("parses a noindex page", () => {
    const parsed = parseInspectionResult(noindex);
    expect(parsed.verdict).toBe("NEUTRAL");
    expect(parsed.indexingState).toBe("BLOCKED_BY_META_TAG");
    expect(parsed.coverageState).toBe("Excluded by 'noindex' tag");
    expect(parsed.googleCanonical).toBeNull();
    expect(parsed.richResults).toBeNull();
  });

  it("parses a crawled but not indexed page with a rich result error", () => {
    const parsed = parseInspectionResult(notIndexed);
    expect(isCrawledNotIndexed(parsed.coverageState)).toBe(true);
    expect(richResultErrorCount(parsed.richResults)).toBe(1);
  });

  it("accepts the bare inspectionResult object", () => {
    expect(parseInspectionResult(pass.inspectionResult).verdict).toBe("PASS");
  });

  it("returns nulls for missing or malformed fields", () => {
    for (const raw of [
      null,
      undefined,
      42,
      "x",
      [],
      {},
      { inspectionResult: {} },
    ]) {
      expect(parseInspectionResult(raw)).toEqual({
        verdict: null,
        coverageState: null,
        indexingState: null,
        robotsTxtState: null,
        pageFetchState: null,
        googleCanonical: null,
        userCanonical: null,
        lastCrawlTime: null,
        crawledAs: null,
        sitemaps: [],
        referringUrls: [],
        richResults: null,
      });
    }
    const odd = parseInspectionResult({
      inspectionResult: {
        indexStatusResult: {
          verdict: "SOMETHING_NEW",
          lastCrawlTime: "not a date",
          sitemap: "not a list",
        },
      },
    });
    expect(odd.verdict).toBe("VERDICT_UNSPECIFIED");
    expect(odd.lastCrawlTime).toBeNull();
    expect(odd.sitemaps).toEqual([]);
  });
});

describe("isCrawledNotIndexed", () => {
  it("matches hyphen, en dash and spacing variants", () => {
    expect(isCrawledNotIndexed("Crawled - currently not indexed")).toBe(true);
    expect(isCrawledNotIndexed("Crawled – currently not indexed")).toBe(true);
    expect(isCrawledNotIndexed("crawled-currently not indexed")).toBe(true);
    expect(isCrawledNotIndexed("Discovered - currently not indexed")).toBe(
      false,
    );
    expect(isCrawledNotIndexed("Submitted and indexed")).toBe(false);
    expect(isCrawledNotIndexed(null)).toBe(false);
  });
});

describe("verdictLabel", () => {
  it("maps verdicts to UI labels", () => {
    expect(verdictLabel("PASS")).toBe("Indexed");
    expect(verdictLabel("PARTIAL")).toBe("Partly indexed");
    expect(verdictLabel("FAIL")).toBe("Not indexed");
    expect(verdictLabel("NEUTRAL")).toBe("Not indexed");
    expect(verdictLabel("VERDICT_UNSPECIFIED")).toBe("Not checked yet");
    expect(verdictLabel(null)).toBe("Not checked yet");
    expect(isIndexedVerdict("PASS")).toBe(true);
    expect(isIndexedVerdict("PARTIAL")).toBe(false);
  });
});
