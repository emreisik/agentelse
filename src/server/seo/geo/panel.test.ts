import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { parseRobotsTxt } from "@/lib/seo/robots-parser";
import { evaluateGeo, type GeoInput } from "@/lib/seo/geo/evaluate";
import { GEO_CHECKS } from "@/lib/seo/geo/catalog";

// Bu dosyanın kanıtladığı (SC-F8 panel): bayrak kapalıyken ya da proje
// izinsizken veritabanına hiç gidilmez; denetim yoksa "waiting" (tarama var)
// ya da "needs_crawl"; hazırken kontroller katalog metniyle, kayıtlı öneriyle
// ve kabullerle yeniden puanlanmış olarak gelir; kabul düğmesi yalnız yönetici
// ve yalnız GEO2/GEO9 için; llms.txt taslağı yalnız dosya yokken ve ana sayfa
// önde kurulur; trafik hatası paneli düşürmez.

const mocks = vi.hoisted(() => ({
  siteFindUnique: vi.fn(),
  pages: vi.fn(),
  readAudit: vi.fn(),
  isManager: vi.fn(),
  traffic: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    seoSite: { findUnique: mocks.siteFindUnique },
    seoPage: { findMany: mocks.pages },
  },
}));
vi.mock("@/server/security/tenant-context", () => ({
  isWorkspaceManager: mocks.isManager,
}));
vi.mock("./ai-traffic", () => ({ readAiTraffic: mocks.traffic }));
vi.mock("./store", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./store")>()),
  readGeoAudit: mocks.readAudit,
}));

import { loadGeoPanel } from "./panel";

const NOW = new Date();

function input(overrides: Partial<GeoInput> = {}): GeoInput {
  return {
    robots: parseRobotsTxt("User-agent: PerplexityBot\nDisallow: /\n"),
    robotsVerdict: "OK",
    llms: { state: "missing", text: null },
    home: null,
    pages: [],
    brandName: null,
    connectedHandles: [],
    acknowledged: [],
    now: NOW,
    ...overrides,
  };
}

const SITE = {
  id: "site-1",
  workspaceId: "w1",
  scopeKey: "K",
  origin: "https://acme.test",
  lastFullCrawlAt: new Date("2026-10-01T00:00:00Z"),
};

function audit(overrides: Record<string, unknown> = {}) {
  return {
    id: "a1",
    score: 40,
    previousScore: 30,
    auditedAt: new Date(NOW.getTime() - 7 * 3_600_000),
    acknowledged: [],
    recommendations: {
      source: "ai",
      language: "en",
      items: [{ checkId: "GEO2", text: "Let the answer crawlers in." }],
      at: NOW.toISOString(),
    },
    result: evaluateGeo(input()),
    ...overrides,
  };
}

beforeEach(() => {
  vi.stubEnv("SEO_HEALTH", "true");
  vi.stubEnv("SEO_CRAWL", "true");
  vi.stubEnv("SEO_GEO", "true");
  vi.stubEnv("AGENTELSE_PROVIDER_MODE", "mock");
  vi.stubEnv("SEO_DEV_PROJECTS", "");
  vi.stubEnv("SEO_ROLLOUT_PROJECTS", "");
  for (const mock of Object.values(mocks)) mock.mockReset();
  mocks.siteFindUnique.mockResolvedValue(SITE);
  mocks.readAudit.mockResolvedValue(audit());
  mocks.isManager.mockResolvedValue(true);
  mocks.pages.mockResolvedValue([]);
  mocks.traffic.mockResolvedValue(null);
});

afterEach(() => {
  vi.unstubAllEnvs();
});

const USER = { projectId: "p1", userId: "u1" };

describe("loadGeoPanel gates", () => {
  it("returns null without any DB read when the flag is off or the project is not allowed", async () => {
    vi.stubEnv("SEO_GEO", "false");
    expect(await loadGeoPanel(USER)).toBeNull();
    vi.stubEnv("SEO_GEO", "true");
    vi.stubEnv("SEO_ROLLOUT_PROJECTS", "other");
    expect(await loadGeoPanel(USER)).toBeNull();
    expect(mocks.siteFindUnique).not.toHaveBeenCalled();
    expect(mocks.readAudit).not.toHaveBeenCalled();
    expect(mocks.isManager).not.toHaveBeenCalled();
  });
});

describe("loadGeoPanel states", () => {
  it("needs a crawl without a verified site", async () => {
    mocks.siteFindUnique.mockResolvedValue(null);
    expect(await loadGeoPanel(USER)).toMatchObject({ enabled: true, state: "needs_crawl", checks: [] });
    mocks.siteFindUnique.mockResolvedValue({ ...SITE, scopeKey: null });
    expect(await loadGeoPanel(USER)).toMatchObject({ state: "needs_crawl" });
    expect(mocks.readAudit).not.toHaveBeenCalled();
  });

  it("waits when the site is crawled but there is no audit, a stale audit or a placeholder", async () => {
    mocks.readAudit.mockResolvedValue(null);
    expect(await loadGeoPanel(USER)).toMatchObject({ state: "waiting", score: null });
    mocks.readAudit.mockResolvedValue(audit({ result: { v: 0 } }));
    expect(await loadGeoPanel(USER)).toMatchObject({ state: "waiting" });
  });

  it("needs a crawl when the site was never crawled", async () => {
    mocks.readAudit.mockResolvedValue(null);
    mocks.siteFindUnique.mockResolvedValue({ ...SITE, lastFullCrawlAt: null });
    expect(await loadGeoPanel(USER)).toMatchObject({ state: "needs_crawl" });
  });
});

