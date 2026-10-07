import { beforeEach, describe, expect, it, vi } from "vitest";

import { GEO_CHECKS } from "@/lib/seo/geo/catalog";
import type { GeoAuditResult, GeoCheckResult } from "@/lib/seo/geo/types";

// Bu dosyanın kanıtladığı (SC-F8 öneri metni): modele giden bağlamda sabit
// başlık/kimlik/durum dışında dize yok; veride olmayan sayıyı anan cümle düşer;
// mock kip ve her hata (bütçe dahil) sabit "how" metnine (template) döner;
// metin projenin içerik diliyle etiketlenir; uyarı yoksa model çağrılmaz.

const mocks = vi.hoisted(() => ({
  isMockMode: vi.fn(),
  run: vi.fn(),
  project: vi.fn(),
}));

vi.mock("@/server/reasoning/reasoning-service", () => ({
  ReasoningService: { isMockMode: mocks.isMockMode, run: mocks.run },
}));
vi.mock("@/lib/prisma", () => ({
  prisma: { project: { findUnique: mocks.project } },
}));

import { templateRecommendations, writeGeoRecommendations } from "./recommend";

function result(checks: GeoCheckResult[]): GeoAuditResult {
  return {
    v: 1,
    score: 40,
    checks,
    crawlers: [],
    llms: { state: "missing", bytes: 0, hasTitle: false, links: 0, sections: 0 },
    org: { present: true, types: [], name: "Secret Brand", sameAs: [], hasLogo: false },
    pages: {
      audited: 0,
      indexable: 0,
      withFaqSchema: 0,
      withQuestionHeadings: 0,
      longWithoutHeadings: 0,
      snippetBlocked: 0,
      renderRisk: 0,
    },
    auditedAt: "2026-10-07T00:00:00.000Z",
  };
}

const CHECKS: GeoCheckResult[] = [
  {
    id: "GEO2",
    status: "WARN",
    facts: { blocked: ["PerplexityBot"], blockedCount: 2, allowed: 3 },
  },
  { id: "GEO1", status: "INFO", facts: { state: "missing", bytes: 0 } },
  { id: "GEO4", status: "PASS", facts: {} },
];
const INPUT = {
  workspaceId: "w1",
  projectId: "p1",
  brandId: "b1",
  result: result(CHECKS),
};

beforeEach(() => {
  mocks.isMockMode.mockReset().mockReturnValue(false);
  mocks.run.mockReset();
  mocks.project.mockReset().mockResolvedValue({ language: "tr" });
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});

describe("writeGeoRecommendations", () => {
  it("sends only fixed ids, titles and statuses plus numbers and booleans", async () => {
    mocks.run.mockResolvedValue({ output: { items: [] } });
    await writeGeoRecommendations(INPUT);
    const call = mocks.run.mock.calls[0]!;
    expect(call[1]).toMatchObject({ workspaceId: "w1", projectId: "p1", brandId: "b1" });
    const context = call[1].context as { checks: Record<string, unknown>[] };
    const allowedStrings = new Set<string>([
      "WARN",
      "INFO",
      ...Object.keys(GEO_CHECKS),
      ...Object.values(GEO_CHECKS).map((def) => def.title),
    ]);
    for (const check of context.checks) {
      expect(Object.keys(check).sort()).toEqual(["facts", "id", "status", "title"]);
      for (const key of ["id", "title", "status"]) {
        expect(allowedStrings.has(check[key] as string)).toBe(true);
      }
      for (const value of Object.values(check.facts as object)) {
        expect(["number", "boolean"]).toContain(typeof value);
      }
    }
    expect(JSON.stringify(context)).not.toContain("Secret");
    expect(JSON.stringify(context)).not.toContain("Perplexity");
  });

  it("drops sentences with numbers the data does not support", async () => {
    mocks.run.mockResolvedValue({
      output: {
        items: [
          {
            id: "GEO2",
            recommendation:
              "Allow the crawlers in robots.txt. Doing so will raise traffic by 40%. 2 crawlers are blocked today.",
          },
          { id: "GEO1", recommendation: "Add llms.txt with a short summary." },
        ],
      },
    });
    const out = await writeGeoRecommendations(INPUT);
    expect(out.source).toBe("ai");
    expect(out.language).toBe("tr");
    const geo2 = out.items.find((item) => item.checkId === "GEO2")!;
    expect(geo2.text).toBe(
      "Allow the crawlers in robots.txt. 2 crawlers are blocked today.",
    );
    expect(out.items.find((item) => item.checkId === "GEO1")!.text).toBe(
      "Add llms.txt with a short summary.",
    );
  });

  it("uses the fixed text for a check the model skipped or wrote only unsupported text for", async () => {
    mocks.run.mockResolvedValue({
      output: {
        items: [
          { id: "GEO2", recommendation: "Traffic will grow 300%." },
          { id: "GEO1", recommendation: "Create the file." },
          { id: "GEO99", recommendation: "Ignored." },
        ],
      },
    });
    const out = await writeGeoRecommendations(INPUT);
    expect(out.source).toBe("ai");
    expect(out.items).toEqual([
      { checkId: "GEO2", text: GEO_CHECKS.GEO2.how },
      { checkId: "GEO1", text: "Create the file." },
    ]);
  });

  it("falls back to the template when nothing usable comes back", async () => {
    mocks.run.mockResolvedValue({
      output: { items: [{ id: "GEO2", recommendation: "Up 90%." }] },
    });
    const out = await writeGeoRecommendations(INPUT);
    expect(out).toEqual({
      source: "template",
      language: null,
      items: [
        { checkId: "GEO2", text: GEO_CHECKS.GEO2.how },
        { checkId: "GEO1", text: GEO_CHECKS.GEO1.how },
      ],
    });
    expect(mocks.project).not.toHaveBeenCalled();
  });

  it("uses the template in mock mode without calling the model", async () => {
    mocks.isMockMode.mockReturnValue(true);
    const out = await writeGeoRecommendations(INPUT);
    expect(out.source).toBe("template");
    expect(mocks.run).not.toHaveBeenCalled();
  });

  it.each([
    ["budget", Object.assign(new Error("limit"), { code: "BUDGET_EXCEEDED", name: "AgentelseError" })],
    ["other", new Error("model said secret things")],
  ])("falls back to the template on a %s error and logs only the name", async (_label, error) => {
    mocks.run.mockRejectedValue(error);
    const out = await writeGeoRecommendations(INPUT);
    expect(out.source).toBe("template");
    expect(out.items.map((item) => item.checkId)).toEqual(["GEO2", "GEO1"]);
    const logged = JSON.stringify(vi.mocked(console.error).mock.calls);
    expect(logged).not.toContain("secret");
  });

  it("does not call the model when nothing needs attention", async () => {
    const out = await writeGeoRecommendations({
      ...INPUT,
      result: result([{ id: "GEO4", status: "PASS", facts: {} }]),
    });
    expect(out).toEqual({ source: "template", language: null, items: [] });
    expect(mocks.run).not.toHaveBeenCalled();
  });
});

describe("templateRecommendations", () => {
  it("never writes a recommendation for the training crawlers check", () => {
    const out = templateRecommendations(
      result([{ id: "GEO3", status: "INFO", facts: { blockedCount: 1 } }]),
    );
    expect(out.items).toEqual([]);
  });
});
