import { beforeEach, describe, expect, it, vi } from "vitest";

// The paid "Make 3 visuals" / "Make 3 more" route. Guard W96: the slot is
// claimed (no live Task, no fresh production claim) BEFORE the dollars are
// reserved, the reserve equals estimateImageCostUsd x VARIANT_COUNT and a
// BUDGET_EXCEEDED creates nothing, one slot only, the alternatives cap and the
// Work state are enforced, the body is bounded. IO modules are mocked; the
// production runner and the plan helpers are the real ones.

vi.mock("server-only", () => ({}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

const calls: string[] = [];
const commandFindFirst = vi.fn();
const commandFindUnique = vi.fn();
const workFindFirst = vi.fn();
const creativeFindFirst = vi.fn();
const creativeVersionFindFirst = vi.fn();
const taskFindMany = vi.fn();

vi.mock("@/lib/prisma", () => ({
  prisma: {
    command: {
      findFirst: (...a: unknown[]) => commandFindFirst(...a),
      findUnique: (...a: unknown[]) => commandFindUnique(...a),
    },
    work: { findFirst: (...a: unknown[]) => workFindFirst(...a) },
    creative: { findFirst: (...a: unknown[]) => creativeFindFirst(...a) },
    creativeVersion: {
      findFirst: (...a: unknown[]) => creativeVersionFindFirst(...a),
    },
    task: {
      findMany: (...a: unknown[]) => {
        calls.push("task.findMany");
        return taskFindMany(...a);
      },
    },
  },
}));

const requireUser = vi.fn();
const requireProjectAccess = vi.fn();
vi.mock("@/server/security/tenant-context", () => ({
  requireUser,
  requireProjectAccess,
}));
const isRateLimited = vi.fn();
vi.mock("@/lib/rate-limit", () => ({ isRateLimited }));
const isWorksEnabled = vi.fn();
vi.mock("@/server/works/flag", () => ({ isWorksEnabled }));

const ensureProjectActive = vi.fn();
vi.mock("@/server/projects/activation", () => ({ ensureProjectActive }));

const checkAndIncrement = vi.fn();
vi.mock("@/server/repositories/autonomy-policy.repository", () => ({
  AutonomyPolicyRepository: {
    checkAndIncrement: (...a: unknown[]) => {
      calls.push("reserve");
      return checkAndIncrement(...a);
    },
  },
}));
const auditRecord = vi.fn().mockResolvedValue(undefined);
vi.mock("@/server/repositories/audit-log.repository", () => ({
  AuditLogRepository: { record: auditRecord },
}));

const planForCapability = vi.fn();
vi.mock("@/server/commands/task-planner", () => ({
  TaskPlanner: {
    planForCapability: (...a: unknown[]) => {
      calls.push("planForCapability");
      return planForCapability(...a);
    },
  },
}));
const driveJobInline = vi.fn();
vi.mock("@/server/chat/inline-job", () => ({ driveJobInline }));

const runSingleSlotVariants = vi.fn();
vi.mock("@/server/chat/plan-run", async (importActual) => {
  const actual = await importActual<typeof import("@/server/chat/plan-run")>();
  return {
    ...actual,
    runSingleSlotVariants: (...a: unknown[]) => {
      calls.push("runSingleSlotVariants");
      return runSingleSlotVariants(...a);
    },
  };
});

const departmentInFocus = vi.fn();
vi.mock("@/server/agency/agency-focus", async (importActual) => {
  const actual =
    await importActual<typeof import("@/server/agency/agency-focus")>();
  return {
    ...actual,
    isDepartmentInFocus: (...a: Parameters<typeof actual.isDepartmentInFocus>) =>
      departmentInFocus(...a),
  };
});

const { POST } = await import("./route");
const { AgentelseError } = await import("@/server/security/errors");
const { estimateImageCostUsd } =
  await import("@/server/reasoning/reasoning-pricing");
const {
  MAX_VARIANT_ALTERNATIVES,
  VARIANT_COST_USD,
  VARIANT_COUNT,
  VARIANT_QUALITY,
} = await import("@/lib/works/variants");
const { RUN_CLAIM_TTL_MS } = await import("@/server/chat/plan-run");
import type { ChatStreamEvent } from "@/server/chat/types";

const params = { params: Promise.resolve({ projectId: "proj-1" }) };

function request(body: unknown, headers?: Record<string, string>) {
  return new Request("http://localhost/api/projects/proj-1/chat/variants", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

const valid = { commandId: "cmd-1", creativeId: "cr-1" };

async function events(res: Response): Promise<ChatStreamEvent[]> {
  const text = await res.text();
  return text
    .split("\n\n")
    .map((frame) => frame.split("\n").find((l) => l.startsWith("data: ")))
    .filter((l): l is string => !!l)
    .map((l) => JSON.parse(l.slice(6)) as ChatStreamEvent);
}

function planCard(over: Record<string, unknown> = {}) {
  return {
    kind: "content-plan-draft",
    state: "saved",
    timezone: "UTC",
    items: [],
    savedCreativeIds: ["cr-1", "cr-2"],
    ...over,
  };
}

function creativeRow(over: Record<string, unknown> = {}) {
  return {
    id: "cr-1",
    status: "DRAFT",
    currentVersionId: null,
    channel: "instagram",
    formatKey: "instagram.post",
    title: "Autumn menu",
    brief: "Warm colours",
    ...over,
  };
}

function setCard(card: unknown) {
  commandFindFirst.mockResolvedValue({
    id: "cmd-1",
    workId: "work-1",
    parsedIntent: { card },
  });
}

async function* oneEvent(): AsyncGenerator<ChatStreamEvent> {
  yield { type: "package.done", started: 1, failed: 0 };
}

beforeEach(() => {
  vi.clearAllMocks();
  calls.length = 0;
  requireUser.mockResolvedValue({ userId: "user-1" });
  requireProjectAccess.mockResolvedValue({
    workspaceId: "ws-1",
    defaultBrandId: "brand-1",
  });
  isRateLimited.mockReturnValue(false);
  isWorksEnabled.mockReturnValue(true);
  departmentInFocus.mockReturnValue(true);
  ensureProjectActive.mockResolvedValue({ usable: true });
  setCard(planCard());
  commandFindUnique.mockResolvedValue({ workId: "work-1" });
  workFindFirst.mockResolvedValue({ status: "ACTIVE", channels: [] });
  creativeFindFirst.mockResolvedValue(creativeRow());
  creativeVersionFindFirst.mockResolvedValue({ generationMetadata: {} });
  taskFindMany.mockResolvedValue([]);
  checkAndIncrement.mockResolvedValue(undefined);
  runSingleSlotVariants.mockImplementation(() => oneEvent());
  planForCapability.mockResolvedValue({
    task: { id: "task-1", riskLevel: "LOW" },
    dispatched: true,
    job: { id: "job-1" },
  });
  driveJobInline.mockResolvedValue({ status: "COMPLETED", errorMessage: null });
});

function nothingPaidOrMade() {
  expect(checkAndIncrement).not.toHaveBeenCalled();
  expect(planForCapability).not.toHaveBeenCalled();
  expect(runSingleSlotVariants).not.toHaveBeenCalled();
}

describe("auth, flag, rate and body", () => {
  it("401 without a user", async () => {
    requireUser.mockRejectedValue(new Error("no session"));
    const res = await POST(request(valid), params);
    expect(res.status).toBe(401);
    nothingPaidOrMade();
  });

  it("404 for a project the user cannot reach", async () => {
    requireProjectAccess.mockRejectedValue(
      new AgentelseError("PERMISSION_DENIED", "no access"),
    );
    const res = await POST(request(valid), params);
    expect(res.status).toBe(404);
    nothingPaidOrMade();
  });

  it("404 with Works off, before the body is read", async () => {
    isWorksEnabled.mockReturnValue(false);
    const res = await POST(request("not json"), params);
    expect(res.status).toBe(404);
    expect(commandFindFirst).not.toHaveBeenCalled();
    nothingPaidOrMade();
  });

  it("429 once the per-user bucket is full, with the documented limit", async () => {
    isRateLimited.mockReturnValue(true);
    const res = await POST(request(valid), params);
    expect(res.status).toBe(429);
    expect(isRateLimited).toHaveBeenCalledWith("variants:user-1", 3, 60_000);
    nothingPaidOrMade();
  });

  it("415 for a non-JSON body, 413 for a huge one, 400 for a bad shape", async () => {
    const wrongType = await POST(
      request(valid, { "Content-Type": "text/plain" }),
      params,
    );
    expect(wrongType.status).toBe(415);

    const huge = await POST(
      request({ ...valid, pad: "x".repeat(20_000) }),
      params,
    );
    expect(huge.status).toBe(413);

    for (const bad of [
      "{nope",
      { commandId: "cmd-1" },
      { ...valid, creativeId: "x".repeat(65) },
      { ...valid, more: "yes" },
    ]) {
      const res = await POST(request(bad), params);
      expect(res.status).toBe(400);
    }
    expect(commandFindFirst).not.toHaveBeenCalled();
    nothingPaidOrMade();
  });
});

describe("what may be made", () => {
  it("looks the plan Command up with the project id; another project's id is a 404", async () => {
    commandFindFirst.mockResolvedValue(null);
    const res = await POST(request(valid), params);
    expect(res.status).toBe(404);
    expect(commandFindFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "cmd-1", projectId: "proj-1" },
      }),
    );
    nothingPaidOrMade();
  });

  it("refuses a Work that is not ACTIVE", async () => {
    workFindFirst.mockResolvedValue({ status: "COMPLETED", channels: [] });
    const res = await POST(request(valid), params);
    expect(res.status).toBe(409);
    nothingPaidOrMade();
  });

  it("refuses a Command that has no Work (legacy plan)", async () => {
    commandFindFirst.mockResolvedValue({
      id: "cmd-1",
      workId: null,
      parsedIntent: { card: planCard() },
    });
    const res = await POST(request(valid), params);
    expect(res.status).toBe(404);
    nothingPaidOrMade();
  });

  it("refuses a plan that is not saved", async () => {
    setCard(planCard({ state: "draft" }));
    const res = await POST(request(valid), params);
    expect(res.status).toBe(409);
    nothingPaidOrMade();
  });

  it("single slot only: a Creative that is not a slot of this plan is a 404", async () => {
    const res = await POST(
      request({ commandId: "cmd-1", creativeId: "other" }),
      params,
    );
    expect(res.status).toBe(404);
    nothingPaidOrMade();
  });

  it("looks the slot up with the project and the plan", async () => {
    await (await POST(request(valid), params)).text();
    expect(creativeFindFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "cr-1", projectId: "proj-1", planId: "cmd-1" },
      }),
    );
  });

  it("refuses a text format: only an image slot can be made in three", async () => {
    creativeFindFirst.mockResolvedValue(
      creativeRow({ channel: "linkedin", formatKey: "linkedin.post" }),
    );
    const out = await events(await POST(request(valid), params));
    expect(out).toEqual([
      expect.objectContaining({ type: "error", code: "STATE" }),
    ]);
    nothingPaidOrMade();
  });

  it("refuses a slot whose department is outside the agency focus (guard V15)", async () => {
    departmentInFocus.mockReturnValue(false);
    const out = await events(await POST(request(valid), params));
    expect(out).toEqual([
      expect.objectContaining({ type: "error", code: "STATE" }),
    ]);
    expect(departmentInFocus).toHaveBeenCalled();
    nothingPaidOrMade();
  });

  it("refuses a slot on a channel the Work no longer covers, before any reserve (guard V16)", async () => {
    workFindFirst.mockResolvedValue({
      status: "ACTIVE",
      channels: ["linkedin"],
    });
    const out = await events(await POST(request(valid), params));
    expect(out).toEqual([
      expect.objectContaining({
        type: "error",
        code: "STATE",
        message: expect.stringContaining("instagram"),
      }),
    ]);
    nothingPaidOrMade();
  });

  it("first set: refuses a piece that already has content", async () => {
    creativeFindFirst.mockResolvedValue(
      creativeRow({ status: "IN_REVIEW", currentVersionId: "v1" }),
    );
    const out = await events(await POST(request(valid), params));
    expect(out[0]).toMatchObject({ type: "error", code: "STATE" });
    nothingPaidOrMade();
  });

  it("second set: refuses a piece that is not in review", async () => {
    const out = await events(
      await POST(request({ ...valid, more: true }), params),
    );
    expect(out[0]).toMatchObject({ type: "error", code: "STATE" });
    nothingPaidOrMade();
  });

  it("a FAILED slot can be tried again", async () => {
    taskFindMany.mockResolvedValue([
      {
        status: "FAILED",
        payload: { planCreativeId: "cr-1" },
        updatedAt: new Date(),
      },
    ]);
    const out = await events(await POST(request(valid), params));
    expect(out[0]).toMatchObject({ type: "package.done" });
    expect(runSingleSlotVariants).toHaveBeenCalledTimes(1);
  });
});

