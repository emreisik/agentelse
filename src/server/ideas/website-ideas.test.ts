import { beforeEach, describe, expect, it, vi } from "vitest";

import type { IdeaConcept } from "@/lib/ideas/concept";
import type { IdeaRow } from "@/server/ideas/idea-context";

// Bu dosyanın kanıtladığı: bayrak kapalıyken hiç sorgu yok; mock bağ ve
// bulgusuzluk model çağrısı yapmadan EMPTY döner; bulgu sorgusu isMock=false
// taşır; havuzda 3 website fikri bekliyorsa EMPTY; kaydedilen fikirler
// source "website", rakamsız kanıt başlığı ve uygulama içi adres taşır ve
// kullanılan bulgunun ideaIds'i güncellenir; satırlar verilmezse yeniden okunur.

const mocks = vi.hoisted(() => ({
  mode: vi.fn(),
  modules: vi.fn(),
  reasoningFindFirst: vi.fn(),
  findingFindMany: vi.fn(),
  findingUpdate: vi.fn(),
  projectFindUnique: vi.fn(),
  brandFindFirst: vi.fn(),
  postFindMany: vi.fn(),
  primaryGaLink: vi.fn(),
  poolCapacity: vi.fn(),
  saveIdeaConcepts: vi.fn(),
  readIdeaRows: vi.fn(),
  run: vi.fn(),
  isMockMode: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    reasoningCall: { findFirst: mocks.reasoningFindFirst },
    gaFinding: {
      findMany: mocks.findingFindMany,
      update: mocks.findingUpdate,
    },
    project: { findUnique: mocks.projectFindUnique },
    brand: { findFirst: mocks.brandFindFirst },
    post: { findMany: mocks.postFindMany },
  },
}));
vi.mock("@/lib/website-analytics/analysis/flags", () => ({
  gaInsightsModeFor: mocks.mode,
}));
// Kanıt testte zaten doğru biçimde: ayrıştırıcı olduğu gibi döndürür.
vi.mock("@/lib/website-analytics/analysis/stored", () => ({
  parseGaFindingEvidence: (json: unknown) => json,
}));
vi.mock("@/server/works/flag", () => ({ isModulesEnabled: mocks.modules }));
vi.mock("@/server/website-analytics/store", () => ({
  primaryGaLink: mocks.primaryGaLink,
}));
vi.mock("@/server/ideas/idea-engine", () => ({
  poolCapacity: mocks.poolCapacity,
  saveIdeaConcepts: mocks.saveIdeaConcepts,
}));
vi.mock("@/server/ideas/idea-context", () => ({
  readIdeaRows: mocks.readIdeaRows,
}));
vi.mock("@/server/reasoning/reasoning-service", () => ({
  ReasoningService: { run: mocks.run, isMockMode: mocks.isMockMode },
}));
vi.mock("@/server/agency/constitution/constitution-service", () => ({
  ConstitutionService: { getBrandContext: async () => ({ name: "Acme" }) },
}));
vi.mock("@/server/brand/rule-language", () => ({
  brandRuleLanguageOf: async () => "en",
}));
vi.mock("@/server/works/brand-rule-loader", () => ({
  loadBrandRules: async () => null,
}));
vi.mock("@/lib/app-url", () => ({
  appUrl: (path: string) => new URL(path, "https://app.example.com"),
}));

const { refreshWebsiteIdeas, WEBSITE_IDEAS_TARGET } =
  await import("./website-ideas");

const NOW = new Date("2026-10-06T08:00:00.000Z");
const LINK = { id: "link-1", isMock: false, timeZone: "Europe/Istanbul" };

const FINDINGS = [
  {
    id: "find-search",
    evidence: {
      v: 1,
      rule: "AN8",
      weeks: ["2026-09-28"],
      terms: [
        { term: "winter tyres", searches: 42 },
        { term: "opening hours", searches: 17 },
      ],
      totalSearches: 59,
      siteSessions: 1200,
    },
  },
  {
    id: "find-promote",
    evidence: {
      v: 1,
      rule: "AN3",
      variant: "promote",
      page: "/services/tyre-change",
    },
  },
];

function websiteRow(id: string): IdeaRow {
  return {
    id,
    status: "VALIDATED",
    title: id,
    description: "",
    createdAt: NOW,
    updatedAt: NOW,
    isMock: false,
    concept: {
      v: 2,
      module: "seo",
      source: "website",
      draft: {
        keyword: id,
        intent: "informational",
        title: id,
        description: id,
        angle: id,
      },
    },
  };
}

function idea(keyword: string) {
  return {
    keyword,
    intent: "informational",
    title: `All about ${keyword}`,
    description: `What to know about ${keyword}.`,
    angle: "Practical answers.",
  };
}

beforeEach(() => {
  for (const mock of Object.values(mocks)) mock.mockReset();
  mocks.mode.mockReturnValue("on");
  mocks.modules.mockReturnValue(true);
  mocks.reasoningFindFirst.mockResolvedValue(null);
  mocks.primaryGaLink.mockResolvedValue(LINK);
  mocks.findingFindMany.mockResolvedValue(FINDINGS);
  mocks.findingUpdate.mockResolvedValue({});
  mocks.projectFindUnique.mockResolvedValue({ workspaceId: "ws-1" });
  mocks.brandFindFirst.mockResolvedValue({ id: "brand-1" });
  mocks.postFindMany.mockResolvedValue([]);
  mocks.readIdeaRows.mockResolvedValue([]);
  mocks.poolCapacity.mockResolvedValue({ free: 10, retire: [] });
  mocks.isMockMode.mockReturnValue(false);
  mocks.run.mockResolvedValue({
    output: { ideas: [idea("winter tyres"), idea("tyre change prices")] },
    isMock: false,
    reasoningCallId: "rc-1",
  });
  mocks.saveIdeaConcepts.mockImplementation(
    async (input: { concepts: IdeaConcept[] }) => ({
      ok: true,
      created: input.concepts.map((_, index) => `idea-${index + 1}`),
      rotated: 0,
    }),
  );
});

