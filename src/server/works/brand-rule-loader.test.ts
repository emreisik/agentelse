import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  negatives: vi.fn(),
  claims: vi.fn(),
  competitors: vi.fn(),
  learnings: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/prisma", () => ({
  prisma: {
    negativeBriefRule: { findMany: mocks.negatives },
    approvedClaim: { findMany: mocks.claims },
    competitor: { findMany: mocks.competitors },
    brandLearning: { findMany: mocks.learnings },
  },
}));

import {
  createBrandRulesGetter,
  loadBrandRules,
  MAX_BRAND_RULES,
} from "@/server/works/brand-rule-loader";

const input = { projectId: "p1", brandId: "b1", language: "tr" };

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  mocks.negatives.mockResolvedValue([]);
  mocks.claims.mockResolvedValue([]);
  mocks.competitors.mockResolvedValue([]);
  mocks.learnings.mockResolvedValue([]);
});

describe("loadBrandRules", () => {
  it("merges every source and maps categories to origins", async () => {
    mocks.negatives.mockResolvedValue([
      { rule: "indirim", category: "forbidden-claim" },
      { rule: "no emojis", category: "client-rule" },
      { rule: "never mention x", category: "weird" },
      { rule: "tone", category: null },
    ]);
    mocks.claims.mockResolvedValue([{ claim: " 20 yıl deneyim " }]);
    mocks.competitors.mockResolvedValue([{ name: "Acme" }]);
    mocks.learnings.mockResolvedValue([{ insight: "avoid puns" }]);
    const out = await loadBrandRules(input);
    expect(out).toEqual({
      language: "tr",
      never: [
        { text: "indirim", origin: "forbidden-claim" },
        { text: "no emojis", origin: "client-rule" },
        { text: "never mention x", origin: "negative-brief" },
        { text: "tone", origin: "negative-brief" },
        { text: "avoid puns", origin: "memory" },
      ],
      approvedClaims: ["20 yıl deneyim"],
      competitors: ["Acme"],
    });
  });

  it("dedupes by folded text and caps at 60 rules", async () => {
    mocks.negatives.mockResolvedValue([
      { rule: "İNDİRİM", category: null },
      { rule: "indirim", category: null },
      ...Array.from({ length: 80 }, (_, i) => ({ rule: `rule ${i}`, category: null })),
    ]);
    mocks.learnings.mockResolvedValue([{ insight: "Indirim" }]);
    const out = await loadBrandRules(input);
    expect(out?.never).toHaveLength(MAX_BRAND_RULES);
    expect(out?.never.filter((r) => r.text.toLowerCase().startsWith("i")).length).toBe(1);
  });

  it("scopes every query by project and brand", async () => {
    await loadBrandRules(input);
    expect(mocks.negatives.mock.calls[0]?.[0].where).toEqual({
      projectId: "p1", brandId: "b1", active: true,
    });
    expect(mocks.claims.mock.calls[0]?.[0].where).toEqual({
      projectId: "p1", brandId: "b1", active: true,
    });
    expect(mocks.competitors.mock.calls[0]?.[0]).toMatchObject({
      where: { projectId: "p1" }, take: 20,
    });
    expect(mocks.learnings.mock.calls[0]?.[0]).toMatchObject({
      where: { projectId: "p1", brandId: "b1", polarity: "AVOID", sourceType: "USER_EXPLICIT" },
      take: 20,
    });
  });

  it("returns null instead of throwing on any error", async () => {
    mocks.claims.mockRejectedValue(new Error("neon cold start"));
    await expect(loadBrandRules(input)).resolves.toBeNull();
  });
});

describe("createBrandRulesGetter", () => {
  it("loads once per getter", async () => {
    const get = createBrandRulesGetter(input);
    await Promise.all([get(), get()]);
    await get();
    expect(mocks.negatives).toHaveBeenCalledTimes(1);
  });
});
