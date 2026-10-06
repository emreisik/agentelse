import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Bu dosyanın kanıtladığı: adaylar marka sözcüğü ya da ortak sözcükle süzülür
// ve en çok 20'dir; uydurma ya da çevrilmiş terim, zaten etkin ya da gizlenmiş
// terim atılır; Add W1 saveBrandTerms'i etkin terimler + yeni terimle çağırır
// ve denetime yalnız sayı yazar; 10 dakikalık sınır; mock kararlıdır.

const mocks = vi.hoisted(() => ({
  brand: vi.fn(),
  project: vi.fn(),
  ensureEngineState: vi.fn(),
  readEngineState: vi.fn(),
  updateEngineState: vi.fn(),
  scopeForProject: vi.fn(),
  primaryGscLink: vi.fn(),
  readTopQueries: vi.fn(),
  saveBrandTerms: vi.fn(),
  run: vi.fn(),
  isMockMode: vi.fn(),
  getBrandContext: vi.fn(),
  audit: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    brand: { findFirst: mocks.brand },
    project: { findUnique: mocks.project },
  },
}));
vi.mock("./state", () => ({
  ensureEngineState: mocks.ensureEngineState,
  readEngineState: mocks.readEngineState,
  updateEngineState: mocks.updateEngineState,
}));
vi.mock("./classify", () => ({ scopeForProject: mocks.scopeForProject }));
vi.mock("@/server/seo/store", () => ({
  primaryGscLink: mocks.primaryGscLink,
  readTopQueries: mocks.readTopQueries,
}));
vi.mock("@/server/seo/brand-terms", () => ({
  saveBrandTerms: mocks.saveBrandTerms,
}));
vi.mock("@/server/reasoning/reasoning-service", () => ({
  ReasoningService: { run: mocks.run, isMockMode: mocks.isMockMode },
}));
vi.mock("@/server/agency/constitution/constitution-service", () => ({
  ConstitutionService: { getBrandContext: mocks.getBrandContext },
}));
vi.mock("@/server/repositories/audit-log.repository", () => ({
  AuditLogRepository: { record: mocks.audit },
}));
vi.mock("@/server/integrations/search-console/mock", () => ({
  MOCK_GSC_BRAND_TERM: "acme",
}));

import { AgentelseError } from "@/server/security/errors";

import {
  acceptBrandTermSuggestion,
  acceptedSuggestions,
  brandCandidates,
  dismissBrandTermSuggestion,
  readBrandTermSuggestions,
  suggestBrandTerms,
} from "./brand-suggest";

const NOW = new Date("2026-10-01T12:00:00Z");
const LINK = {
  id: "link-1",
  projectId: "p1",
  workspaceId: "ws1",
  isMock: false,
  siteUrl: "sc-domain:acmeshoes.com",
  brandTerms: {
    v: 1,
    auto: ["acme shoes"],
    user: [],
    removed: [],
    updatedAt: null,
  },
  lastWeeklyWeek: "2026-09-21",
  lastFinalDate: "2026-09-29",
};
const QUERIES = [
  "acmeshoes outlet",
  "akme shoes",
  "running shoes",
  "trail running shoes",
  "shoes for running",
  "garden chairs",
];

function on(): void {
  vi.stubEnv("SEO_INSIGHTS", "on");
  vi.stubEnv("GSC_SYNC", "true");
  vi.stubEnv("NODE_ENV", "production");
  vi.stubEnv("GSC_ROLLOUT_PROJECTS", "");
}

