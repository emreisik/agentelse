// Mock kipte URL Inspection yanıtı (fetch yok). Google'ın UrlInspectionResult
// biçimindedir ve URL'nin FNV özetine göre deterministiktir:
// - ana sayfa: PASS "Submitted and indexed";
// - yolunda "noindex": NEUTRAL, BLOCKED_BY_META_TAG;
// - yolunda "missing": FAIL "Not found (404)";
// - yolunda "dup-b": Google'ın kanoniği …/dup-a;
// - diğerleri: %80 PASS, %15 "Crawled - currently not indexed",
//   %5 "Discovered - currently not indexed" (hiç taranmamış).
// lastCrawlTime = şimdi − (özet % 40) gün. Blog yazıları Article zengin
// sonucu taşır; biri (post-3) ERROR sorunu içerir.

const DAY_MS = 86_400_000;

function fnv1a32(value: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

function pathOf(url: string): string {
  try {
    return new URL(url).pathname;
  } catch {
    return "/";
  }
}

function richResults(path: string): Record<string, unknown> | null {
  if (!/^\/blog\/[^/]+/.test(path)) return null;
  const broken = path.startsWith("/blog/post-3");
  return {
    verdict: broken ? "FAIL" : "PASS",
    detectedItems: [
      {
        richResultType: "Article",
        items: [
          broken
            ? {
                name: "Unnamed item",
                issues: [
                  {
                    issueMessage: 'Missing field "headline"',
                    severity: "ERROR",
                  },
                ],
              }
            : { name: "Unnamed item" },
        ],
      },
    ],
  };
}

export function mockUrlInspection(
  siteUrl: string,
  url: string,
  now: Date = new Date(),
): unknown {
  const hash = fnv1a32(url);
  const path = pathOf(url);
  const crawledAt = new Date(now.getTime() - (hash % 40) * DAY_MS);
  const base = {
    sitemap: siteUrl.startsWith("sc-domain:")
      ? [`https://www.${siteUrl.slice("sc-domain:".length)}/sitemap.xml`]
      : [`${siteUrl.replace(/\/$/, "")}/sitemap.xml`],
    referringUrls: [] as string[],
    robotsTxtState: "ALLOWED",
    crawledAs: "MOBILE",
  };

  let index: Record<string, unknown>;
  if (path === "/") {
    index = {
      ...base,
      verdict: "PASS",
      coverageState: "Submitted and indexed",
      indexingState: "INDEXING_ALLOWED",
      pageFetchState: "SUCCESSFUL",
      lastCrawlTime: crawledAt.toISOString(),
      googleCanonical: url,
      userCanonical: url,
    };
  } else if (path.includes("noindex")) {
    index = {
      ...base,
      verdict: "NEUTRAL",
      coverageState: "Excluded by 'noindex' tag",
      indexingState: "BLOCKED_BY_META_TAG",
      pageFetchState: "SUCCESSFUL",
      lastCrawlTime: crawledAt.toISOString(),
    };
  } else if (path.includes("missing")) {
    index = {
      ...base,
      verdict: "FAIL",
      coverageState: "Not found (404)",
      indexingState: "INDEXING_ALLOWED",
      pageFetchState: "NOT_FOUND",
      lastCrawlTime: crawledAt.toISOString(),
    };
  } else if (path.includes("dup-b")) {
    index = {
      ...base,
      verdict: "NEUTRAL",
      coverageState: "Duplicate, Google chose different canonical than user",
      indexingState: "INDEXING_ALLOWED",
      pageFetchState: "SUCCESSFUL",
      lastCrawlTime: crawledAt.toISOString(),
      googleCanonical: url.replace("dup-b", "dup-a"),
      userCanonical: url,
    };
  } else {
    const bucket = hash % 100;
    if (bucket < 80) {
      index = {
        ...base,
        verdict: "PASS",
        coverageState: "Submitted and indexed",
        indexingState: "INDEXING_ALLOWED",
        pageFetchState: "SUCCESSFUL",
        lastCrawlTime: crawledAt.toISOString(),
        googleCanonical: url,
        userCanonical: url,
      };
    } else if (bucket < 95) {
      index = {
        ...base,
        verdict: "NEUTRAL",
        coverageState: "Crawled - currently not indexed",
        indexingState: "INDEXING_ALLOWED",
        pageFetchState: "SUCCESSFUL",
        lastCrawlTime: crawledAt.toISOString(),
        googleCanonical: url,
        userCanonical: url,
      };
    } else {
      index = {
        ...base,
        verdict: "NEUTRAL",
        coverageState: "Discovered - currently not indexed",
        indexingState: "INDEXING_ALLOWED",
        pageFetchState: "PAGE_FETCH_STATE_UNSPECIFIED",
        crawledAs: undefined,
      };
    }
  }

  const rich = richResults(path);
  return {
    inspectionResult: {
      inspectionResultLink: `https://search.google.com/search-console/inspect?resource_id=${encodeURIComponent(siteUrl)}&id=mock-${hash.toString(16)}`,
      indexStatusResult: index,
      ...(rich ? { richResultsResult: rich } : {}),
    },
  };
}
