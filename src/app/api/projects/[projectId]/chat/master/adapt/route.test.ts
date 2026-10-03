import { beforeEach, describe, expect, it, vi } from "vitest";

// Guard 'master-adapt' (W90): the "Adapt to channels" route. The card store is
// the REAL one on top of an in-memory Command row (transactions serialised like
// Serializable), so the claim, the run cap and the write-back are exercised end
// to end; the model side (runMasterAdapt), the rule loader and every other IO
// module are mocked.

vi.mock("server-only", () => ({}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

type Row = {
  id: string;
  projectId: string;
  workId: string | null;
  replyText: string;
  parsedIntent: { card?: unknown; other?: string } | null;
};

let row: Row;
let chain: Promise<unknown> = Promise.resolve();

const tx = {
  command: {
    findUnique: vi.fn(async () => row),
    update: vi.fn(async ({ data }: { data: Partial<Row> }) => {
      row = { ...row, ...data } as Row;
      return row;
    }),
  },
  work: { findFirst: vi.fn() },
};
const transaction = vi.fn((cb: (t: typeof tx) => Promise<unknown>) => {
  const result = chain.then(() => cb(tx));
  chain = result.catch(() => undefined);
  return result;
});
const commandFindFirst = vi.fn();

vi.mock("@/lib/prisma", () => ({
  prisma: {
    $transaction: (...args: unknown[]) =>
      transaction(...(args as [(t: typeof tx) => Promise<unknown>])),
    command: { findFirst: (...args: unknown[]) => commandFindFirst(...args) },
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

const isMockMode = vi.fn();
vi.mock("@/server/reasoning/reasoning-service", () => ({
  ReasoningService: { isMockMode },
}));

const workGet = vi.fn();
vi.mock("@/server/repositories/work.repository", () => ({
  WorkRepository: { get: workGet },
}));

const runMasterAdapt = vi.fn();
vi.mock("@/server/chat/master-content", () => ({ runMasterAdapt }));

const loadBrandRules = vi.fn();
vi.mock("@/server/works/brand-rule-loader", () => ({ loadBrandRules }));

const ruleLanguageOf = vi.fn();
vi.mock("@/server/brand/rule-language", () => ({
  brandRuleLanguageOf: ruleLanguageOf,
}));

vi.mock("@/server/integrations/channel-connections", () => ({
  getChannelConnections: vi.fn(async () => ({})),
}));

const auditRecord = vi.fn();
vi.mock("@/server/repositories/audit-log.repository", () => ({
  AuditLogRepository: { record: auditRecord },
}));

const { POST } = await import("./route");
const { AgentelseError } = await import("@/server/security/errors");
const { ADAPT_CLAIM_TTL_MS, MAX_ADAPT_RUNS } = await import(
  "@/lib/works/master-content"
);

const params = { params: Promise.resolve({ projectId: "proj-1" }) };

function request(body: unknown, headers?: Record<string, string>) {
  return new Request(
    "http://localhost/api/projects/proj-1/chat/master/adapt",
    {
      method: "POST",
      headers: { "Content-Type": "application/json", ...headers },
      body: typeof body === "string" ? body : JSON.stringify(body),
    },
  );
}

const valid = { commandId: "cmd-1" };

type Adaptation = { topic: string; captionIdea: string; issues?: string[] };
type Target = {
  channel: string;
  formatKey: string;
  included: boolean;
  adaptation?: Adaptation;
};

function masterCard(over: Record<string, unknown> = {}) {
  return {
    kind: "master-content",
    title: "Autumn menu",
    state: "draft",
    master: { title: "Autumn menu", message: "The autumn menu is here." },
    targets: [
      { channel: "instagram", formatKey: "instagram.post", included: true },
      { channel: "linkedin", formatKey: "linkedin.post", included: true },
      { channel: "x", formatKey: "x.post", included: false },
    ] as Target[],
    ...over,
  };
}

function setCard(card: unknown, over: Partial<Row> = {}) {
  row = {
    id: "cmd-1",
    projectId: "proj-1",
    workId: "work-1",
    replyText: "reply",
    parsedIntent: { card, other: "keep" },
    ...over,
  };
}

type Stored = ReturnType<typeof masterCard> & {
  adaptRuns?: number;
  adapting?: { startedAt: string };
};
function storedCard() {
  return row.parsedIntent?.card as Stored;
}

// What runMasterAdapt answers: the claimed card with adaptations on the asked
// targets (the real function never touches included / formatKey).
function adaptedFrom(
  input: { card: ReturnType<typeof masterCard> },
  issues?: string[],
) {
  return {
    ok: true as const,
    card: {
      ...input.card,
      state: "adapted",
      targets: input.card.targets.map((target) =>
        target.included
          ? {
              ...target,
              adaptation: {
                topic: `${target.channel} topic`,
                captionIdea: `${target.channel} caption`,
                ...(issues ? { issues } : {}),
              },
            }
          : target,
      ),
    },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  chain = Promise.resolve();
  isWorksEnabled.mockReturnValue(true);
  requireUser.mockResolvedValue({ userId: "user-1", email: null });
  requireProjectAccess.mockResolvedValue({
    workspaceId: "ws-1",
    projectId: "proj-1",
    defaultBrandId: "brand-1",
  });
  isRateLimited.mockReturnValue(false);
  isMockMode.mockReturnValue(false);
  workGet.mockResolvedValue({
    id: "work-1",
    status: "ACTIVE",
    channels: ["instagram", "linkedin", "x"],
  });
  tx.work.findFirst.mockResolvedValue({ status: "ACTIVE" });
  ruleLanguageOf.mockResolvedValue("tr");
  loadBrandRules.mockResolvedValue({
    language: "tr",
    never: [],
    approvedClaims: [],
    competitors: [],
  });
  auditRecord.mockResolvedValue(undefined);
  runMasterAdapt.mockImplementation(async (input) => adaptedFrom(input));
  setCard(masterCard());
  commandFindFirst.mockImplementation(
    async ({ where }: { where: { id: string; projectId: string } }) =>
      where.id === row.id && where.projectId === row.projectId ? row : null,
  );
});

describe("master-adapt: auth, scoping and body", () => {
  it("returns 404 when Works is off, before anything else", async () => {
    isWorksEnabled.mockReturnValue(false);
    const response = await POST(request(valid), params);
    expect(response.status).toBe(404);
    expect(requireUser).not.toHaveBeenCalled();
    expect(commandFindFirst).not.toHaveBeenCalled();
    expect(runMasterAdapt).not.toHaveBeenCalled();
  });

  it("returns 401 without a session", async () => {
    requireUser.mockRejectedValue(
      new AgentelseError("LOGIN_REQUIRED", "Authentication required"),
    );
    const response = await POST(request(valid), params);
    expect(response.status).toBe(401);
    expect(commandFindFirst).not.toHaveBeenCalled();
  });

  it("returns 404 for a project the user cannot access", async () => {
    requireProjectAccess.mockRejectedValue(
      new AgentelseError("NOT_FOUND", "Project not found"),
    );
    const response = await POST(request(valid), params);
    expect(response.status).toBe(404);
    expect(commandFindFirst).not.toHaveBeenCalled();
  });

  it("rejects a wrong content type with 415 before any lookup", async () => {
    const response = await POST(
      request(JSON.stringify(valid), { "Content-Type": "text/plain" }),
      params,
    );
    expect(response.status).toBe(415);
    expect(commandFindFirst).not.toHaveBeenCalled();
    expect(isRateLimited).not.toHaveBeenCalled();
  });

  it("rejects a body over 8 KB with 413 before any lookup", async () => {
    const response = await POST(
      request({ commandId: "cmd-1", pad: "x".repeat(9000) }),
      params,
    );
    expect(response.status).toBe(413);
    expect(commandFindFirst).not.toHaveBeenCalled();
    expect(isRateLimited).not.toHaveBeenCalled();
  });

  it("rejects a malformed body with 400", async () => {
    const seven = Array.from({ length: 7 }, () => ({
      channel: "x",
      formatKey: "x.post",
    }));
    for (const body of [
      "not json",
      {},
      { commandId: "" },
      { commandId: 5 },
      { commandId: "x".repeat(65) },
      { commandId: "cmd-1", targets: "instagram" },
      { commandId: "cmd-1", targets: [{ channel: "x".repeat(33), formatKey: "a" }] },
      { commandId: "cmd-1", targets: [{ channel: "x", formatKey: "a".repeat(65) }] },
      { commandId: "cmd-1", targets: seven },
    ]) {
      const response = await POST(request(body), params);
      expect(response.status).toBe(400);
    }
    expect(commandFindFirst).not.toHaveBeenCalled();
    expect(runMasterAdapt).not.toHaveBeenCalled();
  });

  it("returns 429 when the user is rate limited", async () => {
    isRateLimited.mockReturnValue(true);
    const response = await POST(request(valid), params);
    expect(response.status).toBe(429);
    expect(isRateLimited).toHaveBeenCalledWith(
      "master-adapt:user-1",
      6,
      10 * 60_000,
    );
    expect(commandFindFirst).not.toHaveBeenCalled();
  });

  it("looks the command up WITH the project id: another project's command is 404", async () => {
    row = { ...row, projectId: "proj-other" };
    const response = await POST(request(valid), params);
    expect(response.status).toBe(404);
    expect(commandFindFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "cmd-1", projectId: "proj-1" },
      }),
    );
    expect(runMasterAdapt).not.toHaveBeenCalled();
  });

  it("returns 404 for a command that belongs to no Work", async () => {
    row = { ...row, workId: null };
    const response = await POST(request(valid), params);
    expect(response.status).toBe(404);
    expect(runMasterAdapt).not.toHaveBeenCalled();
  });

  it("looks the Work up with the project id and answers 404 for a missing one", async () => {
    workGet.mockResolvedValue(null);
    const response = await POST(request(valid), params);
    expect(response.status).toBe(404);
    expect(workGet).toHaveBeenCalledWith("proj-1", "work-1");
  });

  it("returns 409 when the Work is not active, with no write", async () => {
    workGet.mockResolvedValue({
      id: "work-1",
      status: "DONE",
      channels: ["instagram"],
    });
    const before = JSON.stringify(row);
    const response = await POST(request(valid), params);
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({
      ok: false,
      code: "WORK",
      message: "This Work is completed. Reopen it to continue.",
    });
    expect(transaction).not.toHaveBeenCalled();
    expect(runMasterAdapt).not.toHaveBeenCalled();
    expect(JSON.stringify(row)).toBe(before);
  });

  it("answers WRONG_KIND (409) for a card that was already scheduled, and writes nothing", async () => {
    const scheduled = {
      kind: "content-plan-draft",
      title: "Autumn menu",
      timezone: "Europe/Istanbul",
      state: "saved",
      via: "master",
      items: [],
      savedCreativeIds: [],
    };
    setCard(scheduled);
    const before = JSON.stringify(row);
    const response = await POST(request(valid), params);
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({
      ok: false,
      code: "WRONG_KIND",
    });
    expect(transaction).not.toHaveBeenCalled();
    expect(runMasterAdapt).not.toHaveBeenCalled();
    expect(JSON.stringify(row)).toBe(before);
  });

  it("answers WRONG_KIND (409) for a superseded master card", async () => {
    setCard(masterCard({ state: "superseded" }));
    const response = await POST(request(valid), params);
    expect(response.status).toBe(409);
    expect(runMasterAdapt).not.toHaveBeenCalled();
  });
});

describe("master-adapt: mock mode, claim and cap", () => {
  it("answers MOCK in mock mode and writes nothing", async () => {
    isMockMode.mockReturnValue(true);
    const before = JSON.stringify(row);
    const response = await POST(request(valid), params);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      ok: false,
      code: "MOCK",
      message:
        "Adapting needs the live AI model, which is switched off here. You can still add the message to the calendar as it is.",
    });
    expect(transaction).not.toHaveBeenCalled();
    expect(tx.command.update).not.toHaveBeenCalled();
    expect(runMasterAdapt).not.toHaveBeenCalled();
    expect(JSON.stringify(row)).toBe(before);
  });

  it("refuses BUSY while a younger claim is held, without a model call or a write", async () => {
    setCard(
      masterCard({
        adaptRuns: 1,
        adapting: { startedAt: new Date(Date.now() - 30_000).toISOString() },
      }),
    );
    const before = JSON.stringify(row);
    const response = await POST(request(valid), params);
    expect(await response.json()).toEqual({
      ok: false,
      code: "BUSY",
      message: "Already adapting in another tab.",
    });
    expect(runMasterAdapt).not.toHaveBeenCalled();
    expect(JSON.stringify(row)).toBe(before);
  });

  it("refuses LIMIT once the card used its runs, without a model call", async () => {
    setCard(masterCard({ adaptRuns: MAX_ADAPT_RUNS, state: "adapted" }));
    const response = await POST(request(valid), params);
    expect(await response.json()).toMatchObject({ ok: false, code: "LIMIT" });
    expect(runMasterAdapt).not.toHaveBeenCalled();
    expect(storedCard().adaptRuns).toBe(MAX_ADAPT_RUNS);
  });

  it("does not count an expired claim (a crashed run) against the cap", async () => {
    setCard(
      masterCard({
        adaptRuns: MAX_ADAPT_RUNS,
        adapting: {
          startedAt: new Date(
            Date.now() - ADAPT_CLAIM_TTL_MS - 5_000,
          ).toISOString(),
        },
      }),
    );
    const response = await POST(request(valid), params);
    const body = (await response.json()) as { ok: boolean };
    expect(body.ok).toBe(true);
    expect(runMasterAdapt).toHaveBeenCalledTimes(1);
    // The crashed run gave its run back, this run took it: still at the cap,
    // and the claim is cleared.
    expect(storedCard().adaptRuns).toBe(MAX_ADAPT_RUNS);
    expect(storedCard().adapting).toBeUndefined();
  });

  it("refuses a card with no ticked channel before it spends a run", async () => {
    setCard(
      masterCard({
        targets: [
          { channel: "instagram", formatKey: "instagram.post", included: false },
        ],
      }),
    );
    const response = await POST(request(valid), params);
    expect(await response.json()).toEqual({
      ok: false,
      code: "NO_TARGETS",
      message: "Tick at least one channel.",
    });
    expect(runMasterAdapt).not.toHaveBeenCalled();
    expect(storedCard().adaptRuns).toBeUndefined();
  });

  it("claims with adapting.startedAt and one more run BEFORE the model is called", async () => {
    let claimDuringRun: Stored | undefined;
    runMasterAdapt.mockImplementation(async (input) => {
      claimDuringRun = storedCard();
      return adaptedFrom(input);
    });
    await POST(request(valid), params);
    expect(claimDuringRun?.adaptRuns).toBe(1);
    expect(claimDuringRun?.adapting?.startedAt).toEqual(expect.any(String));
  });

  it("two parallel calls reach the model once", async () => {
    let release: () => void = () => undefined;
    runMasterAdapt.mockImplementation(
      (input) =>
        new Promise((resolve) => {
          release = () => resolve(adaptedFrom(input));
        }),
    );
    const first = POST(request(valid), params);
    const second = POST(request(valid), params);
    // The loser answers BUSY while the winner is still in the model call.
    const loser = await Promise.race([first, second]);
    expect(await loser.json()).toMatchObject({ ok: false, code: "BUSY" });
    release();
    const winner = loser === (await first) ? await second : await first;
    expect(((await winner.json()) as { ok: boolean }).ok).toBe(true);
    expect(runMasterAdapt).toHaveBeenCalledTimes(1);
    expect(storedCard().adaptRuns).toBe(1);
  });

  it("hands the model the claimed card, the requested targets, the language and the rules", async () => {
    const targets = [{ channel: "instagram", formatKey: "instagram.post" }];
    await POST(request({ commandId: "cmd-1", targets }), params);
    const input = runMasterAdapt.mock.calls[0]?.[0] as {
      scope: unknown;
      commandId: string;
      targets: unknown;
      language: string;
      rules: unknown;
      card: Stored;
    };
    expect(input.scope).toEqual({
      workspaceId: "ws-1",
      projectId: "proj-1",
      brandId: "brand-1",
    });
    expect(input.commandId).toBe("cmd-1");
    expect(input.targets).toEqual(targets);
    expect(input.language).toBe("tr");
    expect(input.rules).toMatchObject({ language: "tr" });
    expect(input.card.adaptRuns).toBe(1);
  });
});

describe("master-adapt: write-back", () => {
  it("writes only adaptations and state, clears the claim, keeps the rest of the row", async () => {
    const response = await POST(request(valid), params);
    const body = (await response.json()) as {
      ok: boolean;
      card: Stored;
    };
    expect(body.ok).toBe(true);
    expect(body.card.state).toBe("adapted");
    const card = storedCard();
    expect(card.state).toBe("adapted");
    expect(card.adapting).toBeUndefined();
    expect(card.adaptRuns).toBe(1);
    expect(card.master).toEqual({
      title: "Autumn menu",
      message: "The autumn menu is here.",
    });
    expect(card.targets.map((t) => [t.channel, t.formatKey, t.included])).toEqual(
      [
        ["instagram", "instagram.post", true],
        ["linkedin", "linkedin.post", true],
        ["x", "x.post", false],
      ],
    );
    expect(card.targets[0]?.adaptation).toEqual({
      topic: "instagram topic",
      captionIdea: "instagram caption",
    });
    expect(card.targets[2]?.adaptation).toBeUndefined();
    // Other keys of the row stay.
    expect(row.parsedIntent?.other).toBe("keep");
    expect(auditRecord).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "master_content.adapted",
        entityId: "cmd-1",
        metadata: { targets: 2 },
      }),
    );
  });

  it("puts the brand-rule issues on the rows", async () => {
    runMasterAdapt.mockImplementation(async (input) =>
      adaptedFrom(input, ["Mentions a banned word."]),
    );
    await POST(request(valid), params);
    expect(storedCard().targets[0]?.adaptation?.issues).toEqual([
      "Mentions a banned word.",
    ]);
  });

  it("keeps a tick toggled while the model was thinking, and an adaptation it did not touch", async () => {
    setCard(
      masterCard({
        state: "adapted",
        targets: [
          {
            channel: "instagram",
            formatKey: "instagram.post",
            included: true,
            adaptation: { topic: "old topic", captionIdea: "old caption" },
          },
          { channel: "linkedin", formatKey: "linkedin.post", included: true },
        ],
      }),
    );
    runMasterAdapt.mockImplementation(async (input) => {
      // Re-adapt of linkedin only; meanwhile the person unticks instagram.
      const card = storedCard();
      // A fresh object, like a database round trip would give.
      row = {
        ...row,
        parsedIntent: {
          ...row.parsedIntent,
          card: {
            ...card,
            targets: card.targets.map((t, i) =>
              i === 0 ? { ...t, included: false } : t,
            ),
          },
        },
      };
      return {
        ok: true,
        card: {
          ...input.card,
          targets: input.card.targets.map((t: Target) =>
            t.channel === "linkedin"
              ? { ...t, adaptation: { topic: "li", captionIdea: "li cap" } }
              : t,
          ),
        },
      };
    });
    await POST(
      request({
        commandId: "cmd-1",
        targets: [{ channel: "linkedin", formatKey: "linkedin.post" }],
      }),
      params,
    );
    const [ig, li] = storedCard().targets;
    expect(ig?.included).toBe(false);
    expect(ig?.adaptation).toEqual({
      topic: "old topic",
      captionIdea: "old caption",
    });
    expect(li?.adaptation).toEqual({ topic: "li", captionIdea: "li cap" });
  });

  it("never overwrites a card that was scheduled while the model was thinking", async () => {
    const plan = {
      kind: "content-plan-draft",
      title: "Autumn menu",
      timezone: "Europe/Istanbul",
      state: "saved",
      via: "master",
      items: [],
      savedCreativeIds: [],
    };
    runMasterAdapt.mockImplementation(async (input) => {
      row = { ...row, parsedIntent: { ...row.parsedIntent, card: plan } };
      return adaptedFrom(input);
    });
    const response = await POST(request(valid), params);
    expect(await response.json()).toMatchObject({
      ok: false,
      code: "FAILED",
      message: "Couldn't adapt the message. Try again.",
    });
    expect(row.parsedIntent?.card).toEqual(plan);
    expect(auditRecord).not.toHaveBeenCalled();
  });

  it("re-checks the Work inside the claim write: a Work completed after the first read gets no model call (guard R10)", async () => {
    tx.work.findFirst.mockResolvedValue({ status: "DONE" });
    const response = await POST(request(valid), params);
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ ok: false, code: "WORK" });
    expect(runMasterAdapt).not.toHaveBeenCalled();
    expect(storedCard().adapting).toBeUndefined();
  });

  it("re-checks the Work inside the result write: a Work completed while the model thought gets no adaptations", async () => {
    runMasterAdapt.mockImplementation(async (input) => {
      tx.work.findFirst.mockResolvedValue({ status: "DONE" });
      return adaptedFrom(input);
    });
    const response = await POST(request(valid), params);
    expect(await response.json()).toMatchObject({ ok: false });
    expect(
      storedCard().targets.every((target) => target.adaptation === undefined),
    ).toBe(true);
    expect(auditRecord).not.toHaveBeenCalled();
  });

  it("does not write into a card a newer master superseded meanwhile", async () => {
    runMasterAdapt.mockImplementation(async (input) => {
      const card = storedCard();
      row = {
        ...row,
        parsedIntent: {
          ...row.parsedIntent,
          card: { ...card, state: "superseded" },
        },
      };
      return adaptedFrom(input);
    });
    const response = await POST(request(valid), params);
    expect(await response.json()).toMatchObject({ ok: false, code: "FAILED" });
    expect(storedCard().state).toBe("superseded");
    expect(
      storedCard().targets.every((target) => target.adaptation === undefined),
    ).toBe(true);
  });
});

