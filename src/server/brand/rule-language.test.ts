import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const findUnique = vi.fn();
vi.mock("@/lib/prisma", () => ({
  prisma: { project: { findUnique: (...a: unknown[]) => findUnique(...a) } },
}));

import { brandRuleLanguageOf } from "./rule-language";

beforeEach(() => vi.clearAllMocks());

describe("brandRuleLanguageOf", () => {
  it("returns the project language, looked up by project id", async () => {
    findUnique.mockResolvedValue({ language: "en" });
    expect(await brandRuleLanguageOf("p1")).toBe("en");
    expect(findUnique).toHaveBeenCalledWith({
      where: { id: "p1" },
      select: { language: true },
    });
  });

  it("falls back to tr for an empty language or a missing project", async () => {
    findUnique.mockResolvedValue({ language: "" });
    expect(await brandRuleLanguageOf("p1")).toBe("tr");
    findUnique.mockResolvedValue(null);
    expect(await brandRuleLanguageOf("p1")).toBe("tr");
  });

  it("fails toward the stricter side: a lookup error answers tr", async () => {
    findUnique.mockRejectedValue(new Error("db"));
    expect(await brandRuleLanguageOf("p1")).toBe("tr");
  });
});
