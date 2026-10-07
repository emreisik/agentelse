import { beforeEach, describe, expect, it, vi } from "vitest";

import { scopeFromVerifiedDomain } from "@/lib/seo/crawl-url";
import { parseRobotsTxt } from "@/lib/seo/robots-parser";
import {
  mockSiteTransport,
  type MockPageOverride,
  type MockRequestLog,
} from "@/server/seo/crawl/mock-site";
import type { SiteFetchDeps } from "@/server/seo/crawl/fetcher";

// Bu dosyanın kanıtladığı: sayfa denetimi kendi tarayıcı yığınımızla çalışır ve
// SeoPage'e asla yazmaz; kapsam dışı adres ve robots Disallow (ya da okunamayan
// robots) taşıyıcıya hiç gitmeden döner; eş alan adındaki (www/apex) hedef
// köken alan adından getirilir; eş alan adına yönlenen istek o alan adının
// robots.txt'ini koşu başına bir kez okur; 404 başarılı bir gözlemdir, taşıyıcı
// hatası FETCH_FAILED'dır; hops yönlendirme adımı sayısıdır; readCrawledPage
// başlık değişimini yalnız previous.title ve lastChangedAt > firstSeenAt ile görür.

const mocks = vi.hoisted(() => ({
  pageFindUnique: vi.fn(),
  pageCreate: vi.fn(),
  pageUpdate: vi.fn(),
  pageUpsert: vi.fn(),
  forProject: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    seoPage: {
      findUnique: mocks.pageFindUnique,
      create: mocks.pageCreate,
      update: mocks.pageUpdate,
      upsert: mocks.pageUpsert,
    },
  },
}));
vi.mock("@/server/seo/site/sites", () => ({
  SeoSites: { forProject: mocks.forProject },
}));

import {
  checkPage,
  pageCheckSite,
  readCrawledPage,
  robotsAllow,
  type PageCheckSite,
} from "./page-check";

const SCOPE = scopeFromVerifiedDomain("example.test")!;

function site(overrides: Partial<PageCheckSite> = {}): PageCheckSite {
  return {
    siteId: "site-1",
    projectId: "project-1",
    scope: SCOPE,
    origin: "https://example.test",
    originHost: "example.test",
    robots: null,
    robotsFailing: false,
    crawlDelayMs: 1000,
    ...overrides,
  };
}

function setup(overrides?: Readonly<Record<string, MockPageOverride>>) {
  const log: MockRequestLog = [];
  const deps: SiteFetchDeps = {
    transport: mockSiteTransport({ log, overrides }),
    pacer: { wait: async () => undefined },
  };
  return { log, deps };
}

const PRICING =
  '<html><head><title>Pricing plans</title><meta name="description" content="All plans"></head><body><h1>Pricing</h1><p>Hello world text</p></body></html>';

beforeEach(() => {
  vi.resetAllMocks();
});

