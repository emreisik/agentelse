import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { totalsRequest } from "@/lib/seo/catalog";
import {
  fetchSearchConsoleQueryRows,
  fetchSearchConsoleReport,
  fetchSearchConsoleSiteList,
  listSearchConsoleSites,
} from "@/server/integrations/google-client";
import { GOOGLE_IDENTITY_SCOPE, googleScopesFor } from "@/server/integrations/google/services";

import {
  querySearchAnalytics,
  querySearchAnalyticsPaged,
  SEARCH_CONSOLE_BASE,
} from "./search-analytics";
import { listSearchConsoleSitemaps } from "./sitemaps";
import { getSearchConsoleSite, listSearchConsoleSiteInfos } from "./sites";
import { inspectUrl, URL_INSPECTION_ENDPOINT } from "./url-inspection";

// Bu dosyanın kanıtladığı (SC-F8 kararı "Search Console salt okunur kalır",
// SK10): Agentelse kullanıcının Search Console'unda hiçbir şeyi değiştirmez.
// (a) Her dışa açık istemci işlevi gerçek kipte çağrılır ve ağa yalnız izinli
// okuma istekleri gider; (b) kaynakta PUT/DELETE/PATCH ve POST dışı yöntem
// yoktur; (c) istenen izin tam olarak salt okunurdur ve hiçbir kaynakta
// ".readonly" olmayan bir webmasters izni geçmez; (d) searchconsole.googleapis.com
// yalnız izinli dosyalarda anılır. Biri yazma ucu, site haritası gönderimi ya da
// yazma izni eklerse bu dosya kırılır.

const SRC = path.join(process.cwd(), "src");

function listSources(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) {
      if (name === "__fixtures__" || name === "node_modules") continue;
      out.push(...listSources(full));
    } else if (
      /\.(ts|tsx)$/.test(name) &&
      !/\.test\.(ts|tsx)$/.test(name) &&
      !name.includes("test-support") &&
      !name.endsWith(".testkit.ts")
    ) {
      out.push(full);
    }
  }
  return out;
}

const SOURCES = listSources(SRC);
const rel = (file: string): string =>
  path.relative(SRC, file).split(path.sep).join("/");
const read = (file: string): string => readFileSync(file, "utf8");

// Search Console istemcisi: search-console/* ve eski google-client.ts.
const CLIENT_FILES = SOURCES.filter((file) => {
  const name = rel(file);
  return (
    name.startsWith("server/integrations/search-console/") ||
    name === "server/integrations/google-client.ts"
  );
});

const fetchMock = vi.fn();

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