describe("claim before pay (guard W96)", () => {
  it("first set: the live-Task check comes before the reserve, the reserve before the run", async () => {
    const out = await events(await POST(request(valid), params));
    expect(out).toEqual([{ type: "package.done", started: 1, failed: 0 }]);
    expect(calls).toEqual([
      "task.findMany",
      "reserve",
      "runSingleSlotVariants",
    ]);
    expect(runSingleSlotVariants).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: "ws-1",
        projectId: "proj-1",
        brandId: "brand-1",
        userId: "user-1",
        commandId: "cmd-1",
        creativeId: "cr-1",
      }),
    );
  });

  it("a non-terminal Task for the slot refuses the click and pays nothing", async () => {
    taskFindMany.mockResolvedValue([
      {
        status: "RUNNING",
        payload: { planCreativeId: "cr-1" },
        updatedAt: new Date(),
      },
    ]);
    const out = await events(await POST(request(valid), params));
    expect(out[0]).toMatchObject({ type: "error", code: "BUSY" });
    nothingPaidOrMade();
  });

  it("a live Task of ANOTHER slot does not block this one", async () => {
    taskFindMany.mockResolvedValue([
      {
        status: "RUNNING",
        payload: { planCreativeId: "cr-2" },
        updatedAt: new Date(),
      },
    ]);
    const out = await events(await POST(request(valid), params));
    expect(out[0]).toMatchObject({ type: "package.done" });
  });

  it("a fresh production claim refuses the click and pays nothing; a stale one does not", async () => {
    setCard(
      planCard({
        production: {
          state: "running",
          creativeIds: ["cr-2"],
          startedAt: new Date().toISOString(),
        },
      }),
    );
    const busy = await events(await POST(request(valid), params));
    expect(busy[0]).toMatchObject({ type: "error", code: "BUSY" });
    nothingPaidOrMade();

    setCard(
      planCard({
        production: {
          state: "running",
          creativeIds: ["cr-2"],
          startedAt: new Date(
            Date.now() - RUN_CLAIM_TTL_MS - 1000,
          ).toISOString(),
        },
      }),
    );
    const ok = await events(await POST(request(valid), params));
    expect(ok[0]).toMatchObject({ type: "package.done" });
  });

  it("a second click while a run is streaming is refused and pays nothing", async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    runSingleSlotVariants.mockImplementationOnce(async function* () {
      await gate;
      yield { type: "package.done", started: 1, failed: 0 } as ChatStreamEvent;
    });
    const first = await POST(request(valid), params);
    const second = await events(await POST(request(valid), params));
    expect(second[0]).toMatchObject({ type: "error", code: "BUSY" });
    expect(checkAndIncrement).toHaveBeenCalledTimes(1);

    release();
    await first.text();
    // The slot is free again once the run ended.
    const third = await events(await POST(request(valid), params));
    expect(third[0]).toMatchObject({ type: "package.done" });
    expect(checkAndIncrement).toHaveBeenCalledTimes(2);
  });

  it("a refusal frees the per-project slot", async () => {
    taskFindMany.mockResolvedValueOnce([
      {
        status: "RUNNING",
        payload: { planCreativeId: "cr-1" },
        updatedAt: new Date(),
      },
    ]);
    await (await POST(request(valid), params)).text();
    const again = await events(await POST(request(valid), params));
    expect(again[0]).toMatchObject({ type: "package.done" });
  });
});