describe("loadGeoPanel ready", () => {
  it("composes checks with catalog text and the stored recommendation", async () => {
    const panel = await loadGeoPanel(USER);
    expect(panel?.state).toBe("ready");
    expect(panel?.previousScore).toBe(30);
    expect(panel?.recommendationSource).toBe("ai");
    const geo2 = panel!.checks.find((check) => check.id === "GEO2")!;
    expect(geo2).toMatchObject({
      status: "WARN",
      title: GEO_CHECKS.GEO2.title,
      why: GEO_CHECKS.GEO2.why,
      how: GEO_CHECKS.GEO2.how,
      recommendation: "Let the answer crawlers in.",
      canAcknowledge: true,
    });
    expect(panel!.checks.find((check) => check.id === "GEO1")?.recommendation).toBeNull();
    expect(panel!.crawlers).toHaveLength(11);
    expect(panel!.auditedAt).toBe(audit().auditedAt.toISOString());
  });

  it("limits the acknowledge button to managers and to GEO2 and GEO9", async () => {
    mocks.readAudit.mockResolvedValue(
      audit({
        result: evaluateGeo(
          input({ pages: [{ path: "/a", wordCount: 10, schemaTypes: [], h2: [], robotsMeta: "nosnippet", xRobotsTag: null, indexable: true, status: 200 }] }),
        ),
      }),
    );
    const manager = await loadGeoPanel(USER);
    expect(manager!.canAcknowledge).toBe(true);
    expect(manager!.checks.filter((check) => check.canAcknowledge).map((check) => check.id)).toEqual(["GEO2", "GEO9"]);
    mocks.isManager.mockResolvedValue(false);
    const member = await loadGeoPanel(USER);
    expect(member!.canAcknowledge).toBe(false);
    expect(member!.checks.some((check) => check.canAcknowledge)).toBe(false);
    expect(mocks.isManager).toHaveBeenLastCalledWith("u1", "w1");
  });

  it("re-applies the stored acknowledgements to status and score", async () => {
    const open = await loadGeoPanel(USER);
    mocks.readAudit.mockResolvedValue(audit({ acknowledged: ["GEO2", "GEO3"] }));
    const acked = await loadGeoPanel(USER);
    const geo2 = acked!.checks.find((check) => check.id === "GEO2")!;
    expect(geo2.status).toBe("ACK");
    expect(geo2.canAcknowledge).toBe(true);
    expect(acked!.checks.find((check) => check.id === "GEO3")!.status).toBe("INFO");
    expect(open!.checks.find((check) => check.id === "GEO2")!.status).toBe("WARN");
    // Tek puanlı kontrol kaldı (GEO1 INFO): puan 50.
    expect(acked!.score).toBe(50);
  });

  it("allows Check again only 6 hours after the last check", async () => {
    expect((await loadGeoPanel(USER))!.canAuditNow).toBe(true);
    mocks.readAudit.mockResolvedValue(audit({ auditedAt: new Date(NOW.getTime() - 2 * 3_600_000) }));
    expect((await loadGeoPanel(USER))!.canAuditNow).toBe(false);
  });

  it("builds the llms.txt draft only when the file is missing, homepage first", async () => {
    mocks.pages.mockResolvedValue([
      { url: "https://acme.test/pricing", title: "Pricing", metaDescription: "Plans" },
      { url: "https://acme.test/", title: "Acme | Widgets for all", metaDescription: "We make widgets." },
    ]);
    const panel = await loadGeoPanel(USER);
    expect(panel!.llms.state).toBe("missing");
    expect(panel!.llms.draft).toBe(
      [
        "# Acme",
        "",
        "> We make widgets.",
        "",
        "## Key pages",
        "",
        "- [Acme | Widgets for all](https://acme.test/): We make widgets.",
        "- [Pricing](https://acme.test/pricing): Plans",
        "",
      ].join("\n"),
    );
    const query = mocks.pages.mock.calls[0]![0];
    expect(query.take).toBe(40);
    expect(query.where).toMatchObject({ siteId: "site-1", indexable: true, goneAt: null });
  });

  it("makes no draft when llms.txt exists", async () => {
    mocks.readAudit.mockResolvedValue(
      audit({ result: evaluateGeo(input({ llms: { state: "present", text: "# Acme\n" } })) }),
    );
    const panel = await loadGeoPanel(USER);
    expect(panel!.llms).toEqual({ state: "present", draft: null });
    expect(mocks.pages).not.toHaveBeenCalled();
  });

  it("passes the traffic through and survives a traffic failure", async () => {
    const traffic = { from: "a", to: "b", sessions: 1, previousSessions: 0, keyEvents: 0, sharePct: 1, assistants: [], domainMatch: "match" };
    mocks.traffic.mockResolvedValue(traffic);
    expect((await loadGeoPanel(USER))!.traffic).toEqual(traffic);
    mocks.traffic.mockRejectedValue(new Error("boom"));
    expect((await loadGeoPanel(USER))!.traffic).toBeNull();
  });
});
