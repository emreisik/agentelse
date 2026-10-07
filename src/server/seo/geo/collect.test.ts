import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { GuardedTransport } from "@/server/security/guarded-transport";
import {
  mockSiteTransport,
  type MockPageOverride,
  type MockRequestLog,
} from "@/server/seo/crawl/mock-site";
import { createHostPacer } from "@/server/seo/crawl/pacer";

// Bu dosyanın kanıtladığı (SC-F8 GEO girdisi): tam iki GET (/llms.txt ve ana
// sayfa), ikisi de saklı robots.txt'e bağlı (engelliyse taşıyıcıya hiç gidilmez
// ve durum "blocked"); getirme hatası "unknown" olur ve fırlatmaz; mock site
// belirleyicidir (llms.txt 404 = missing); kapsam anahtarı scope.key'den gelir;
// izin listesi dışı, site yok ve tarama yok nedenleri.

const mocks = vi.hoisted(() => ({
  readState: vi.fn(),
  pages: vi.fn(),
  brand: vi.fn(),
  project: vi.fn(),
  accounts: vi.fn(),
}));

vi.mock("@/server/seo/site/sites", () => ({
  SeoSites: { readState: mocks.readState },
}));
vi.mock("@/lib/prisma", () => ({
  prisma: {
    seoPage: { findMany: mocks.pages },
    brand: { findFirst: mocks.brand },
    project: { findUnique: mocks.project },
    socialAccount: { findMany: mocks.accounts },
  },
}));

import { collectGeoInput } from "./collect";

const SCOPE = {
  kind: "VERIFIED_DOMAIN" as const,
  root: "shop.com",
  prefix: null,
  key: "VERIFIED_DOMAIN:shop.com:",
};
const NOW = new Date("2026-10-07T10:00:00.000Z");

function state(robots: { verdict: string | null; body: string | null }) {
  return {
    siteId: "site-1",
    projectId: "p1",
    isMock: true,
    scope: SCOPE,
    origin: "https://shop.com",
    robots: { ...robots, status: 200, failures: 0, fetchedAt: null, changedAt: null, prevBody: null },
  };
}

function setup(overrides?: Readonly<Record<string, MockPageOverride>>) {
  let clock = 1_000_000;
  const log: MockRequestLog = [];
  const now = () => clock;
  return {
    log,
    deps: {
      transport: mockSiteTransport({
        log,
        now,
        ...(overrides ? { overrides } : {}),
      }),
      pacer: createHostPacer({
        now,
        sleep: async (ms: number) => {
          clock += ms;
        },
      }),
    },
  };
}

const PAGE = {
  path: "/pricing",
  wordCount: 420,
  schemaTypes: ["Product"],
  headings: { h1: ["Pricing"], h2: ["How much does it cost?", 7] },
  robotsMeta: null,
  xRobotsTag: null,
  indexable: true,
  status: 200,
};

