import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import sitemapsList from "./__fixtures__/sitemaps-list.json";
import { SEARCH_CONSOLE_BASE } from "./search-analytics";
import * as sitemaps from "./sitemaps";

// Bu dosyanın kanıtladığı: sitemaps.list yanıtı okunur (int64 dizgileri
// sayıya çevrilir), mock modunda fetch çağrılmaz ve modül yalnız okuma
// yapar: gönderme/silme işlevi yoktur (SK10).

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

describe("listSearchConsoleSitemaps", () => {
  it("parses the fixture and string numbers", async () => {
    fetchMock.mockResolvedValueOnce(json(200, sitemapsList));
    const list = await sitemaps.listSearchConsoleSitemaps(
      "token-1",
      "sc-domain:example.com",
    );
    expect(list).toEqual([
      {
        path: "https://www.example.com/sitemap.xml",
        type: "sitemap",
        isIndex: true,
        isPending: false,
        lastSubmitted: "2026-08-14T09:12:44.512Z",
        lastDownloaded: "2026-10-05T03:41:10.007Z",
        errors: 0,
        warnings: 0,
        contents: [
          { type: "web", submitted: 318 },
          { type: "image", submitted: 96 },
        ],
      },
      {
        path: "https://www.example.com/news-sitemap.xml",
        type: null,
        isIndex: false,
        isPending: true,
        lastSubmitted: "2026-09-30T12:00:00.000Z",
        lastDownloaded: "2026-09-30T12:05:00.000Z",
        errors: 1,
        warnings: 2,
        contents: [{ type: "news", submitted: 12 }],
      },
    ]);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(
      `${SEARCH_CONSOLE_BASE}/sites/sc-domain%3Aexample.com/sitemaps`,
    );
    expect(init.method).toBeUndefined();
  });

  it("returns an empty list for an empty or malformed response", async () => {
    fetchMock.mockResolvedValueOnce(json(200, {}));
    expect(
      await sitemaps.listSearchConsoleSitemaps("token-1", "sc-domain:x.com"),
    ).toEqual([]);
    fetchMock.mockResolvedValueOnce(json(200, { sitemap: [{}, "junk"] }));
    expect(
      await sitemaps.listSearchConsoleSitemaps("token-1", "sc-domain:x.com"),
    ).toEqual([]);
  });

  it("uses the mock without fetch", async () => {
    vi.stubEnv("AGENTELSE_PROVIDER_MODE", "mock");
    const list = await sitemaps.listSearchConsoleSitemaps(
      "mock-access-token",
      "sc-domain:example.com",
    );
    expect(list).toHaveLength(1);
    expect(list[0]!.path).toBe("https://www.example.com/sitemap.xml");
    expect(list[0]!.contents).toEqual([{ type: "web", submitted: 42 }]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("exports no write function", () => {
    expect(
      Object.keys(sitemaps).filter(
        (name) =>
          typeof (sitemaps as Record<string, unknown>)[name] === "function",
      ),
    ).toEqual(["listSearchConsoleSitemaps"]);
  });
});
