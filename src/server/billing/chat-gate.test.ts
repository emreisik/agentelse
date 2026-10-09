import { beforeEach, describe, expect, it, vi } from "vitest";

// The plan-allowance gate of ONE model round of a chat turn: what it asks the
// operation layer for (the CHAT module, a plan that must be valid, a key of its
// own per round, the size of the hold) and that it asks for nothing while billing
// is off. chat-agent.test.ts replaces this whole module with a mock, so this is
// the only place its wiring is pinned.

const config = vi.hoisted(() => ({
  current: { mode: "off", legacyBefore: null, legacyUntil: null } as {
    mode: "off" | "shadow" | "enforce";
    legacyBefore: Date | null;
    legacyUntil: Date | null;
  },
}));
vi.mock("./config", () => ({ getBillingConfig: () => config.current }));

import type { OperationSpec } from "./operation";

const beginOperation = vi.fn<(spec: OperationSpec) => Promise<unknown>>();
vi.mock("./operation", () => ({ beginOperation }));

const { beginChatRound } = await import("./chat-gate");
const { estimateChatRoundMicros } = await import("./cost-estimate");
const { QuotaExceededError } = await import("./quota-errors");

const round = {
  workspaceId: "ws-7",
  projectId: "proj-8",
  userId: "user-9",
  operationId: "chat:turn-1",
  round: 0,
  model: "gpt-5.6-luna",
  instructions: "You are the agency's chat assistant.",
  conversation: [{ role: "user", content: "Bir instagram postu hazırla" }],
  maxOutputTokens: 8_192,
  webSearch: false,
};

// The spec of the n-th beginOperation call.
function specOf(call: number): OperationSpec {
  const spec = beginOperation.mock.calls[call]?.[0];
  if (!spec) throw new Error(`beginOperation call ${call} did not happen`);
  return spec;
}

beforeEach(() => {
  vi.clearAllMocks();
  beginOperation.mockReset();
  beginOperation.mockResolvedValue({});
  config.current = { mode: "off", legacyBefore: null, legacyUntil: null };
});

describe("beginChatRound", () => {
  it("off: no hold, and nothing is computed or read", async () => {
    // A conversation that throws when anything reads it: with billing off the
    // estimate must not even be started.
    const unreadable = new Proxy([], {
      get() {
        throw new Error("the conversation was read");
      },
      ownKeys() {
        throw new Error("the conversation was read");
      },
    });

    await expect(
      beginChatRound({ ...round, conversation: unreadable }),
    ).resolves.toBeUndefined();
    expect(beginOperation).not.toHaveBeenCalled();
  });

  it.each(["shadow", "enforce"] as const)(
    "%s: holds the round on a chat operation that needs a valid plan",
    async (mode) => {
      config.current = { ...config.current, mode };
      const operation = { meter: {}, finish: vi.fn() };
      beginOperation.mockResolvedValue(operation);

      const hold = await beginChatRound({ ...round, round: 2 });

      // The caller settles exactly the operation the ledger layer returned.
      expect(hold).toBe(operation);
      expect(beginOperation).toHaveBeenCalledTimes(1);
      expect(beginOperation).toHaveBeenCalledWith(
        expect.objectContaining({
          workspaceId: "ws-7",
          projectId: "proj-8",
          userId: "user-9",
          module: "CHAT",
          source: "chat",
          purpose: "chat.turn",
          operationId: "chat:turn-1",
          attemptToken: "round2",
          // Even a round that reserves nothing must not run on a closed plan.
          requireAccess: true,
        }),
      );
      expect(Object.keys(specOf(0).reserve)).toEqual(["AI_MICROS"]);
    },
  );

  it("gives every round of a turn its own key, and a repeated round the same one", async () => {
    config.current = { ...config.current, mode: "enforce" };

    await beginChatRound({ ...round, round: 0 });
    await beginChatRound({ ...round, round: 1 });
    await beginChatRound({ ...round, round: 1 });

    expect(specOf(0).attemptToken).toBe("round0");
    expect(specOf(1).attemptToken).toBe("round1");
    expect(specOf(2).attemptToken).toBe(specOf(1).attemptToken);
    // The turn is one operation; only the attempt token tells its rounds apart.
    expect(specOf(0).operationId).toBe(specOf(1).operationId);
  });

  it("holds the round's maximum: positive, and larger for a longer conversation", async () => {
    config.current = { ...config.current, mode: "enforce" };
    const turn = (chars: number) => [
      { role: "user", content: "x".repeat(chars) },
    ];

    await beginChatRound({ ...round, conversation: turn(3_000) });
    await beginChatRound({ ...round, conversation: turn(30_000) });

    const short = specOf(0).reserve.AI_MICROS;
    const long = specOf(1).reserve.AI_MICROS;
    expect(typeof short).toBe("bigint");
    expect(short).toBeGreaterThan(BigInt(0));
    expect(typeof long).toBe("bigint");
    expect(long).toBeGreaterThan(short ?? BigInt(0));
  });

  it("sizes the hold from this round's model, instructions, conversation, output budget and search", async () => {
    config.current = { ...config.current, mode: "enforce" };
    const sized = {
      model: "gpt-5.4-mini",
      instructions: "i".repeat(900),
      conversation: [{ role: "user", content: "c".repeat(4_500) }],
      maxOutputTokens: 2_000,
      webSearch: true,
    };

    // A later round: what is held comes from the round's own inputs, never from
    // its number.
    await beginChatRound({ ...round, ...sized, round: 3 });

    expect(specOf(0).reserve.AI_MICROS).toBe(estimateChatRoundMicros(sized));
  });

  it("lets the ledger's refusal through, for the chat to show its allowance card", async () => {
    config.current = { ...config.current, mode: "enforce" };
    const refusal = new QuotaExceededError({
      unit: "AI_MICROS",
      needed: 5_000,
      available: 100,
      resetsAt: null,
    });
    beginOperation.mockRejectedValue(refusal);

    await expect(beginChatRound(round)).rejects.toBe(refusal);
  });
});
