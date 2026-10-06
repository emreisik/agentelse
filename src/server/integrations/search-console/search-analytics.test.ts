import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  brandTotalsRequest,
  periodRequest,
  totalsRequest,
} from "@/lib/seo/catalog";
import { GoogleApiError } from "@/server/integrations/google/errors";

import dateAll from "./__fixtures__/query-date-all.json";
import loadQuota from "./__fixtures__/error-load-quota.json";
import permission from "./__fixtures__/error-permission.json";
import rateLimit from "./__fixtures__/error-rate-limit.json";
import validation from "./__fixtures__/error-validation.json";
import { gscQuotaKind } from "./errors";
import {
  querySearchAnalytics,
  querySearchAnalyticsPaged,
  SEARCH_CONSOLE_BASE,
} from "./search-analytics";

// Bu dosyanın kanıtladığı: istek URL'si ve gövdesi doğru kurulur (sc-domain:
// kodlanır, süzgeç yoksa gönderilmez); sayfalama kısa sayfada ya da
// maxPages'te durur ve kırpılmayı doğru işaretler; beforePage her sayfadan
// önce çağrılır ve fırlatınca durdurur; Google hataları doğru sınıfla
// GoogleApiError olur; mock modunda fetch hiç çağrılmaz.

const fetchMock = vi.fn();

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function rows(count: number, prefix = "q") {
  return Array.from({ length: count }, (_, index) => ({
    keys: [`${prefix}${index}`],
    clicks: 1,
    impressions: 10,
    ctr: 0.1,
    position: 3,
  }));
}