beforeEach(() => {
  fetchMock.mockReset();
  fetchMock.mockImplementation(async () => json({}));
  vi.stubGlobal("fetch", fetchMock);
  vi.stubEnv("AGENTELSE_PROVIDER_MODE", "");
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

const SITE = "https://www.example.com/";
const SITE_ENC = encodeURIComponent(SITE);
const ROOT = "https://searchconsole.googleapis.com";

type Call = { method: string; url: string };

function calls(): Call[] {
  return fetchMock.mock.calls.map((args) => {
    const [url, init] = args as [string, RequestInit | undefined];
    return { method: (init?.method ?? "GET").toUpperCase(), url: String(url) };
  });
}

const ALLOWED: { method: string; url: RegExp }[] = [
  { method: "GET", url: new RegExp(`^${ROOT}/webmasters/v3/sites$`) },
  { method: "GET", url: new RegExp(`^${ROOT}/webmasters/v3/sites/[^/]+$`) },
  {
    method: "GET",
    url: new RegExp(`^${ROOT}/webmasters/v3/sites/[^/]+/sitemaps$`),
  },
  {
    method: "POST",
    url: new RegExp(
      `^${ROOT}/webmasters/v3/sites/[^/]+/searchAnalytics/query$`,
    ),
  },
  { method: "POST", url: new RegExp(`^${ROOT}/v1/urlInspection/index:inspect$`) },
];

describe("Search Console client: requests at run time", () => {
  it("sends only the allow-listed read requests from every exported function", async () => {
    const request = totalsRequest("web", "2026-09-01", "2026-09-28", "final");
    fetchMock.mockImplementation(async () => json({ rows: [] }));

    await getSearchConsoleSite("t", "sc-domain:example.com");
    await listSearchConsoleSiteInfos("t");
    await listSearchConsoleSitemaps("t", SITE);
    await querySearchAnalytics("t", SITE, request);
    await querySearchAnalyticsPaged("t", SITE, request, { maxPages: 2 });
    await inspectUrl("t", SITE, `${SITE}pricing`);
    await listSearchConsoleSites("t");
    await fetchSearchConsoleSiteList("t");
    await fetchSearchConsoleReport("t", SITE, 7);
    await fetchSearchConsoleQueryRows("t", SITE, ["query"], 28, 25);

    const made = calls();
    expect(made.length).toBeGreaterThanOrEqual(10);
    for (const call of made) {
      const allowed = ALLOWED.some(
        (rule) => rule.method === call.method && rule.url.test(call.url),
      );
      expect(allowed, `${call.method} ${call.url}`).toBe(true);
      expect(["GET", "POST"]).toContain(call.method);
    }
    // Aynı uçlar gerçekten kullanıldı (test boş geçmesin).
    expect(
      made.some((call) => call.url === `${SEARCH_CONSOLE_BASE}/sites/${SITE_ENC}/sitemaps`),
    ).toBe(true);
    expect(made.some((call) => call.url === URL_INSPECTION_ENDPOINT)).toBe(true);
  });

  it("never calls the network in mock mode", async () => {
    vi.stubEnv("AGENTELSE_PROVIDER_MODE", "mock");
    const request = totalsRequest("web", "2026-09-01", "2026-09-28", "final");
    await getSearchConsoleSite("t", SITE);
    await listSearchConsoleSiteInfos("t");
    await listSearchConsoleSitemaps("t", SITE);
    await querySearchAnalytics("t", SITE, request);
    await inspectUrl("t", SITE, `${SITE}pricing`);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("Search Console client: source", () => {
  it("scans the client files", () => {
    expect(CLIENT_FILES.length).toBeGreaterThanOrEqual(6);
  });

  it("has no PUT, DELETE or PATCH and no method other than POST", () => {
    for (const file of CLIENT_FILES) {
      const text = read(file);
      expect(text, rel(file)).not.toMatch(/["'`](PUT|DELETE|PATCH)["'`]/);
      const methods = [...text.matchAll(/method\s*:\s*["'`]([A-Za-z]+)["'`]/g)].map(
        (match) => match[1],
      );
      for (const method of methods) {
        expect(method, rel(file)).toBe("POST");
      }
    }
  });

  it("has no sitemap item endpoint (submit or delete) anywhere", () => {
    for (const file of CLIENT_FILES) {
      const text = read(file);
      // Yalnız liste ucu vardır: /sitemaps ve ardından kapanış; öğe yolu yok.
      expect(text, rel(file)).not.toMatch(/\/sitemaps\/(\$\{|[A-Za-z%])/);
      expect(text, rel(file)).not.toMatch(/submitSitemap|deleteSitemap/i);
    }
  });
});

describe("Search Console permission", () => {
  it("asks for exactly the read-only scope and the account email", () => {
    expect(googleScopesFor("search_console")).toEqual([
      "https://www.googleapis.com/auth/webmasters.readonly",
      GOOGLE_IDENTITY_SCOPE,
    ]);
    expect(googleScopesFor("search_console", { edit: true })).toEqual(
      googleScopesFor("search_console"),
    );
  });

  it("never names a webmasters scope without .readonly in any source", () => {
    for (const file of SOURCES) {
      expect(read(file), rel(file)).not.toMatch(
        /auth\/webmasters(?!\.readonly)/,
      );
    }
  });
});

describe("Search Console host", () => {
  const ALLOWED_HOST_FILES = (name: string): boolean =>
    name.startsWith("server/integrations/search-console/") ||
    name === "server/integrations/google-client.ts" ||
    name === "server/integrations/google/services.ts" ||
    name === "lib/seo/health/guides.ts" ||
    name === "app/privacy/page.tsx";

  it("is mentioned only in the allow-listed files", () => {
    const offenders = SOURCES.filter(
      (file) =>
        read(file).includes("searchconsole.googleapis.com") &&
        !ALLOWED_HOST_FILES(rel(file)),
    ).map(rel);
    expect(offenders).toEqual([]);
  });
});