function stateWith(brandSuggestions: unknown) {
  return { id: "state-1", linkId: "link-1", brandSuggestions };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.unstubAllEnvs();
  on();
  mocks.brand.mockResolvedValue({ id: "b1", name: "Acme Shoes" });
  mocks.project.mockResolvedValue({ name: "Acme", domain: "acmeshoes.com" });
  mocks.ensureEngineState.mockResolvedValue(stateWith(null));
  mocks.readEngineState.mockResolvedValue(stateWith(null));
  mocks.updateEngineState.mockResolvedValue(undefined);
  mocks.scopeForProject.mockResolvedValue({
    workspaceId: "ws1",
    projectId: "p1",
    brandId: "b1",
  });
  mocks.primaryGscLink.mockResolvedValue(LINK);
  mocks.readTopQueries.mockResolvedValue(
    QUERIES.map((label, index) => ({
      id: `q${index}`,
      label,
      url: null,
      isBrand: false,
      clicks: 1,
      impressions: 100 - index,
      positionWeighted: 500,
    })),
  );
  mocks.isMockMode.mockReturnValue(false);
  mocks.getBrandContext.mockResolvedValue({
    products: ["Trail Runner - a light shoe for trails", 42],
  });
  mocks.saveBrandTerms.mockResolvedValue({ ok: true, terms: [] });
  mocks.audit.mockResolvedValue(undefined);
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("brandCandidates", () => {
  it("keeps brand-like or word-sharing queries, at most 20", () => {
    expect(
      brandCandidates(QUERIES, ["Acme Shoes", "Acme", "acmeshoes"]),
    ).toEqual([
      "acmeshoes outlet",
      "akme shoes",
      "running shoes",
      "trail running shoes",
      "shoes for running",
    ]);
    const many = Array.from({ length: 50 }, (_, i) => `acme model ${i}`);
    expect(brandCandidates(many, ["acme"])).toHaveLength(20);
    expect(brandCandidates(["garden chairs"], ["acme"])).toEqual([]);
  });
});

describe("acceptedSuggestions", () => {
  const base = {
    candidates: ["akme shoes", "acmeshoes outlet"],
    own: ["Acme Shoes", "acmeshoes"],
    effective: ["acme shoes"],
    dismissed: ["akmeshoes"],
    at: NOW.toISOString(),
  };

  it("drops invented, translated, existing and dismissed terms", () => {
    expect(
      acceptedSuggestions(
        [
          { term: "akme", reason: "A common misspelling seen 12 times." },
          { term: "zapatos acme", reason: "Translated." },
          { term: "Acme-Shoes", reason: "Already a term." },
          { term: "akme shoes", reason: "Dismissed before." },
          { term: "acmeshoes", reason: "Same as a term without spaces." },
          { term: "acmeshoes outlet", reason: "" },
          { term: "a, b", reason: "Two terms." },
        ],
        base,
      ),
    ).toEqual([
      {
        term: "akme",
        reason: "A common misspelling seen times.",
        at: NOW.toISOString(),
      },
      {
        term: "acmeshoes outlet",
        reason: "Appears in your searches.",
        at: NOW.toISOString(),
      },
    ]);
  });

  it("keeps at most 8 and trims long reasons to 120 characters", () => {
    const terms = Array.from({ length: 12 }, (_, i) => ({
      term: `acme ${String.fromCharCode(97 + i)}`,
      reason: "x".repeat(300),
    }));
    const result = acceptedSuggestions(terms, {
      ...base,
      candidates: terms.map((item) => `${item.term} outlet`),
    });
    expect(result).toHaveLength(8);
    expect(result[0]?.reason).toHaveLength(120);
  });
});

describe("suggestBrandTerms", () => {
  it("is off without the flag and reads nothing", async () => {
    vi.stubEnv("SEO_INSIGHTS", "shadow");
    expect(await suggestBrandTerms("p1", NOW)).toEqual({
      ok: false,
      reason: "off",
    });
    expect(await readBrandTermSuggestions("p1")).toBeNull();
    expect(mocks.primaryGscLink).not.toHaveBeenCalled();
  });

  it("asks the model with at most 20 candidates and stores checked terms", async () => {
    mocks.run.mockResolvedValueOnce({
      output: {
        terms: [
          { term: "akme", reason: "Misspelling." },
          { term: "zapatillas", reason: "Translated." },
        ],
      },
      isMock: false,
      reasoningCallId: "r1",
    });
    const result = await suggestBrandTerms("p1", NOW);
    expect(result).toEqual({
      ok: true,
      suggestions: [
        { term: "akme", reason: "Misspelling.", at: NOW.toISOString() },
      ],
    });
    expect(mocks.readTopQueries).toHaveBeenCalledWith(
      "link-1",
      { from: "2026-06-29", to: "2026-09-21" },
      { limit: 200, brand: "non-brand", orderBy: "impressions" },
    );
    const [def, call] = mocks.run.mock.calls[0]!;
    expect(def).toMatchObject({ purpose: "seo.brand-terms" });
    expect(call.context.candidates.length).toBeLessThanOrEqual(20);
    expect(call.context.candidates).not.toContain("garden chairs");
    expect(call.context).toMatchObject({
      brandName: "Acme Shoes",
      projectName: "Acme",
      domain: "acmeshoes.com",
      currentTerms: ["acme shoes"],
      names: ["Trail Runner"],
    });
    expect(mocks.updateEngineState).toHaveBeenCalledWith("link-1", {
      brandSuggestions: {
        v: 1,
        items: [
          { term: "akme", reason: "Misspelling.", at: NOW.toISOString() },
        ],
        dismissed: [],
        lastAt: NOW.toISOString(),
        auto: false,
      },
    });
  });

  it("refuses within 10 minutes of the last run", async () => {
    mocks.ensureEngineState.mockResolvedValueOnce(
      stateWith({
        v: 1,
        items: [],
        dismissed: [],
        lastAt: new Date(NOW.getTime() - 5 * 60_000).toISOString(),
        auto: true,
      }),
    );
    expect(await suggestBrandTerms("p1", NOW)).toEqual({
      ok: false,
      reason: "too_soon",
    });
    expect(mocks.run).not.toHaveBeenCalled();
  });

  it("maps a spent budget to budget", async () => {
    mocks.run.mockRejectedValueOnce(
      new AgentelseError("BUDGET_EXCEEDED", "cap"),
    );
    expect(await suggestBrandTerms("p1", NOW)).toEqual({
      ok: false,
      reason: "budget",
    });
    expect(mocks.updateEngineState).not.toHaveBeenCalled();
  });

  it("is deterministic in mock mode without calling the model", async () => {
    mocks.isMockMode.mockReturnValue(true);
    mocks.primaryGscLink.mockResolvedValue({
      ...LINK,
      brandTerms: { v: 1, auto: [], user: [], removed: [], updatedAt: null },
    });
    const first = await suggestBrandTerms("p1", NOW);
    expect(first).toEqual({
      ok: true,
      suggestions: [
        {
          term: "acme",
          reason: "Appears in your searches.",
          at: NOW.toISOString(),
        },
      ],
    });
    expect(mocks.run).not.toHaveBeenCalled();

    // Zaten terimse önerilmez.
    mocks.primaryGscLink.mockResolvedValue({
      ...LINK,
      brandTerms: {
        v: 1,
        auto: [],
        user: ["acme"],
        removed: [],
        updatedAt: null,
      },
    });
    expect(await suggestBrandTerms("p1", NOW)).toEqual({
      ok: true,
      suggestions: [],
    });
  });
});

describe("accept and dismiss", () => {
  const stored = {
    v: 1,
    items: [
      { term: "akme", reason: "Misspelling.", at: NOW.toISOString() },
      { term: "acmeshoes", reason: "Domain.", at: NOW.toISOString() },
    ],
    dismissed: [],
    lastAt: NOW.toISOString(),
    auto: true,
  };

  it("accepts with the effective terms plus the new one and audits a count", async () => {
    mocks.readEngineState.mockResolvedValue(stateWith(stored));
    expect(
      await acceptBrandTermSuggestion({
        projectId: "p1",
        term: "AKME",
        now: NOW,
        userId: "u1",
      }),
    ).toEqual({ ok: true });
    expect(mocks.saveBrandTerms).toHaveBeenCalledWith({
      projectId: "p1",
      terms: ["acme shoes", "akme"],
      now: NOW,
    });
    expect(mocks.updateEngineState).toHaveBeenCalledWith("link-1", {
      brandSuggestions: { ...stored, items: [stored.items[1]] },
    });
    expect(mocks.audit).toHaveBeenCalledWith({
      workspaceId: "ws1",
      projectId: "p1",
      actorType: "USER",
      actorId: "u1",
      action: "search_console.brand_term_suggestion_accepted",
      entityType: "GscSiteLink",
      entityId: "link-1",
      metadata: { count: 1 },
    });
  });

  it("refuses a term that was not suggested or does not fit", async () => {
    mocks.readEngineState.mockResolvedValue(stateWith(stored));
    expect(
      await acceptBrandTermSuggestion({ projectId: "p1", term: "other" }),
    ).toEqual({ ok: false, reason: "not_suggested" });
    mocks.saveBrandTerms.mockResolvedValueOnce({
      ok: false,
      reason: "too_long",
    });
    expect(
      await acceptBrandTermSuggestion({ projectId: "p1", term: "akme" }),
    ).toEqual({ ok: false, reason: "too_long" });
    expect(mocks.audit).not.toHaveBeenCalled();
  });

  it("dismisses into the hidden list", async () => {
    mocks.readEngineState.mockResolvedValue(stateWith(stored));
    expect(
      await dismissBrandTermSuggestion({ projectId: "p1", term: "akme" }),
    ).toBe(true);
    expect(mocks.updateEngineState).toHaveBeenCalledWith("link-1", {
      brandSuggestions: {
        ...stored,
        items: [stored.items[1]],
        dismissed: ["akme"],
      },
    });
    expect(
      await dismissBrandTermSuggestion({ projectId: "p1", term: "nope" }),
    ).toBe(false);
  });

  it("lists pending suggestions that are not terms yet", async () => {
    mocks.readEngineState.mockResolvedValue(stateWith(stored));
    mocks.primaryGscLink.mockResolvedValue({
      ...LINK,
      brandTerms: {
        v: 1,
        auto: ["acmeshoes"],
        user: [],
        removed: [],
        updatedAt: null,
      },
    });
    expect(await readBrandTermSuggestions("p1")).toEqual([stored.items[0]]);
  });
});