beforeEach(() => {
  mocks.readState.mockReset().mockResolvedValue(state({ verdict: "MISSING", body: null }));
  mocks.pages.mockReset().mockResolvedValue([PAGE]);
  mocks.brand.mockReset().mockResolvedValue({ name: "Mock Studio" });
  mocks.project.mockReset().mockResolvedValue({ name: "Project name" });
  mocks.accounts.mockReset().mockResolvedValue([{ username: "@MockStudio" }]);
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("collectGeoInput", () => {
  it("collects pages, brand, handles and the two live reads (mock site)", async () => {
    const { deps, log } = setup();
    const result = await collectGeoInput("p1", { fetchDeps: deps, now: NOW });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.siteId).toBe("site-1");
    expect(result.scopeKey).toBe(SCOPE.key);
    expect(result.isMock).toBe(true);
    const { input } = result;
    expect(input.now).toBe(NOW);
    expect(input.llms).toEqual({ state: "missing", text: null });
    expect(input.home).toMatchObject({
      status: 200,
      renderRisk: false,
      title: "Mock Studio – Social media for small brands",
      org: { present: false },
    });
    expect(input.pages).toEqual([
      {
        path: "/pricing",
        wordCount: 420,
        schemaTypes: ["Product"],
        h2: ["How much does it cost?"],
        robotsMeta: null,
        xRobotsTag: null,
        indexable: true,
        status: 200,
      },
    ]);
    expect(input.brandName).toBe("Mock Studio");
    expect(input.connectedHandles).toEqual(["mockstudio"]);
    expect(input.acknowledged).toEqual([]);
    expect(input.robots).toBeNull();
    expect(input.robotsVerdict).toBe("MISSING");
    // Tam iki GET, sırayla.
    expect(log.map((entry) => new URL(entry.url).pathname)).toEqual([
      "/llms.txt",
      "/",
    ]);
  });

  it("selects at most 300 pages ordered by inlinks and uses only needed columns", async () => {
    const { deps } = setup();
    await collectGeoInput("p1", { fetchDeps: deps, now: NOW });
    const query = mocks.pages.mock.calls[0]![0];
    expect(query.take).toBe(300);
    expect(query.where).toMatchObject({ siteId: "site-1", status: 200, goneAt: null });
    expect(query.orderBy[0]).toEqual({ inlinks: "desc" });
    expect(Object.keys(query.select).sort()).toEqual(
      ["headings", "indexable", "path", "robotsMeta", "schemaTypes", "status", "wordCount", "xRobotsTag"].sort(),
    );
  });

  it("is deterministic with the mock transport", async () => {
    const first = await collectGeoInput("p1", { fetchDeps: setup().deps, now: NOW });
    const second = await collectGeoInput("p1", { fetchDeps: setup().deps, now: NOW });
    expect(JSON.stringify(first)).toBe(JSON.stringify(second));
  });

  it("reads a present llms.txt and the homepage organization", async () => {
    const { deps } = setup({
      "/llms.txt": {
        status: 200,
        html: "# Shop\n\n- [Pricing](https://shop.com/pricing)\n",
        headers: { "content-type": "text/plain; charset=utf-8" },
      },
      "/": {
        html: `<html><head><title>Shop | Things</title><script type="application/ld+json">{"@type":"Organization","name":"Shop","sameAs":["https://twitter.com/shop"]}</script></head><body><h1>Shop</h1></body></html>`,
      },
    });
    const result = await collectGeoInput("p1", { fetchDeps: deps, now: NOW });
    if (!result.ok) throw new Error("expected ok");
    expect(result.input.llms.state).toBe("present");
    expect(result.input.llms.text).toContain("# Shop");
    expect(result.input.home?.org).toMatchObject({
      present: true,
      name: "Shop",
      sameAs: ["https://twitter.com/shop"],
    });
    expect(result.input.home?.schemaTypes).toContain("Organization");
  });

  it("does not call the transport for /llms.txt when robots blocks it", async () => {
    mocks.readState.mockResolvedValue(
      state({
        verdict: "OK",
        body: "User-agent: AgentelseSiteAudit\nDisallow: /llms.txt\n",
      }),
    );
    const { deps, log } = setup();
    const result = await collectGeoInput("p1", { fetchDeps: deps, now: NOW });
    if (!result.ok) throw new Error("expected ok");
    expect(result.input.llms).toEqual({ state: "blocked", text: null });
    expect(result.input.home?.status).toBe(200);
    expect(log.map((entry) => new URL(entry.url).pathname)).toEqual(["/"]);
  });

  it("makes no request at all when robots blocks the whole site", async () => {
    mocks.readState.mockResolvedValue(
      state({ verdict: "OK", body: "User-agent: *\nDisallow: /\n" }),
    );
    const { deps, log } = setup();
    const result = await collectGeoInput("p1", { fetchDeps: deps, now: NOW });
    if (!result.ok) throw new Error("expected ok");
    expect(result.input.llms.state).toBe("blocked");
    expect(result.input.home).toBeNull();
    expect(log).toHaveLength(0);
  });

  it("fetches nothing when robots.txt itself could not be read", async () => {
    for (const verdict of ["SERVER_ERROR", "UNREACHABLE", null]) {
      mocks.readState.mockResolvedValue(state({ verdict, body: null }));
      const { deps, log } = setup();
      const result = await collectGeoInput("p1", { fetchDeps: deps, now: NOW });
      if (!result.ok) throw new Error("expected ok");
      expect(result.input.llms.state).toBe("unknown");
      expect(result.input.home).toBeNull();
      expect(log).toHaveLength(0);
    }
  });

  it("turns a fetch failure into unknown without throwing", async () => {
    const failing: GuardedTransport = async () => {
      throw new Error("socket hang up");
    };
    const { deps } = setup();
    const result = await collectGeoInput("p1", {
      fetchDeps: { transport: failing, pacer: deps.pacer },
      now: NOW,
    });
    if (!result.ok) throw new Error("expected ok");
    expect(result.input.llms).toEqual({ state: "unknown", text: null });
    expect(result.input.home).toBeNull();
  });

  it("treats server errors as unknown and keeps a 404 homepage as data", async () => {
    const { deps } = setup({
      "/llms.txt": { status: 503, html: "down" },
      "/": { status: 404, html: "<html></html>" },
    });
    const result = await collectGeoInput("p1", { fetchDeps: deps, now: NOW });
    if (!result.ok) throw new Error("expected ok");
    expect(result.input.llms.state).toBe("unknown");
    expect(result.input.home).toEqual({
      status: 404,
      schemaTypes: [],
      renderRisk: false,
      title: null,
      org: null,
    });
  });

  it("falls back to the project name without a default brand", async () => {
    mocks.brand.mockResolvedValue(null);
    const result = await collectGeoInput("p1", { fetchDeps: setup().deps, now: NOW });
    if (!result.ok) throw new Error("expected ok");
    expect(result.input.brandName).toBe("Project name");
  });
});

describe("collectGeoInput refusals", () => {
  it("refuses a project outside the allow list before any query", async () => {
    vi.stubEnv("SEO_ROLLOUT_PROJECTS", "someone-else");
    expect(await collectGeoInput("p1")).toEqual({ ok: false, reason: "not_allowed" });
    expect(mocks.readState).not.toHaveBeenCalled();
  });

  it("reports no site when there is no state or no scope", async () => {
    mocks.readState.mockResolvedValueOnce(null);
    expect(await collectGeoInput("p1")).toEqual({ ok: false, reason: "no_site" });
    mocks.readState.mockResolvedValueOnce({ ...state({ verdict: "OK", body: null }), scope: null });
    expect(await collectGeoInput("p1")).toEqual({ ok: false, reason: "no_site" });
  });

  it("waits for crawl data: no pages or no origin", async () => {
    mocks.pages.mockResolvedValueOnce([]);
    expect(await collectGeoInput("p1")).toEqual({ ok: false, reason: "no_crawl" });
    mocks.readState.mockResolvedValueOnce({ ...state({ verdict: "OK", body: null }), origin: null });
    expect(await collectGeoInput("p1")).toEqual({ ok: false, reason: "no_crawl" });
  });
});
