import { beforeEach, describe, expect, it, vi } from "vitest";

// Guard W54 (publish-idempotent): with Works on, publishCreativeCore refuses a
// foreign project, an unapproved piece and a LinkedIn-only project, serializes
// on the creative with an advisory lock inside a transaction, refuses a second
// post while a publish Task exists (creating no second Task), lets a retry
// through after a FAILED Task, and ignores the client-supplied format for a
// catalog Instagram piece. Flag off: no transaction, today's behaviour.

type TaskRow = { payload: { creativeId: string }; status: string };
let tasks: TaskRow[] = [];
const events: string[] = [];

const creativeFindUnique = vi.fn();
const commandUpdate = vi.fn();
const executeRaw = vi.fn();
const txTaskFindMany = vi.fn();

// A one-at-a-time gate stands in for the advisory lock: transactions queue up
// the way pg_advisory_xact_lock makes them.
let gate: Promise<unknown> = Promise.resolve();
const transaction = vi.fn(
  async (
    fn: (tx: unknown) => Promise<unknown>,
    options: { timeout: number; maxWait: number },
  ) => {
    void options;
    const run = gate.then(() =>
      fn({
        $executeRaw: executeRaw,
        task: { findMany: txTaskFindMany },
      }),
    );
    gate = run.catch(() => undefined);
    return run;
  },
);

vi.mock("@/lib/prisma", () => ({
  prisma: {
    creative: { findUnique: creativeFindUnique },
    command: { update: commandUpdate },
    $transaction: transaction,
  },
}));

const submit = vi.fn();
vi.mock("@/server/commands/command-service", () => ({
  CommandService: { submit },
}));
vi.mock("@/server/repositories/command.repository", () => ({
  CommandRepository: { recordReply: vi.fn().mockResolvedValue(undefined) },
}));
vi.mock("@/server/repositories/idea-chat.repository", () => ({
  IdeaChatRepository: {
    resolveIdeaIdForTask: vi.fn().mockResolvedValue(null),
    markCreativePublishState: vi.fn().mockResolvedValue(true),
  },
}));
vi.mock("@/server/security/asset-public-link", () => ({
  buildAssetPublicUrl: vi.fn().mockResolvedValue("https://img/1.png"),
}));
const getPublishTargets = vi.fn();
vi.mock("@/server/integrations/meta-connection-status", () => ({
  getPublishTargets,
}));
let worksOn = true;
vi.mock("@/server/works/flag", () => ({ isWorksEnabled: () => worksOn }));

const { publishCreativeCore } = await import("./publish-creative");

const base = {
  creativeId: "c1",
  format: "FEED" as const,
  workspaceId: "ws",
  projectId: "p1",
  actorUserId: "u1",
};

