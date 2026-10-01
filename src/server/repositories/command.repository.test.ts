import { beforeEach, describe, expect, it, vi } from "vitest";

const findUnique = vi.fn();
const update = vi.fn();
vi.mock("@/lib/prisma", () => ({
  prisma: { command: { findUnique, update } },
}));

const { CommandRepository } = await import("./command.repository");

const CARD = { kind: "content-plan-draft", state: "saved" };

beforeEach(() => {
  vi.clearAllMocks();
  update.mockResolvedValue({});
});

describe("CommandRepository.attachParsedIntentKeepingCard", () => {
  it("keeps the card a slot-first turn already stored", async () => {
    findUnique.mockResolvedValue({ parsedIntent: { card: CARD } });
    await CommandRepository.attachParsedIntentKeepingCard(
      "c1",
      { kind: "CAPABILITY", capability: "CREATE_COPY" },
      "p1",
      "b1",
    );
    expect(update).toHaveBeenCalledWith({
      where: { id: "c1" },
      data: {
        parsedIntent: {
          kind: "CAPABILITY",
          capability: "CREATE_COPY",
          card: CARD,
        },
        projectId: "p1",
        brandId: "b1",
      },
    });
  });

  it("writes the intent as is when the row holds no card", async () => {
    findUnique.mockResolvedValue({ parsedIntent: { kind: "UNKNOWN" } });
    const intent = { kind: "CAPABILITY" };
    await CommandRepository.attachParsedIntentKeepingCard("c1", intent);
    expect(update.mock.calls[0]![0].data.parsedIntent).toBe(intent);
  });

  it("does not let an old card override a card the new value carries", async () => {
    findUnique.mockResolvedValue({ parsedIntent: { card: CARD } });
    const intent = { kind: "X", card: { kind: "plan-brief" } };
    await CommandRepository.attachParsedIntentKeepingCard("c1", intent);
    expect(update.mock.calls[0]![0].data.parsedIntent).toBe(intent);
  });

  it("the plain attach stays a whole overwrite (flag-off behaviour)", async () => {
    await CommandRepository.attachParsedIntent("c1", { kind: "Y" }, "p1");
    expect(findUnique).not.toHaveBeenCalled();
    expect(update.mock.calls[0]![0].data.parsedIntent).toEqual({ kind: "Y" });
  });
});
