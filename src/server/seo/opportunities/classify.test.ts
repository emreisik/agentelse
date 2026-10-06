import { beforeEach, describe, expect, it, vi } from "vitest";

import { AgentelseError } from "@/server/security/errors";

// Bu dosyanın kanıtladığı: kurallar önce çalışır, bulanık marka eşleşmesi
// navigational olur; LLM yalnız ≥ 50 gösterimli artıklar için, çağrı başına
// ≤ 20 dizge ve koşu başına ≤ 5 çağrı; gönderilemeyen ≥ 50 artıklar NULL
// kalır ama dilleri yazılır, < 50 artıklar informational olur;
// BUDGET_EXCEEDED LLM'i durdurur, kural niyetleri yine yazılır; marka özeti
// değişince navigational/marka satırları sıfırlanır.

const mocks = vi.hoisted(() => ({
  queryRaw: vi.fn(),
  executeRaw: vi.fn(),
  queryUpdateMany: vi.fn(),
  stateUpdate: vi.fn(),
  run: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    $queryRaw: mocks.queryRaw,
    $executeRaw: mocks.executeRaw,
    gscQuery: { updateMany: mocks.queryUpdateMany },
    seoEngineState: { update: mocks.stateUpdate },
  },
}));
vi.mock("@/server/reasoning/reasoning-service", () => ({
  ReasoningService: { run: mocks.run, isMockMode: () => false },
}));

const { classifyQueries } = await import("./classify");

const SCOPE = { workspaceId: "w1", projectId: "p1", brandId: "b1" };
const LINK = {
  id: "link-1",
  projectId: "p1",
  brandTerms: {
    v: 1,
    auto: [],
    user: ["acmeshop"],
    removed: [],
    updatedAt: null,
  },
  brandClassifiedHash: "hash-1",
};

type Row = { id: string; text: string; isBrand: boolean; impressions: bigint };

function row(
  id: string,
  text: string,
  impressions: number,
  isBrand = false,
): Row {
  return { id, text, isBrand, impressions: BigInt(impressions) };
}

// $executeRaw'ın VALUES parametreleri: [id, intent, language] üçlüleri.
function writes(): Map<
  string,
  { intent: string | null; language: string | null }
> {
  const result = new Map<
    string,
    { intent: string | null; language: string | null }
  >();
  for (const call of mocks.executeRaw.mock.calls) {
    const joined = call.find(
      (value: unknown): value is { values: unknown[] } =>
        !!value &&
        typeof value === "object" &&
        Array.isArray((value as { values?: unknown }).values),
    );
    if (!joined) continue;
    const values = joined.values;
    for (let index = 0; index + 2 < values.length; index += 3) {
      result.set(String(values[index]), {
        intent: values[index + 1] as string | null,
        language: values[index + 2] as string | null,
      });
    }
  }
  return result;
}

function classify(
  overrides: Partial<Parameters<typeof classifyQueries>[0]> = {},
) {
  return classifyQueries({
    link: LINK,
    stateId: "state-1",
    intentBrandHash: "hash-1",
    scope: SCOPE,
    deadline: Date.now() + 60_000,
    now: new Date("2026-10-07T12:00:00.000Z"),
    ...overrides,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.executeRaw.mockResolvedValue(1);
  mocks.queryUpdateMany.mockResolvedValue({ count: 0 });
  mocks.stateUpdate.mockResolvedValue({});
  mocks.run.mockImplementation(
    async (
      _def: unknown,
      input: { context: { queries: [number, string][] } },
    ) => ({
      output: {
        items: input.context.queries.map(([i]) => ({
          i,
          intent: "commercial",
        })),
      },
      isMock: false,
      reasoningCallId: "rc",
    }),
  );
});

describe("classifyQueries", () => {
  it("applies the rules first and treats fuzzy brand matches as navigational", async () => {
    mocks.queryRaw.mockResolvedValue([
      row("q1", "buy running shoes", 10),
      row("q2", "acmshop login", 5),
      row("q3", "red sneakers", 10),
    ]);
    const result = await classify();
    const written = writes();
    expect(written.get("q1")?.intent).toBe("transactional");
    expect(written.get("q2")?.intent).toBe("navigational");
    expect(written.get("q3")?.intent).toBe("informational");
    expect(written.get("q1")?.language).not.toBeUndefined();
    expect(mocks.run).not.toHaveBeenCalled();
    expect(result).toEqual({ classified: 3, llmCalls: 0, budgetHit: false });
    expect(mocks.stateUpdate).toHaveBeenCalledWith({
      where: { id: "state-1" },
      data: { classifiedAt: new Date("2026-10-07T12:00:00.000Z") },
    });
  });

  it("sends only leftovers with ≥50 impressions, ≤20 per call and ≤5 calls", async () => {
    const leftovers = Array.from({ length: 130 }, (_, i) =>
      row(`l${i}`, `red sneakers model ${i}`, 60),
    );
    mocks.queryRaw.mockResolvedValue([
      row("small", "blue sneakers", 49),
      ...leftovers,
    ]);
    const result = await classify();
    expect(result.llmCalls).toBe(5);
    for (const call of mocks.run.mock.calls) {
      const queries = (call[1] as { context: { queries: unknown[] } }).context
        .queries;
      expect(queries.length).toBeLessThanOrEqual(20);
    }
    const written = writes();
    expect(written.get("small")?.intent).toBe("informational");
    expect(written.get("l0")?.intent).toBe("commercial");
    expect(written.get("l99")?.intent).toBe("commercial");
    // Gönderilemeyenler NULL kalır, dilleri yine yazılır.
    expect(written.get("l100")?.intent).toBeNull();
    expect(written.has("l129")).toBe(true);
    expect(written.get("l129")?.intent).toBeNull();
    expect(result.classified).toBe(101);
  });

  it("stops the LLM on BUDGET_EXCEEDED but still writes the rule intents", async () => {
    mocks.queryRaw.mockResolvedValue([
      row("q1", "buy running shoes", 10),
      row("l1", "red sneakers", 80),
    ]);
    mocks.run.mockRejectedValue(new AgentelseError("BUDGET_EXCEEDED", "cap"));
    const result = await classify();
    expect(result.budgetHit).toBe(true);
    expect(result.llmCalls).toBe(1);
    const written = writes();
    expect(written.get("q1")?.intent).toBe("transactional");
    expect(written.get("l1")?.intent).toBeNull();
  });

  it("sends nothing to the LLM without a scope", async () => {
    mocks.queryRaw.mockResolvedValue([row("l1", "red sneakers", 80)]);
    const result = await classify({ scope: null });
    expect(mocks.run).not.toHaveBeenCalled();
    expect(result.llmCalls).toBe(0);
    expect(writes().get("l1")?.intent).toBeNull();
  });

  it("resets navigational and brand intents when the brand hash changed", async () => {
    mocks.queryRaw.mockResolvedValue([]);
    await classify({ intentBrandHash: "old-hash" });
    expect(mocks.queryUpdateMany).toHaveBeenCalledWith({
      where: {
        linkId: "link-1",
        OR: [{ intent: "navigational" }, { isBrand: true }],
      },
      data: { intent: null },
    });
    expect(mocks.stateUpdate).toHaveBeenCalledWith({
      where: { id: "state-1" },
      data: { intentBrandHash: "hash-1" },
    });
  });

  it("keeps intents when the brand hash is unchanged", async () => {
    mocks.queryRaw.mockResolvedValue([]);
    await classify();
    expect(mocks.queryUpdateMany).not.toHaveBeenCalled();
  });
});