function sentBody(call: number): Record<string, unknown> {
  const init = fetchMock.mock.calls[call]![1] as RequestInit;
  return JSON.parse(String(init.body)) as Record<string, unknown>;
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

describe("querySearchAnalytics", () => {
  it("encodes sc-domain: and sends the request body", async () => {
    fetchMock.mockResolvedValueOnce(json(200, dateAll));
    const request = totalsRequest("web", "2026-09-26", "2026-10-05", "all");
    const response = await querySearchAnalytics(
      "token-1",
      "sc-domain:example.com",
      request,
    );

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(
      `${SEARCH_CONSOLE_BASE}/sites/sc-domain%3Aexample.com/searchAnalytics/query`,
    );
    expect(init.method).toBe("POST");
    expect(init.headers).toEqual({
      Authorization: "Bearer token-1",
      "Content-Type": "application/json",
    });
    const body = sentBody(0);
    expect(body).toEqual({
      startDate: "2026-09-26",
      endDate: "2026-10-05",
      dimensions: ["date"],
      type: "web",
      aggregationType: "byProperty",
      dataState: "all",
      rowLimit: 25_000,
      startRow: 0,
    });
    expect("dimensionFilterGroups" in body).toBe(false);
    expect(response.rows).toHaveLength(10);
    expect(response.firstIncompleteDate).toBe("2026-10-04");
  });

  it("encodes a URL-prefix site and sends the brand filter", async () => {
    fetchMock.mockResolvedValueOnce(json(200, {}));
    await querySearchAnalytics(
      "token-1",
      "https://www.example.com/",
      brandTotalsRequest("(?i)(?:acme)", "2026-07-01", "2026-09-28"),
    );
    const [url] = fetchMock.mock.calls[0] as [string];
    expect(url).toBe(
      `${SEARCH_CONSOLE_BASE}/sites/https%3A%2F%2Fwww.example.com%2F/searchAnalytics/query`,
    );
    expect(sentBody(0).dimensionFilterGroups).toEqual([
      {
        groupType: "and",
        filters: [
          {
            dimension: "query",
            operator: "includingRegex",
            expression: "(?i)(?:acme)",
          },
        ],
      },
    ]);
  });

  it("turns Google error bodies into GoogleApiError with the right class", async () => {
    const request = totalsRequest("web", "2026-09-01", "2026-09-30", "final");
    const cases: [number, unknown, string][] = [
      [429, loadQuota, "RATE_LIMIT"],
      [429, rateLimit, "RATE_LIMIT"],
      [403, permission, "PERMISSION"],
      [400, validation, "VALIDATION"],
    ];
    for (const [status, body, errorClass] of cases) {
      fetchMock.mockResolvedValueOnce(json(status, body));
      const error = await querySearchAnalytics(
        "token-1",
        "sc-domain:example.com",
        request,
      ).catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(GoogleApiError);
      expect((error as GoogleApiError).errorClass).toBe(errorClass);
    }
    // Kota hataları tekrar edilmez: her durum tek çağrı.
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it("the load-quota body reads as LOAD", async () => {
    fetchMock.mockResolvedValueOnce(json(429, loadQuota));
    const error = await querySearchAnalytics(
      "token-1",
      "sc-domain:example.com",
      totalsRequest("web", "2026-09-01", "2026-09-30", "final"),
    ).catch((caught: unknown) => caught);
    expect(gscQuotaKind(error)).toBe("LOAD");
  });

  it("never calls fetch in mock mode", async () => {
    vi.stubEnv("AGENTELSE_PROVIDER_MODE", "mock");
    const response = await querySearchAnalytics(
      "mock-access-token",
      "sc-domain:example.com",
      totalsRequest("web", "2026-01-01", "2026-01-31", "final"),
    );
    expect(fetchMock).not.toHaveBeenCalled();
    expect(response.rows.length).toBe(31);
  });
});

describe("querySearchAnalyticsPaged", () => {
  const request = periodRequest("query", "2026-09-28", "2026-10-04");

  it("pages 25k + 25k + 3 into three requests, not truncated", async () => {
    fetchMock
      .mockResolvedValueOnce(json(200, { rows: rows(25_000, "a") }))
      .mockResolvedValueOnce(json(200, { rows: rows(25_000, "b") }))
      .mockResolvedValueOnce(json(200, { rows: rows(3, "c") }));
    const beforePage = vi.fn();
    const result = await querySearchAnalyticsPaged(
      "token-1",
      "sc-domain:example.com",
      request,
      { maxPages: 4, beforePage },
    );
    expect(result.pages).toBe(3);
    expect(result.rows).toHaveLength(50_003);
    expect(result.truncated).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect([0, 1, 2].map((call) => sentBody(call).startRow)).toEqual([
      0, 25_000, 50_000,
    ]);
    expect(beforePage.mock.calls).toEqual([[0], [1], [2]]);
  });

  it("marks a full last page at maxPages as truncated", async () => {
    fetchMock.mockResolvedValueOnce(json(200, { rows: rows(25_000) }));
    const result = await querySearchAnalyticsPaged(
      "token-1",
      "sc-domain:example.com",
      periodRequest("query_page", "2026-09-28", "2026-10-04"),
      { maxPages: 1 },
    );
    expect(result.pages).toBe(1);
    expect(result.truncated).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("marks hitting Google's 50,000-row cap as truncated", async () => {
    fetchMock
      .mockResolvedValueOnce(json(200, { rows: rows(25_000, "a") }))
      .mockResolvedValueOnce(json(200, { rows: rows(25_000, "b") }))
      .mockResolvedValueOnce(json(200, {}));
    const result = await querySearchAnalyticsPaged(
      "token-1",
      "sc-domain:example.com",
      request,
      { maxPages: 4 },
    );
    expect(result.pages).toBe(3);
    expect(result.rows).toHaveLength(50_000);
    expect(result.truncated).toBe(true);
  });

  it("stops on a short first page and keeps metadata", async () => {
    fetchMock.mockResolvedValueOnce(json(200, dateAll));
    const result = await querySearchAnalyticsPaged(
      "token-1",
      "sc-domain:example.com",
      totalsRequest("web", "2026-09-26", "2026-10-05", "all"),
      { maxPages: 1 },
    );
    expect(result).toMatchObject({
      pages: 1,
      truncated: false,
      firstIncompleteDate: "2026-10-04",
      responseAggregationType: "byProperty",
    });
  });

  it("awaits beforePage before every page and stops when it throws", async () => {
    const order: string[] = [];
    fetchMock.mockImplementation(async () => {
      order.push("fetch");
      return json(200, { rows: rows(25_000) });
    });
    const beforePage = vi.fn(async (index: number) => {
      await Promise.resolve();
      order.push(`before:${index}`);
      if (index === 1) throw new Error("budget spent");
    });
    await expect(
      querySearchAnalyticsPaged("token-1", "sc-domain:example.com", request, {
        maxPages: 4,
        beforePage,
      }),
    ).rejects.toThrow("budget spent");
    expect(order).toEqual(["before:0", "fetch", "before:1"]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("never calls fetch in mock mode", async () => {
    vi.stubEnv("AGENTELSE_PROVIDER_MODE", "mock");
    const result = await querySearchAnalyticsPaged(
      "mock-access-token",
      "sc-domain:example.com",
      { ...periodRequest("query", "2026-01-05", "2026-01-11"), rowLimit: 5 },
      { maxPages: 2 },
    );
    expect(fetchMock).not.toHaveBeenCalled();
    expect(result.pages).toBe(2);
    expect(result.rows).toHaveLength(10);
    expect(result.truncated).toBe(true);
  });
});