describe("refreshWebsiteIdeas", () => {
  it("returns EMPTY without any query while the mode is off", async () => {
    mocks.mode.mockReturnValue("shadow");
    const result = await refreshWebsiteIdeas({ projectId: "proj-1", now: NOW });
    expect(result).toEqual({ ok: false, reason: "EMPTY" });
    expect(mocks.reasoningFindFirst).not.toHaveBeenCalled();
    expect(mocks.primaryGaLink).not.toHaveBeenCalled();
    expect(mocks.findingFindMany).not.toHaveBeenCalled();
    expect(mocks.readIdeaRows).not.toHaveBeenCalled();
  });

  it("returns EMPTY without a model call for a mock link", async () => {
    mocks.primaryGaLink.mockResolvedValue({ ...LINK, isMock: true });
    const result = await refreshWebsiteIdeas({ projectId: "proj-1", now: NOW });
    expect(result).toEqual({ ok: false, reason: "EMPTY" });
    expect(mocks.findingFindMany).not.toHaveBeenCalled();
    expect(mocks.run).not.toHaveBeenCalled();
  });

  it("asks only for live, non-mock, unused findings", async () => {
    await refreshWebsiteIdeas({ projectId: "proj-1", now: NOW });
    const where = mocks.findingFindMany.mock.calls[0]![0].where;
    expect(where).toMatchObject({
      linkId: "link-1",
      mode: "live",
      isMock: false,
      status: { in: ["OPEN", "ACCEPTED"] },
      ruleKey: { in: ["AN8", "AN3", "AN10"] },
      ideaIds: { isEmpty: true },
    });
  });

  it("returns EMPTY without a model call when there are no findings", async () => {
    mocks.findingFindMany.mockResolvedValue([]);
    const result = await refreshWebsiteIdeas({ projectId: "proj-1", now: NOW });
    expect(result).toEqual({ ok: false, reason: "EMPTY" });
    expect(mocks.run).not.toHaveBeenCalled();
  });

  it("waits a week after a successful call", async () => {
    mocks.reasoningFindFirst.mockResolvedValue({
      createdAt: new Date(NOW.getTime() - 3 * 24 * 3_600_000),
      status: "OK",
    });
    const result = await refreshWebsiteIdeas({ projectId: "proj-1", now: NOW });
    expect(result).toEqual({ ok: false, reason: "EMPTY" });
    expect(mocks.primaryGaLink).not.toHaveBeenCalled();
  });

  it("returns EMPTY when the pool already holds the target", async () => {
    const rows = Array.from({ length: WEBSITE_IDEAS_TARGET }, (_, index) =>
      websiteRow(`w${index}`),
    );
    const result = await refreshWebsiteIdeas({
      projectId: "proj-1",
      now: NOW,
      rows,
    });
    expect(result).toEqual({ ok: false, reason: "EMPTY" });
    expect(mocks.run).not.toHaveBeenCalled();
    expect(mocks.readIdeaRows).not.toHaveBeenCalled();
  });

  it("saves website ideas with figure-free evidence and links the findings", async () => {
    const result = await refreshWebsiteIdeas({ projectId: "proj-1", now: NOW });
    expect(result).toEqual({
      ok: true,
      created: ["idea-1", "idea-2"],
      rotated: 0,
    });
    // Satırlar verilmediği için yeniden okundu.
    expect(mocks.readIdeaRows).toHaveBeenCalledWith("proj-1");

    const context = mocks.run.mock.calls[0]![1].context;
    expect(context.count).toBe(WEBSITE_IDEAS_TARGET);
    expect(context.evidence).toEqual({
      searches: [
        ["winter tyres", 42],
        ["opening hours", 17],
      ],
      convertingPages: ["/services/tyre-change"],
      engagingPages: [],
    });

    const saved = mocks.saveIdeaConcepts.mock.calls[0]![0];
    expect(saved.isMock).toBe(false);
    const concepts = saved.concepts as IdeaConcept[];
    expect(concepts).toHaveLength(2);
    for (const concept of concepts) {
      expect(concept.source).toBe("website");
      for (const item of concept.evidence ?? []) {
        expect(item.title).not.toMatch(/\d/);
        expect(
          item.url.startsWith(
            "https://app.example.com/projects/proj-1/site#finding-",
          ),
        ).toBe(true);
      }
    }
    expect(concepts[0]!.why).toBe("Visitors search your site for this.");
    expect(concepts[0]!.evidence).toEqual([
      {
        title: "From your website: site search",
        url: "https://app.example.com/projects/proj-1/site#finding-find-search",
      },
    ]);
    expect(concepts[1]!.why).toBe("This topic already brings you leads.");
    expect(concepts[1]!.evidence?.[0]?.title).toBe(
      "From your website: a page that converts well",
    );

    expect(mocks.findingUpdate).toHaveBeenCalledWith({
      where: { id: "find-search" },
      data: { ideaIds: { push: ["idea-1"] } },
    });
    expect(mocks.findingUpdate).toHaveBeenCalledWith({
      where: { id: "find-promote" },
      data: { ideaIds: { push: ["idea-2"] } },
    });
  });

  it("returns FULL without a model call when the pool has no room", async () => {
    mocks.poolCapacity.mockResolvedValue({ free: 0, retire: [] });
    const result = await refreshWebsiteIdeas({ projectId: "proj-1", now: NOW });
    expect(result).toEqual({ ok: false, reason: "FULL" });
    expect(mocks.run).not.toHaveBeenCalled();
  });
});
