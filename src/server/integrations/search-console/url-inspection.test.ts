import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { GoogleApiError } from "@/server/integrations/google/errors";

import pass from "./__fixtures__/url-inspection-pass.json";
import quota from "./__fixtures__/url-inspection-quota.json";
import { gscQuotaKind } from "./errors";
import { mockUrlInspection } from "./inspection-mock";
import { inspectUrl, URL_INSPECTION_ENDPOINT } from "./url-inspection";

// Bu dosyanın kanıtladığı: istek doğru uca, Bearer token ve doğru gövdeyle
// POST edilir; yanıt ayrıştırılır; 429 tekrar edilmeden GoogleApiError
// olarak düşer (günlük kota QUOTA_DAILY, dakikalık RATE_LIMIT); mock
// modunda fetch hiç çağrılmaz ve yanıt URL'ye göre deterministiktir.

const fetchMock = vi.fn();

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
  vi.stubEnv("AGENTELSE_PROVIDER_MODE", "");
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("inspectUrl", () => {
  it("posts the inspection request and parses the result", async () => {
    fetchMock.mockResolvedValueOnce(json(200, pass));
    const result = await inspectUrl(
      "token-1",
      "sc-domain:example.com",
      "https://www.example.com/blog/post-1",
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(URL_INSPECTION_ENDPOINT);
    expect(init.method).toBe("POST");
    expect(init.headers).toMatchObject({
      Authorization: "Bearer token-1",
      "Content-Type": "application/json",
    });
    expect(JSON.parse(String(init.body))).toEqual({
      inspectionUrl: "https://www.example.com/blog/post-1",
      siteUrl: "sc-domain:example.com",
      languageCode: "en-US",
    });
    expect(result.verdict).toBe("PASS");
    expect(result.coverageState).toBe("Submitted and indexed");
  });

  it("throws a daily quota error on 429 without retrying", async () => {
    fetchMock.mockResolvedValue(json(429, quota));
    const error = await inspectUrl(
      "token-1",
      "sc-domain:example.com",
      "https://www.example.com/",
    ).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(GoogleApiError);
    expect((error as GoogleApiError).errorClass).toBe("QUOTA_DAILY");
    expect(gscQuotaKind(error)).toBe("DAILY");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("classifies a per-minute 429 as RATE_LIMIT", async () => {
    fetchMock.mockResolvedValue(
      json(429, {
        error: {
          code: 429,
          message:
            "Quota exceeded for quota metric 'Inspection requests' and limit 'Inspection requests per minute per site'.",
          status: "RESOURCE_EXHAUSTED",
        },
      }),
    );
    const error = await inspectUrl(
      "token-1",
      "sc-domain:example.com",
      "https://www.example.com/",
    ).catch((caught: unknown) => caught);
    expect((error as GoogleApiError).errorClass).toBe("RATE_LIMIT");
    expect(gscQuotaKind(error)).toBe("RATE");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("never calls fetch in mock mode", async () => {
    vi.stubEnv("AGENTELSE_PROVIDER_MODE", "mock");
    const home = await inspectUrl(
      "mock-access-token",
      "sc-domain:example.com",
      "https://www.example.com/",
    );
    const noindex = await inspectUrl(
      "mock-access-token",
      "sc-domain:example.com",
      "https://www.example.com/noindex-page",
    );
    const missing = await inspectUrl(
      "mock-access-token",
      "sc-domain:example.com",
      "https://www.example.com/missing",
    );
    const dup = await inspectUrl(
      "mock-access-token",
      "sc-domain:example.com",
      "https://www.example.com/dup-b",
    );
    expect(fetchMock).not.toHaveBeenCalled();
    expect(home).toMatchObject({
      verdict: "PASS",
      coverageState: "Submitted and indexed",
    });
    expect(noindex).toMatchObject({
      verdict: "NEUTRAL",
      indexingState: "BLOCKED_BY_META_TAG",
      coverageState: "Excluded by 'noindex' tag",
    });
    expect(missing).toMatchObject({
      verdict: "FAIL",
      coverageState: "Not found (404)",
    });
    expect(dup.googleCanonical).toBe("https://www.example.com/dup-a");
  });
});

describe("mockUrlInspection", () => {
  const now = new Date("2026-10-06T12:00:00.000Z");

  it("is deterministic and mostly indexed", () => {
    const urls = Array.from(
      { length: 200 },
      (_, i) => `https://www.example.com/page-${i}`,
    );
    const first = urls.map((url) =>
      mockUrlInspection("sc-domain:example.com", url, now),
    );
    const second = urls.map((url) =>
      mockUrlInspection("sc-domain:example.com", url, now),
    );
    expect(second).toEqual(first);
    const states = first.map(
      (raw) =>
        (
          raw as {
            inspectionResult: { indexStatusResult: { verdict: string } };
          }
        ).inspectionResult.indexStatusResult.verdict,
    );
    const share = states.filter((verdict) => verdict === "PASS").length / 200;
    expect(share).toBeGreaterThan(0.65);
    expect(share).toBeLessThan(0.95);
  });

  it("adds an Article rich result to blog posts and an error to one post", () => {
    const post1 = mockUrlInspection(
      "sc-domain:example.com",
      "https://www.example.com/blog/post-1",
      now,
    ) as { inspectionResult: { richResultsResult?: { verdict: string } } };
    const post3 = mockUrlInspection(
      "sc-domain:example.com",
      "https://www.example.com/blog/post-3",
      now,
    ) as { inspectionResult: { richResultsResult?: { verdict: string } } };
    const pricing = mockUrlInspection(
      "sc-domain:example.com",
      "https://www.example.com/pricing",
      now,
    ) as { inspectionResult: { richResultsResult?: unknown } };
    expect(post1.inspectionResult.richResultsResult?.verdict).toBe("PASS");
    expect(post3.inspectionResult.richResultsResult?.verdict).toBe("FAIL");
    expect(pricing.inspectionResult.richResultsResult).toBeUndefined();
  });
});
