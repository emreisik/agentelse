import { beforeEach, describe, expect, it, vi } from "vitest";

import { candidateFixture } from "@/lib/seo/content-plan/test-support";
import type { PlanCandidate } from "@/lib/seo/content-plan/types";
import { AgentelseError } from "@/server/security/errors";

// Bu dosyanın kanıtladığı: modele en çok 20 farklı maskeli Google dizgisi gider
// (anahtar kelimeler önce); maskelemede değişen dizge düşer; geçersiz model
// başlığı (anahtar kelime yok, marka kuralı, uydurma rakam) düşer; mock -> MOCK;
// bütçe dolunca BASIC + budgetHit; başka hata BASIC.

const mocks = vi.hoisted(() => ({
  isMockMode: vi.fn(),
  run: vi.fn(),
  loadBrandRules: vi.fn(),
  getBrandContext: vi.fn(),
}));

vi.mock("@/server/reasoning/reasoning-service", () => ({
  ReasoningService: { isMockMode: mocks.isMockMode, run: mocks.run },
}));
vi.mock("@/server/works/brand-rule-loader", () => ({
  loadBrandRules: mocks.loadBrandRules,
}));
vi.mock("@/server/brand/rule-language", () => ({
  brandRuleLanguageOf: vi.fn().mockResolvedValue("en"),
}));
vi.mock("@/server/agency/constitution/constitution-service", () => ({
  ConstitutionService: { getBrandContext: mocks.getBrandContext },
}));

const { writeWording, wordingContext } = await import("./wording");

const scope = { workspaceId: "w1", projectId: "p1", brandId: "b1" };
const NOW = new Date("2026-10-07T09:00:00Z");

function candidates(count: number, queriesEach = 3): PlanCandidate[] {
  return Array.from({ length: count }, (_, i) =>
    candidateFixture({
      keyword: `cactus care topic${i}`,
      queries: Array.from(
        { length: queriesEach },
        (_, q) => `cactus care topic${i} variant${q}`,
      ),
      clusterId: `c${i}`,
    }),
  );
}

function stringsIn(context: ReturnType<typeof wordingContext>): string[] {
  return context.candidates.flatMap((item) => [item.keyword, ...item.queries]);
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.isMockMode.mockReturnValue(false);
  mocks.loadBrandRules.mockResolvedValue(null);
  mocks.getBrandContext.mockResolvedValue({ name: "Acme" });
});

describe("wordingContext", () => {
  it("sends at most 20 distinct strings for 12 candidates with 3 queries each, keywords first", () => {
    const list = candidates(12);
    const context = wordingContext(list);
    const strings = stringsIn(context);
    expect(new Set(strings).size).toBeLessThanOrEqual(20);
    // Her adayın anahtar kelimesi var; kalan 8 yer destekleyici sorgulara gider.
    expect(context.candidates).toHaveLength(12);
    for (const [i, item] of context.candidates.entries()) {
      expect(item.keyword).toBe(list[i]!.keyword);
    }
    const queries = context.candidates.reduce((sum, item) => sum + item.queries.length, 0);
    expect(queries).toBe(8);
  });

  it("counts a string shared by two candidates once", () => {
    const a = candidateFixture({ keyword: "cactus care", queries: ["shared query"], clusterId: "a" });
    const b = candidateFixture({ keyword: "cactus soil", queries: ["shared query"], clusterId: "b" });
    const context = wordingContext([a, b]);
    expect(context.candidates[0]!.queries).toEqual(["shared query"]);
    expect(context.candidates[1]!.queries).toEqual(["shared query"]);
  });

  it("drops a string that changes when masked (and a candidate whose keyword does)", () => {
    const personal = candidateFixture({
      keyword: "write to jane.doe@example.com",
      queries: [],
      clusterId: "p",
    });
    const clean = candidateFixture({
      keyword: "cactus care",
      queries: ["call +90 555 123 4567", "cactus soil mix"],
      clusterId: "c",
    });
    const context = wordingContext([personal, clean]);
    expect(context.candidates.map((item) => item.keyword)).toEqual(["cactus care"]);
    expect(context.candidates[0]!.queries).toEqual(["cactus soil mix"]);
    expect(JSON.stringify(context)).not.toContain("@");
    expect(JSON.stringify(context)).not.toContain("555");
  });
});