describe("the dollar reserve", () => {
  it("reserves estimateImageCostUsd x VARIANT_COUNT for a Post (1080x1440, medium)", async () => {
    await (await POST(request(valid), params)).text();
    const expected =
      estimateImageCostUsd({ quality: VARIANT_QUALITY, size: "1080x1440" }) *
      VARIANT_COUNT;
    expect(checkAndIncrement).toHaveBeenCalledWith(
      { workspaceId: "ws-1", projectId: "proj-1", brandId: "brand-1" },
      "reasoningCalls",
      0,
      expected,
    );
  });

  it("reserves the Story price for a Story slot (1080x1920)", async () => {
    creativeFindFirst.mockResolvedValue(
      creativeRow({ formatKey: "instagram.story" }),
    );
    await (await POST(request(valid), params)).text();
    const expected =
      estimateImageCostUsd({ quality: VARIANT_QUALITY, size: "1080x1920" }) *
      VARIANT_COUNT;
    expect(checkAndIncrement.mock.calls[0]?.[3]).toBeCloseTo(expected, 10);
    expect(checkAndIncrement.mock.calls[0]?.[3]).toBeGreaterThan(
      estimateImageCostUsd({ quality: VARIANT_QUALITY, size: "1080x1440" }) *
        VARIANT_COUNT,
    );
  });

  it("BUDGET_EXCEEDED becomes the limit card and creates nothing", async () => {
    checkAndIncrement.mockRejectedValue(
      new AgentelseError("BUDGET_EXCEEDED", "over", {
        meta: { limit: "dailyBudgetUsd", cap: 1, used: 1.2 },
      }),
    );
    const out = await events(await POST(request(valid), params));
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({
      type: "error",
      code: "BUDGET",
      card: { kind: "limit-notice", reason: "daily-budget" },
    });
    expect(runSingleSlotVariants).not.toHaveBeenCalled();
    expect(planForCapability).not.toHaveBeenCalled();
  });

  it("a BUDGET_EXCEEDED on the second set creates no Task either, and frees the slot", async () => {
    creativeFindFirst.mockResolvedValue(
      creativeRow({ status: "IN_REVIEW", currentVersionId: "v1" }),
    );
    checkAndIncrement.mockRejectedValueOnce(
      new AgentelseError("BUDGET_EXCEEDED", "over", {
        meta: { limit: "dailyBudgetUsd", cap: 1, used: 1.2 },
      }),
    );
    const out = await events(
      await POST(request({ ...valid, more: true }), params),
    );
    expect(out[0]).toMatchObject({ code: "BUDGET" });
    expect(planForCapability).not.toHaveBeenCalled();
    const again = await events(
      await POST(request({ ...valid, more: true }), params),
    );
    expect(again.some((e) => e.type === "package.done")).toBe(true);
  });

  it("an inactive project is refused before paying", async () => {
    ensureProjectActive.mockResolvedValue({ usable: false });
    const out = await events(await POST(request(valid), params));
    expect(out[0]).toMatchObject({ code: "PROJECT_INACTIVE" });
    nothingPaidOrMade();
  });
});