function creative(over: Record<string, unknown> = {}) {
  creativeFindUnique.mockResolvedValue({
    id: "c1",
    projectId: "p1",
    status: "APPROVED",
    title: "Post",
    formatKey: "instagram.post",
    createdByTaskId: null,
    versions: [{ assetId: "a1", caption: "hi", copy: null }],
    ...over,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  worksOn = true;
  tasks = [];
  events.length = 0;
  gate = Promise.resolve();
  getPublishTargets.mockResolvedValue([{ platform: "instagram" }]);
  creative();
  // Mirrors `status notIn [FAILED, CANCELLED]` of the real query.
  txTaskFindMany.mockImplementation(async () =>
    tasks.filter((t) => t.status !== "FAILED" && t.status !== "CANCELLED"),
  );
  executeRaw.mockImplementation(async () => {
    events.push("lock");
  });
  submit.mockImplementation(async () => {
    events.push("submit");
    // A slow submit, so a racing second call would overlap without the gate.
    await new Promise((resolve) => setTimeout(resolve, 5));
    tasks.push({ payload: { creativeId: "c1" }, status: "QUEUED" });
    return {
      status: "PLANNED",
      requiresApproval: false,
      commandId: "cmd",
      taskId: "t1",
    };
  });
});

describe("publishCreativeCore: flag on", () => {
  it("refuses a LinkedIn-only project asked to post to Instagram", async () => {
    getPublishTargets.mockResolvedValue([{ platform: "linkedin" }]);
    const result = await publishCreativeCore(base);
    expect(result.ok).toBe(false);
    expect(submit).not.toHaveBeenCalled();
  });

  it("refuses another project's creative", async () => {
    creative({ projectId: "other" });
    const result = await publishCreativeCore(base);
    expect(result).toEqual({ ok: false, message: "Creative not found." });
    expect(submit).not.toHaveBeenCalled();
  });

  it("refuses a piece that is not APPROVED", async () => {
    creative({ status: "IN_REVIEW" });
    const result = await publishCreativeCore(base);
    expect(result).toEqual({
      ok: false,
      message: "Approve this piece before posting it.",
    });
    expect(submit).not.toHaveBeenCalled();
  });

  it("refuses an already PUBLISHED piece", async () => {
    creative({ status: "PUBLISHED" });
    const result = await publishCreativeCore(base);
    expect(result).toEqual({
      ok: false,
      message: "This piece is already being posted.",
    });
  });

  it.each(["instagram.carousel", "instagram.reel"])(
    "refuses the hand-posted format %s on the explicit path and creates no Task",
    async (formatKey) => {
      creative({ platform: "INSTAGRAM", formatKey });
      const result = await publishCreativeCore(base);
      expect(result).toEqual({
        ok: false,
        message:
          "This format is posted by hand, so it can't be sent to Instagram from here.",
      });
      expect(submit).not.toHaveBeenCalled();
    },
  );

  it("refuses another channel's piece (LinkedIn) and creates no Task", async () => {
    creative({ platform: "LINKEDIN", formatKey: "linkedin.post" });
    const result = await publishCreativeCore(base);
    expect(result.ok).toBe(false);
    expect(submit).not.toHaveBeenCalled();
  });

  it("lets a catalog feed post and a story through the explicit guard", async () => {
    creative({ platform: "INSTAGRAM", formatKey: "instagram.post" });
    expect((await publishCreativeCore(base)).ok).toBe(true);
    tasks.length = 0;
    creative({ platform: "INSTAGRAM", formatKey: "instagram.story" });
    expect((await publishCreativeCore(base)).ok).toBe(true);
  });

  it("takes the advisory lock first, inside a transaction with a 20 s timeout", async () => {
    const result = await publishCreativeCore(base);
    expect(result.ok).toBe(true);
    expect(transaction).toHaveBeenCalledTimes(1);
    expect(transaction.mock.calls[0]![1]).toEqual({
      timeout: 20_000,
      maxWait: 5_000,
    });
    expect(events).toEqual(["lock", "submit"]);
    const lockCall = executeRaw.mock.calls[0]!;
    expect(String((lockCall[0] as string[]).join("?"))).toContain(
      "pg_advisory_xact_lock(hashtext(",
    );
    expect(lockCall[1]).toBe("c1");
  });

  it("refuses a second post while a publish Task exists and creates no Task", async () => {
    tasks.push({ payload: { creativeId: "c1" }, status: "RUNNING" });
    const result = await publishCreativeCore(base);
    expect(result).toEqual({
      ok: false,
      message: "This piece is already being posted.",
    });
    expect(submit).not.toHaveBeenCalled();
  });

  it("also refuses when the earlier Task is COMPLETED", async () => {
    tasks.push({ payload: { creativeId: "c1" }, status: "COMPLETED" });
    const result = await publishCreativeCore(base);
    expect(result.ok).toBe(false);
    expect(submit).not.toHaveBeenCalled();
  });

  it("a FAILED Task does not block a deliberate retry", async () => {
    tasks.push({ payload: { creativeId: "c1" }, status: "FAILED" });
    const result = await publishCreativeCore(base);
    expect(result.ok).toBe(true);
    expect(submit).toHaveBeenCalledTimes(1);
  });

  it("a Task of another creative does not block", async () => {
    tasks.push({ payload: { creativeId: "other" }, status: "RUNNING" });
    expect((await publishCreativeCore(base)).ok).toBe(true);
  });

  it("two parallel calls create exactly one Task", async () => {
    const [a, b] = await Promise.all([
      publishCreativeCore(base),
      publishCreativeCore(base),
    ]);
    expect([a.ok, b.ok].sort()).toEqual([false, true]);
    expect(submit).toHaveBeenCalledTimes(1);
    expect(tasks).toHaveLength(1);
  });

  it("ignores a client FEED argument for an instagram.story piece", async () => {
    creative({ formatKey: "instagram.story" });
    await publishCreativeCore({ ...base, format: "FEED" });
    expect(submit.mock.calls[0]![0].payloadExtra.targetFormat).toBe("STORIES");
  });

  it("ignores a client STORIES argument for an instagram.post piece", async () => {
    creative({ formatKey: "instagram.post" });
    await publishCreativeCore({ ...base, format: "STORIES" });
    expect(submit.mock.calls[0]![0].payloadExtra.targetFormat).toBeUndefined();
  });

  it("honours the argument for a creative without a catalog formatKey", async () => {
    creative({ formatKey: null });
    await publishCreativeCore({ ...base, format: "STORIES" });
    expect(submit.mock.calls[0]![0].payloadExtra.targetFormat).toBe("STORIES");
  });
});

describe("publishCreativeCore: flag off (parity)", () => {
  beforeEach(() => {
    worksOn = false;
  });

  it("runs without a transaction and trusts the argument", async () => {
    creative({ formatKey: "instagram.post" });
    const result = await publishCreativeCore({ ...base, format: "STORIES" });
    expect(result.ok).toBe(true);
    expect(transaction).not.toHaveBeenCalled();
    expect(submit.mock.calls[0]![0].payloadExtra.targetFormat).toBe("STORIES");
  });

  it("keeps today's loose checks: a foreign or unapproved piece still goes through", async () => {
    creative({ projectId: "other", status: "IN_REVIEW" });
    getPublishTargets.mockResolvedValue([{ platform: "linkedin" }]);
    const result = await publishCreativeCore(base);
    expect(result.ok).toBe(true);
    expect(txTaskFindMany).not.toHaveBeenCalled();
  });
});