describe("writeWording", () => {
  it("returns the model's valid items as AI wording", async () => {
    const list = candidates(2, 1);
    mocks.run.mockResolvedValue({
      output: {
        items: [
          { id: list[0]!.id, title: "All about cactus care topic0", angle: "A fresh angle.", description: "What you get." },
          { id: list[1]!.id, title: "Totally unrelated words", angle: "x", description: "y" },
        ],
      },
      isMock: false,
    });
    const result = await writeWording({ scope, candidates: list, language: "en", now: NOW });
    expect(result.wording).toBe("AI");
    expect(result.budgetHit).toBe(false);
    expect(result.items.get(list[0]!.id)?.title).toBe("All about cactus care topic0");
    // Anahtar kelime sözcüğü olmayan başlık düşer; planlayıcı temel başlığı koyar.
    expect(result.items.has(list[1]!.id)).toBe(false);
    expect(mocks.run).toHaveBeenCalledTimes(1);
    const call = mocks.run.mock.calls[0]!;
    expect(call[0].purpose).toBe("seo.content-plan");
    expect(call[1].context.candidates).toHaveLength(2);
    expect(call[1].context.brand).toEqual({ name: "Acme" });
  });

  it("drops invented digits in a title", async () => {
    const [candidate] = candidates(1, 0);
    mocks.run.mockResolvedValue({
      output: { items: [{ id: candidate!.id, title: "Cactus care topic0 in 2031", angle: "a", description: "b" }] },
      isMock: false,
    });
    const result = await writeWording({ scope, candidates: [candidate!], language: "en", now: NOW });
    expect(result.items.size).toBe(0);
  });

  it("drops an item whose title breaks a brand rule", async () => {
    const [candidate] = candidates(1, 0);
    mocks.loadBrandRules.mockResolvedValue({
      language: "en",
      never: [{ text: "cheap", origin: "client-rule" }],
      approvedClaims: [],
      competitors: [],
    });
    mocks.run.mockResolvedValue({
      output: { items: [{ id: candidate!.id, title: "Cheap cactus care topic0", angle: "a", description: "b" }] },
      isMock: false,
    });
    const result = await writeWording({ scope, candidates: [candidate!], language: "en", now: NOW });
    expect(result.items.size).toBe(0);
    expect(result.wording).toBe("AI");
    // Kurallar modele de alıntı veri olarak gider.
    expect(mocks.run.mock.calls[0]![1].context.rules).toEqual(["cheap"]);
  });

  it("uses the deterministic mock wording in mock mode without calling the model", async () => {
    mocks.isMockMode.mockReturnValue(true);
    const list = candidates(2, 1);
    const result = await writeWording({ scope, candidates: list, language: "en", now: NOW });
    expect(result.wording).toBe("MOCK");
    expect(result.items.size).toBe(2);
    expect(mocks.run).not.toHaveBeenCalled();
  });

  it("falls back to BASIC with budgetHit when the AI budget is exceeded", async () => {
    mocks.run.mockRejectedValue(new AgentelseError("BUDGET_EXCEEDED", "limit"));
    const result = await writeWording({ scope, candidates: candidates(2), language: "en", now: NOW });
    expect(result).toMatchObject({ wording: "BASIC", budgetHit: true });
    expect(result.items.size).toBe(0);
  });

  it("falls back to BASIC on any other failure without leaking the message", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    mocks.run.mockRejectedValue(new Error("boom: secret query text"));
    const result = await writeWording({ scope, candidates: candidates(2), language: "en", now: NOW });
    expect(result).toMatchObject({ wording: "BASIC", budgetHit: false });
    expect(JSON.stringify(spy.mock.calls)).not.toContain("secret query text");
    spy.mockRestore();
  });

  it("makes no call for an empty candidate list", async () => {
    const result = await writeWording({ scope, candidates: [], language: "en", now: NOW });
    expect(result.wording).toBe("BASIC");
    expect(mocks.run).not.toHaveBeenCalled();
  });
});