describe("second set (Make 3 more)", () => {
  beforeEach(() => {
    creativeFindFirst.mockResolvedValue(
      creativeRow({ status: "IN_REVIEW", currentVersionId: "v1" }),
    );
  });

  const alts = (n: number) => ({
    generationMetadata: {
      alternatives: Array.from({ length: n }, (_, i) => ({ assetId: `a${i}` })),
    },
  });

  it("reserves first, then creates ONE variantsOnly Task, no slot claim", async () => {
    creativeVersionFindFirst.mockResolvedValue(alts(2));
    const out = await events(
      await POST(request({ ...valid, more: true }), params),
    );
    expect(calls).toEqual(["task.findMany", "reserve", "planForCapability"]);
    expect(runSingleSlotVariants).not.toHaveBeenCalled();
    expect(planForCapability).toHaveBeenCalledTimes(1);
    const input = planForCapability.mock.calls[0]?.[0] as {
      commandId: string;
      payloadExtra: Record<string, unknown>;
      capability: string;
    };
    expect(input.commandId).toBe("cmd-1");
    expect(input.capability).toBe("CREATE_SOCIAL_CREATIVE");
    expect(input.payloadExtra).toEqual({
      planCreativeId: "cr-1",
      variantsOnly: true,
      variantCount: VARIANT_COUNT,
      quality: VARIANT_QUALITY,
      contentFormat: "FEED_PORTRAIT",
    });
    expect(out.map((e) => e.type)).toEqual([
      "run.items",
      "item.start",
      "item.done",
      "package.done",
    ]);
    expect(out[0]).toMatchObject({
      type: "run.items",
      items: [{ id: "cr-1", image: true }],
    });
  });

  it("the cap: allowed while alternatives + 3 <= 5, refused beyond, paying nothing", async () => {
    creativeVersionFindFirst.mockResolvedValue(
      alts(MAX_VARIANT_ALTERNATIVES - VARIANT_COUNT),
    );
    const ok = await events(
      await POST(request({ ...valid, more: true }), params),
    );
    expect(ok.some((e) => e.type === "package.done")).toBe(true);

    vi.clearAllMocks();
    creativeVersionFindFirst.mockResolvedValue(
      alts(MAX_VARIANT_ALTERNATIVES - VARIANT_COUNT + 1),
    );
    const refused = await events(
      await POST(request({ ...valid, more: true }), params),
    );
    expect(refused).toEqual([
      expect.objectContaining({
        type: "error",
        code: "LIMIT",
        message: "That's the most options for this piece.",
      }),
    ]);
    expect(checkAndIncrement).not.toHaveBeenCalled();
    expect(planForCapability).not.toHaveBeenCalled();
  });

  it("a live variants Task for the piece refuses a second click", async () => {
    taskFindMany.mockResolvedValue([
      {
        status: "PENDING",
        payload: { planCreativeId: "cr-1", variantsOnly: true },
        updatedAt: new Date(),
      },
    ]);
    const out = await events(
      await POST(request({ ...valid, more: true }), params),
    );
    expect(out[0]).toMatchObject({ code: "BUSY" });
    nothingPaidOrMade();
  });

  it("never creates a Creative or an Approval itself", async () => {
    creativeVersionFindFirst.mockResolvedValue(alts(0));
    await (await POST(request({ ...valid, more: true }), params)).text();
    // The prisma mock has no creative.create / approval at all: a stray write
    // would have thrown. The audit row is the only write of the route.
    expect(auditRecord).toHaveBeenCalledWith(
      expect.objectContaining({ action: "creative.variants_requested" }),
    );
  });
});

describe("price labels stay tied to the cost estimate", () => {
  it("VARIANT_COST_USD matches estimateImageCostUsd x 3 for the real Post 3:4 and Story sizes", () => {
    const post =
      estimateImageCostUsd({ quality: VARIANT_QUALITY, size: "1080x1440" }) *
      VARIANT_COUNT;
    const story =
      estimateImageCostUsd({ quality: VARIANT_QUALITY, size: "1080x1920" }) *
      VARIANT_COUNT;
    expect(VARIANT_COST_USD.post).toBe(Math.round(post * 100) / 100);
    // The per-piece constant is within 0.002 USD of the estimate (cost.test.ts),
    // so the triple is within 0.006 and never understates by more than a cent.
    expect(Math.abs(VARIANT_COST_USD.story - story)).toBeLessThan(0.006);
    expect(Math.abs(VARIANT_COST_USD.post - post)).toBeLessThan(0.006);
  });
});
