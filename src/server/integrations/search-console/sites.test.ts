import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import siteGet from "./__fixtures__/site-get.json";
import { SEARCH_CONSOLE_BASE } from "./search-analytics";
import {
  getSearchConsoleSite,
  listSearchConsoleSiteInfos,
  propertyTypeOf,
} from "./sites";

// Bu dosyanın kanıtladığı: sites.get/sites.list yanıtları okunur, mülk türü
// siteUrl'den çıkar, doğrulanmamış siteler atlanır ve mock modunda fetch
// hiç çağrılmaz.

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

describe("propertyTypeOf", () => {
  it("tells Domain and URL-prefix properties apart", () => {
    expect(propertyTypeOf("sc-domain:example.com")).toBe("DOMAIN");
    expect(propertyTypeOf("https://www.example.com/")).toBe("URL_PREFIX");
    expect(propertyTypeOf("http://shop.example.com/tr/")).toBe("URL_PREFIX");
  });
});

describe("getSearchConsoleSite", () => {
  it("reads sites.get", async () => {
    fetchMock.mockResolvedValueOnce(json(200, siteGet));
    const site = await getSearchConsoleSite("token-1", "sc-domain:example.com");
    expect(site).toEqual({
      siteUrl: "sc-domain:example.com",
      permissionLevel: "siteOwner",
      propertyType: "DOMAIN",
    });
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`${SEARCH_CONSOLE_BASE}/sites/sc-domain%3Aexample.com`);
    expect(init.headers).toEqual({ Authorization: "Bearer token-1" });
    expect(init.method).toBeUndefined();
  });

  it("falls back to the requested siteUrl and an unknown level", async () => {
    fetchMock.mockResolvedValueOnce(json(200, {}));
    expect(
      await getSearchConsoleSite("token-1", "https://www.example.com/"),
    ).toEqual({
      siteUrl: "https://www.example.com/",
      permissionLevel: "unknown",
      propertyType: "URL_PREFIX",
    });
  });

  it("uses the mock without fetch", async () => {
    vi.stubEnv("AGENTELSE_PROVIDER_MODE", "mock");
    expect(
      await getSearchConsoleSite("mock-access-token", "sc-domain:acme.test"),
    ).toEqual({
      siteUrl: "sc-domain:acme.test",
      permissionLevel: "siteOwner",
      propertyType: "DOMAIN",
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("listSearchConsoleSiteInfos", () => {
  it("skips unverified and malformed entries", async () => {
    fetchMock.mockResolvedValueOnce(
      json(200, {
        siteEntry: [
          { siteUrl: "sc-domain:example.com", permissionLevel: "siteOwner" },
          {
            siteUrl: "https://blog.example.com/",
            permissionLevel: "siteUnverifiedUser",
          },
          {
            siteUrl: "https://www.example.com/",
            permissionLevel: "siteRestrictedUser",
          },
          { permissionLevel: "siteOwner" },
          "junk",
        ],
      }),
    );
    expect(await listSearchConsoleSiteInfos("token-1")).toEqual([
      {
        siteUrl: "sc-domain:example.com",
        permissionLevel: "siteOwner",
        propertyType: "DOMAIN",
      },
      {
        siteUrl: "https://www.example.com/",
        permissionLevel: "siteRestrictedUser",
        propertyType: "URL_PREFIX",
      },
    ]);
    expect(fetchMock.mock.calls[0]![0]).toBe(`${SEARCH_CONSOLE_BASE}/sites`);
  });

  it("returns an empty list when there are no sites", async () => {
    fetchMock.mockResolvedValueOnce(json(200, {}));
    expect(await listSearchConsoleSiteInfos("token-1")).toEqual([]);
  });

  it("uses the mock without fetch", async () => {
    vi.stubEnv("AGENTELSE_PROVIDER_MODE", "mock");
    const sites = await listSearchConsoleSiteInfos("mock-access-token");
    expect(sites.length).toBeGreaterThan(0);
    expect(sites.every((site) => site.permissionLevel === "siteOwner")).toBe(
      true,
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
