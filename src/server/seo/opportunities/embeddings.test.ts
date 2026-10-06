import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { mockEmbedding } from "@/lib/seo/vector";
import { AgentelseError } from "@/server/security/errors";

// Bu dosyanın kanıtladığı: mock kipte SDK hiç kurulmadan deterministik
// vektör döner; anahtar yoksa vektör yok; bütçe aşımı budgetHit; hata
// yolunda sorgu metni ne günlüğe ne ReasoningCall'a yazılır; bekleyen
// sorgular 100'lük partilerle gider.

const mocks = vi.hoisted(() => ({
  ctor: vi.fn(),
  create: vi.fn(),
  env: vi.fn(),
  check: vi.fn(),
  record: vi.fn(),
  mock: vi.fn(),
  queryRaw: vi.fn(),
  link: vi.fn(),
  createMany: vi.fn(),
  stateUpdateMany: vi.fn(),
}));

vi.mock("openai", () => ({
  default: class {
    embeddings = { create: mocks.create };
    constructor(options: unknown) {
      mocks.ctor(options);
    }
  },
}));
vi.mock("@/lib/env", () => ({ getEnv: mocks.env }));
vi.mock("@/server/repositories/autonomy-policy.repository", () => ({
  AutonomyPolicyRepository: { checkAndIncrement: mocks.check },
}));
vi.mock("@/server/repositories/reasoning-call.repository", () => ({
  ReasoningCallRepository: { record: mocks.record },
}));
vi.mock("@/server/integrations/search-console/search-analytics", () => ({
  gscMockMode: mocks.mock,
}));
vi.mock("@/lib/prisma", () => ({
  prisma: {
    $queryRaw: mocks.queryRaw,
    gscSiteLink: { findUnique: mocks.link },
    seoQueryEmbedding: { createMany: mocks.createMany },
    seoEngineState: { updateMany: mocks.stateUpdateMany },
  },
}));

const { embedPendingQueries, embedTexts } = await import("./embeddings");

const SCOPE = { workspaceId: "w1", projectId: "p1", brandId: "b1" };
const SECRET_TEXT = "private search about jane@example.com";

const savedReasoningMode = process.env.AGENTELSE_REASONING_MODE;

beforeEach(() => {
  vi.clearAllMocks();
  delete process.env.AGENTELSE_REASONING_MODE;
  mocks.mock.mockReturnValue(false);
  mocks.env.mockReturnValue({ OPENAI_API_KEY: "sk-test" });
  mocks.check.mockResolvedValue(undefined);
  mocks.record.mockResolvedValue({ id: "rc" });
  mocks.link.mockResolvedValue({ brandTerms: null });
  mocks.createMany.mockImplementation(async (args: { data: unknown[] }) => ({
    count: args.data.length,
  }));
  mocks.stateUpdateMany.mockResolvedValue({ count: 1 });
});

afterEach(() => {
  if (savedReasoningMode === undefined) {
    delete process.env.AGENTELSE_REASONING_MODE;
  } else {
    process.env.AGENTELSE_REASONING_MODE = savedReasoningMode;
  }
});

describe("embedTexts", () => {
  it("returns mock embeddings without constructing the SDK in mock mode", async () => {
    mocks.mock.mockReturnValue(true);
    const result = await embedTexts(["red shoes", "blue shoes"], SCOPE);
    expect(mocks.ctor).not.toHaveBeenCalled();
    expect(mocks.create).not.toHaveBeenCalled();
    expect(result.budgetHit).toBe(false);
    expect(result.vectors?.[0]).toEqual(mockEmbedding("red shoes"));
    expect(result.vectors?.[1]).toEqual(mockEmbedding("blue shoes"));
  });

  it("returns no vectors without an API key", async () => {
    mocks.env.mockReturnValue({ OPENAI_API_KEY: "" });
    const result = await embedTexts(["red shoes"], SCOPE);
    expect(result).toEqual({ vectors: null, budgetHit: false });
    expect(mocks.create).not.toHaveBeenCalled();
    expect(mocks.check).not.toHaveBeenCalled();
  });

  it("reports budgetHit when the daily budget is spent", async () => {
    mocks.check.mockRejectedValue(new AgentelseError("BUDGET_EXCEEDED", "cap"));
    const result = await embedTexts(["red shoes"], SCOPE);
    expect(result).toEqual({ vectors: null, budgetHit: true });
    expect(mocks.create).not.toHaveBeenCalled();
  });

  it("calls OpenAI with 256 dimensions and records the cost", async () => {
    mocks.create.mockResolvedValue({
      data: [{ index: 0, embedding: Array.from({ length: 256 }, () => 0.5) }],
      usage: { total_tokens: 1000 },
    });
    const result = await embedTexts(["red shoes"], SCOPE);
    expect(mocks.create).toHaveBeenCalledWith({
      model: "text-embedding-3-small",
      input: ["red shoes"],
      dimensions: 256,
    });
    expect(result.vectors?.[0]?.length).toBe(256);
    expect(mocks.record).toHaveBeenCalledWith(
      expect.objectContaining({ purpose: "seo.embed", status: "OK" }),
    );
    expect(mocks.check).toHaveBeenLastCalledWith(
      SCOPE,
      "reasoningCalls",
      0,
      expect.any(Number),
    );
  });

  it("logs no query text on failure", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    mocks.create.mockRejectedValue(new Error(`bad input: ${SECRET_TEXT}`));
    const result = await embedTexts([SECRET_TEXT], SCOPE);
    expect(result).toEqual({ vectors: null, budgetHit: false });
    const logged = JSON.stringify(warn.mock.calls);
    expect(logged).not.toContain("jane");
    expect(logged).not.toContain("private search");
    const recorded = JSON.stringify(mocks.record.mock.calls);
    expect(recorded).not.toContain("jane");
    expect(recorded).not.toContain("private search");
    warn.mockRestore();
  });
});

describe("embedPendingQueries", () => {
  it("embeds pending queries in batches of 100", async () => {
    mocks.mock.mockReturnValue(true);
    mocks.queryRaw.mockResolvedValue(
      Array.from({ length: 250 }, (_, i) => ({
        id: `q${i}`,
        text: `query ${i}`,
        impressions: BigInt(20),
      })),
    );
    const result = await embedPendingQueries({
      link: { id: "link-1", projectId: "p1" },
      scope: SCOPE,
      week: "2026-09-21",
      deadline: Date.now() + 60_000,
      now: new Date("2026-10-07T12:00:00.000Z"),
    });
    expect(result).toEqual({ embedded: 250, budgetHit: false });
    expect(
      mocks.createMany.mock.calls.map(
        (call) => (call[0] as { data: unknown[] }).data.length,
      ),
    ).toEqual([100, 100, 50]);
    expect(mocks.createMany).toHaveBeenCalledWith(
      expect.objectContaining({ skipDuplicates: true }),
    );
  });

  it("does nothing without a scope", async () => {
    const result = await embedPendingQueries({
      link: { id: "link-1", projectId: "p1" },
      scope: null,
      week: "2026-09-21",
      deadline: Date.now() + 60_000,
      now: new Date(),
    });
    expect(result).toEqual({ embedded: 0, budgetHit: false });
    expect(mocks.queryRaw).not.toHaveBeenCalled();
  });
});
