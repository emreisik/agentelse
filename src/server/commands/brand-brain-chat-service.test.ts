import { beforeEach, describe, expect, it, vi } from "vitest";

// The core guarantees this file exists to prove: BrandBrainChatService.turn
// (a) always records the turn as a Command tagged topic:"BRAND_BRAIN" (never
// routes through CommandService.submit — no task/approval side effect), (b)
// only stores a proposedRevision on the Command when the reasoning call
// actually returns one, and (c) degrades gracefully (a saved Command with an
// honest error reply) instead of throwing when reasoning fails.

const project = { findUniqueOrThrow: vi.fn() };
const command = { findMany: vi.fn() };
vi.mock("@/lib/prisma", () => ({
  prisma: { project, command },
}));

const getBrandContext = vi.fn().mockResolvedValue({ identity: "Acme" });
vi.mock("@/server/agency/constitution/constitution-service", () => ({
  ConstitutionService: { getBrandContext },
}));

const run = vi.fn();
vi.mock("@/server/reasoning/reasoning-service", () => ({
  ReasoningService: { run },
}));

vi.mock("@/server/reasoning/prompts/brand-brain-chat", () => ({
  brandBrainChatDef: {},
}));

const commandCreate = vi.fn();
const recordReply = vi.fn().mockResolvedValue(undefined);
vi.mock("@/server/repositories/command.repository", () => ({
  CommandRepository: { create: commandCreate, recordReply },
}));

const { BrandBrainChatService, BRAND_BRAIN_TOPIC } =
  await import("./brand-brain-chat-service");

beforeEach(() => {
  vi.clearAllMocks();
  project.findUniqueOrThrow.mockResolvedValue({
    brands: [{ id: "brand-1" }],
  });
  command.findMany.mockResolvedValue([]);
  commandCreate.mockResolvedValue({ id: "cmd-1" });
});

describe("BrandBrainChatService.turn", () => {
  it("records a plain discussion turn with no proposedRevision on the Command", async () => {
    run.mockResolvedValue({
      output: {
        reply: "Tell me more about the direction you have in mind.",
        proposedRevision: null,
        revisionSummary: null,
      },
    });

    const result = await BrandBrainChatService.turn({
      workspaceId: "ws-1",
      projectId: "proj-1",
      userId: "user-1",
      message: "I think our tone is too corporate.",
    });

    expect(commandCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        topic: BRAND_BRAIN_TOPIC,
        source: "WEB",
        rawText: "I think our tone is too corporate.",
        parsedIntent: undefined,
      }),
    );
    expect(recordReply).toHaveBeenCalledWith(
      "cmd-1",
      "Tell me more about the direction you have in mind.",
      "ANSWERED",
    );
    expect(result.proposedRevision).toBeNull();
  });

  it("stores the proposedRevision on the Command's parsedIntent when the model proposes one", async () => {
    const proposedRevision = { toneOfVoice: "Warmer, more conversational" };
    run.mockResolvedValue({
      output: {
        reply: "Here's a concrete update based on what we discussed.",
        proposedRevision,
        revisionSummary: "Shift tone warmer per feedback",
      },
    });

    const result = await BrandBrainChatService.turn({
      workspaceId: "ws-1",
      projectId: "proj-1",
      userId: "user-1",
      message: "Yes, let's make it warmer.",
    });

    expect(commandCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        parsedIntent: {
          proposedRevision,
          revisionSummary: "Shift tone warmer per feedback",
        },
      }),
    );
    expect(result.proposedRevision).toEqual(proposedRevision);
    expect(result.revisionSummary).toBe("Shift tone warmer per feedback");
  });

  it("scopes conversation history to this project's BRAND_BRAIN-topic Commands only", async () => {
    run.mockResolvedValue({
      output: { reply: "ok", proposedRevision: null, revisionSummary: null },
    });

    await BrandBrainChatService.turn({
      workspaceId: "ws-1",
      projectId: "proj-1",
      userId: "user-1",
      message: "hello",
    });

    expect(command.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { projectId: "proj-1", topic: BRAND_BRAIN_TOPIC },
      }),
    );
  });

  it("saves the message with an honest error reply instead of throwing when reasoning fails", async () => {
    run.mockRejectedValue(new Error("provider exploded"));

    const result = await BrandBrainChatService.turn({
      workspaceId: "ws-1",
      projectId: "proj-1",
      userId: "user-1",
      message: "hi",
    });

    expect(result.proposedRevision).toBeNull();
    expect(result.reply).toContain("provider exploded");
    expect(recordReply).toHaveBeenCalledWith(
      "cmd-1",
      expect.any(String),
      "ERROR",
    );
  });

  it("throws when the project has no default brand", async () => {
    project.findUniqueOrThrow.mockResolvedValue({ brands: [] });

    await expect(
      BrandBrainChatService.turn({
        workspaceId: "ws-1",
        projectId: "proj-1",
        userId: "user-1",
        message: "hi",
      }),
    ).rejects.toThrow(/no default brand/);
  });
});