describe("checkPage", () => {
  it("extracts the page facts from the fetched html", async () => {
    const { deps, log } = setup({ "/pricing": { html: PRICING } });
    const result = await checkPage(site(), "https://example.test/pricing", {
      deps,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.page).toMatchObject({
      status: 200,
      title: "Pricing plans",
      metaDescription: "All plans",
      h1: "Pricing",
      hops: 0,
    });
    expect(result.text).toBeNull();
    expect(log).toHaveLength(1);
    expect(log[0]!.headers["user-agent"]).toContain("Agentelse");
  });

  it("returns the readable text only when textChars is given", async () => {
    const { deps } = setup({ "/pricing": { html: PRICING } });
    const result = await checkPage(site(), "https://example.test/pricing", {
      deps,
      textChars: 500,
    });
    expect(result.ok && result.text).toContain("Hello world text");
  });

  it("does not touch the transport for an out-of-scope address", async () => {
    const { deps, log } = setup();
    const result = await checkPage(site(), "https://other.test/page", { deps });
    expect(result).toEqual({ ok: false, reason: "OUT_OF_SCOPE", page: null });
    expect(log).toHaveLength(0);
  });

  it("does not fetch when robots.txt disallows the page", async () => {
    const { deps, log } = setup();
    const result = await checkPage(
      site({ robots: parseRobotsTxt("User-agent: *\nDisallow: /private") }),
      "https://example.test/private/area",
      { deps },
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("ROBOTS");
    expect(result.page?.robotsBlocked).toBe(true);
    expect(log).toHaveLength(0);
  });

  it("does not fetch while the stored robots verdict is failing", async () => {
    const { deps, log } = setup();
    const result = await checkPage(
      site({ robotsFailing: true }),
      "https://example.test/pricing",
      { deps },
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("ROBOTS");
    expect(log).toHaveLength(0);
  });

  it("fetches a twin-host target on the origin host", async () => {
    const { deps, log } = setup({ "/pricing": { html: PRICING } });
    const result = await checkPage(site(), "https://www.example.test/pricing", {
      deps,
    });
    expect(result.ok).toBe(true);
    expect(log.map((entry) => new URL(entry.url).host)).toEqual([
      "example.test",
    ]);
  });

  it("reads the twin's robots.txt once for two checks that share the map", async () => {
    const { deps, log } = setup({
      "/go": {
        status: 301,
        headers: { location: "https://www.example.test/pricing" },
      },
      "/pricing": { html: PRICING },
    });
    const twinRobots = new Map();
    const first = await checkPage(site(), "https://example.test/go", {
      deps,
      twinRobots,
    });
    const second = await checkPage(site(), "https://example.test/go", {
      deps,
      twinRobots,
    });
    expect(first.ok && first.page.hops).toBe(1);
    expect(second.ok).toBe(true);
    const robotsFetches = log.filter((entry) =>
      entry.url.endsWith("/robots.txt"),
    );
    expect(robotsFetches).toHaveLength(1);
    expect(new URL(robotsFetches[0]!.url).host).toBe("www.example.test");
  });

  it("treats a 404 as a successful observation", async () => {
    const { deps } = setup();
    const result = await checkPage(site(), "https://example.test/missing", {
      deps,
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.page.status).toBe(404);
      expect(result.page.title).toBeNull();
    }
  });

  it("reports a transport error as FETCH_FAILED", async () => {
    const result = await checkPage(site(), "https://example.test/pricing", {
      deps: {
        transport: async () => {
          throw new Error("connection reset");
        },
        pacer: { wait: async () => undefined },
      },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("FETCH_FAILED");
      expect(result.page?.fetchError).toBe("NETWORK");
    }
  });

  it("counts redirect steps as hops", async () => {
    const { deps } = setup({
      "/old": { status: 301, headers: { location: "/pricing" } },
      "/pricing": { html: PRICING },
    });
    const result = await checkPage(site(), "https://example.test/old", {
      deps,
    });
    expect(result.ok && result.page.hops).toBe(1);
    expect(result.ok && result.page.finalUrl).toBe(
      "https://example.test/pricing",
    );
  });

  it("never writes a SeoPage", async () => {
    const { deps } = setup({ "/pricing": { html: PRICING } });
    await checkPage(site(), "https://example.test/pricing", { deps });
    expect(mocks.pageCreate).not.toHaveBeenCalled();
    expect(mocks.pageUpdate).not.toHaveBeenCalled();
    expect(mocks.pageUpsert).not.toHaveBeenCalled();
  });
});

describe("robotsAllow", () => {
  it("answers from the stored robots rules", async () => {
    const rules = parseRobotsTxt("User-agent: *\nDisallow: /private");
    expect(
      await robotsAllow(
        site({ robots: rules }),
        "https://example.test/private/x",
      ),
    ).toBe(false);
    expect(
      await robotsAllow(
        site({ robots: rules }),
        "https://example.test/pricing",
      ),
    ).toBe(true);
    expect(
      await robotsAllow(site({ robotsFailing: true }), "https://example.test/"),
    ).toBe(false);
  });
});

describe("pageCheckSite", () => {
  it("builds the site context from the stored scope and robots", async () => {
    mocks.forProject.mockResolvedValue({
      id: "site-1",
      projectId: "project-1",
      origin: "https://example.test",
      scope: { ...SCOPE },
      robotsVerdict: "OK",
      robotsBody: "User-agent: *\nCrawl-delay: 3\nDisallow: /x",
    });
    const result = await pageCheckSite("project-1");
    expect(result).toMatchObject({
      siteId: "site-1",
      originHost: "example.test",
      robotsFailing: false,
      crawlDelayMs: 3000,
    });
    mocks.forProject.mockResolvedValue(null);
    expect(await pageCheckSite("project-1")).toBeNull();
  });
});

describe("readCrawledPage", () => {
  const first = new Date("2026-09-01T00:00:00.000Z");
  const later = new Date("2026-09-20T00:00:00.000Z");

  function row(overrides: Record<string, unknown>) {
    return {
      url: "https://example.test/pricing",
      status: 200,
      title: "New title",
      metaDescription: null,
      h1: "Pricing",
      headings: { h1: ["Pricing"], h2: ["Plans"] },
      canonical: null,
      noindex: false,
      indexable: true,
      wordCount: 500,
      textHash: "hash-b",
      schemaTypes: [],
      schemaErrors: null,
      previous: { title: "Old title" },
      lastCrawledAt: later,
      firstSeenAt: first,
      lastChangedAt: later,
      goneAt: null,
      ...overrides,
    };
  }

  it("sees a title change only through previous.title after the first sighting", async () => {
    mocks.pageFindUnique.mockResolvedValue(row({}));
    const changed = await readCrawledPage(
      "site-1",
      "https://example.test/pricing",
    );
    expect(changed?.crawled.titleChanged).toBe(true);
    expect(changed?.crawled.contentChanged).toBe(true);
    expect(changed?.snapshot).toMatchObject({
      title: "New title",
      h2: ["Plans"],
      source: "CRAWL",
    });
  });

  it("does not call a text-only change a title change", async () => {
    mocks.pageFindUnique.mockResolvedValue(
      row({ previous: { title: "New title" } }),
    );
    const read = await readCrawledPage(
      "site-1",
      "https://example.test/pricing",
    );
    expect(read?.crawled.titleChanged).toBe(false);
    expect(read?.crawled.contentChanged).toBe(true);
  });

  it("ignores the first sighting as a change", async () => {
    mocks.pageFindUnique.mockResolvedValue(row({ lastChangedAt: first }));
    const read = await readCrawledPage(
      "site-1",
      "https://example.test/pricing",
    );
    expect(read?.crawled).toMatchObject({
      titleChanged: false,
      contentChanged: false,
    });
  });

  it("returns null for a gone or unknown page", async () => {
    mocks.pageFindUnique.mockResolvedValue(row({ goneAt: later }));
    expect(
      await readCrawledPage("site-1", "https://example.test/pricing"),
    ).toBeNull();
    mocks.pageFindUnique.mockResolvedValue(null);
    expect(
      await readCrawledPage("site-1", "https://example.test/none"),
    ).toBeNull();
  });
});