describe("master-adapt: failure gives the claim back", () => {
  it("clears the claim but keeps the run counted after a validated model failure", async () => {
    runMasterAdapt.mockResolvedValue({
      ok: false,
      code: "FAILED",
      message: "Couldn't adapt the message. Try again.",
    });
    setCard(masterCard({ adaptRuns: 1 }));
    const response = await POST(request(valid), params);
    expect(await response.json()).toEqual({
      ok: false,
      code: "FAILED",
      message: "Couldn't adapt the message. Try again.",
    });
    // 1 + the claimed run: the paid call is not refunded.
    expect(storedCard().adaptRuns).toBe(2);
    expect(storedCard().adapting).toBeUndefined();
    expect(storedCard().state).toBe("draft");
    expect(auditRecord).not.toHaveBeenCalled();
  });

  it("refunds the run when no model answer was spent (BUDGET, NOTHING, MOCK)", async () => {
    for (const code of ["BUDGET", "NOTHING", "MOCK"] as const) {
      setCard(masterCard({ adaptRuns: 1 }));
      runMasterAdapt.mockResolvedValue({ ok: false, code, message: "x" });
      await POST(request(valid), params);
      expect(storedCard().adaptRuns).toBe(1);
      expect(storedCard().adapting).toBeUndefined();
    }
  });

  it("refunds the run when the brand rules fail to load, before any model call", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    loadBrandRules.mockRejectedValueOnce(new Error("rules down"));
    const response = await POST(request(valid), params);
    expect(await response.json()).toMatchObject({ ok: false, code: "FAILED" });
    expect(runMasterAdapt).not.toHaveBeenCalled();
    expect(storedCard().adaptRuns).toBe(0);
    expect(storedCard().adapting).toBeUndefined();
  });

  it("clears the claim but keeps the run counted when the model side throws", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    runMasterAdapt.mockRejectedValue(new Error("boom"));
    const response = await POST(request(valid), params);
    expect(await response.json()).toMatchObject({ ok: false, code: "FAILED" });
    expect(storedCard().adaptRuns).toBe(1);
    expect(storedCard().adapting).toBeUndefined();
  });

  it("leaves the claim of a run that took over after ours expired", async () => {
    runMasterAdapt.mockImplementation(async () => {
      // Our claim expired and another tab claimed: its stamp is on the card.
      const card = storedCard();
      row = {
        ...row,
        parsedIntent: {
          ...row.parsedIntent,
          card: {
            ...card,
            adaptRuns: 2,
            adapting: { startedAt: "2099-01-01T00:00:00.000Z" },
          },
        },
      };
      return { ok: false, code: "FAILED", message: "x" };
    });
    await POST(request(valid), params);
    expect(storedCard().adapting).toEqual({
      startedAt: "2099-01-01T00:00:00.000Z",
    });
    expect(storedCard().adaptRuns).toBe(2);
  });
});
