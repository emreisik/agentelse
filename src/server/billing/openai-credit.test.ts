import { beforeEach, describe, expect, it, vi } from "vitest";

const env = {
  OPENAI_CREDIT_BALANCE: "9.88",
  OPENAI_CREDIT_BALANCE_AS_OF: "2026-09-29T16:17:00Z",
};
vi.mock("@/lib/env", () => ({ getEnv: () => env }));

const aggregate = vi.fn();
vi.mock("@/lib/prisma", () => ({
  prisma: { reasoningCall: { aggregate } },
}));

// The module keeps a "warned once" flag, so each test gets a fresh copy.
async function load() {
  vi.resetModules();
  return (await import("./openai-credit")).getOpenAiCredit;
}

beforeEach(() => {
  vi.clearAllMocks();
  env.OPENAI_CREDIT_BALANCE = "9.88";
  env.OPENAI_CREDIT_BALANCE_AS_OF = "2026-09-29T16:17:00Z";
  aggregate.mockResolvedValue({ _sum: { costUsd: 0.5 } });
});

describe("getOpenAiCredit", () => {
  it("subtracts spend recorded since the snapshot from the snapshot", async () => {
    const credit = await (await load())();

    expect(credit).toEqual({
      balance: 9.38,
      spent: 0.5,
      snapshot: 9.88,
      asOf: "2026-09-29T16:17:00.000Z",
    });
    expect(aggregate).toHaveBeenCalledWith({
      where: {
        isMock: false,
        model: { startsWith: "gpt-" },
        createdAt: { gte: new Date("2026-09-29T16:17:00Z") },
      },
      _sum: { costUsd: true },
    });
  });

  it("treats no recorded spend as zero", async () => {
    aggregate.mockResolvedValue({ _sum: { costUsd: null } });

    expect(await (await load())()).toMatchObject({ balance: 9.88, spent: 0 });
  });

  it("floors at zero but still reports the spend and snapshot, so the UI can tell the snapshot ran out", async () => {
    aggregate.mockResolvedValue({ _sum: { costUsd: 12.4 } });

    expect(await (await load())()).toMatchObject({
      balance: 0,
      spent: 12.4,
      snapshot: 9.88,
    });
  });

  it("shows nothing when no usable snapshot balance is configured", async () => {
    env.OPENAI_CREDIT_BALANCE = "";

    expect(await (await load())()).toBeNull();
    expect(aggregate).not.toHaveBeenCalled();
  });

  it("warns once when the snapshot date is unreadable instead of failing silently", async () => {
    env.OPENAI_CREDIT_BALANCE_AS_OF = ", CHAT_WEB_SEARCH=false";
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const getOpenAiCredit = await load();

    const first = await getOpenAiCredit();
    await getOpenAiCredit();

    expect(first?.asOf).toBe("1970-01-01T00:00:00.000Z");
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]![0]).toContain("OPENAI_CREDIT_BALANCE_AS_OF");
  });
});
