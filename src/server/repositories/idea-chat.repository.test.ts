import { beforeEach, describe, expect, it, vi } from "vitest";

// markCreativePublishState (the "one evolving card, not five chat bubbles
// for one publish" mechanism — see its own comment in idea-chat.repository)
// is the one piece of this file worth a dedicated unit test: its whole
// contract is "found a matching creative-ready row -> update in place,
// return true" vs "nothing to attach to -> no-op, return false", and every
// call site in publish-creative.ts/execution-service.ts/task.repository.ts
// depends on that boolean to decide whether to fall back to its own
// pre-existing chat message.

const taskFindUnique = vi.fn();
const commandFindFirst = vi.fn();
const commandFindUnique = vi.fn();
const commandUpdate = vi.fn();
vi.mock("@/lib/prisma", () => ({
  prisma: {
    task: { findUnique: taskFindUnique },
    command: {
      findFirst: commandFindFirst,
      findUnique: commandFindUnique,
      update: commandUpdate,
    },
  },
}));

const { IdeaChatRepository } = await import("./idea-chat.repository");

beforeEach(() => {
  vi.clearAllMocks();
  // No commandId/workPlanId on the task -> resolveIdeaIdForTask resolves to
  // null, same as an orphan/idea-less task. Each test overrides this when
  // ideaId resolution matters.
  taskFindUnique.mockResolvedValue(null);
});

describe("IdeaChatRepository.markCreativePublishState", () => {
  it("returns false and writes nothing when no creative-ready row matches", async () => {
    commandFindFirst.mockResolvedValue(null);

    const result = await IdeaChatRepository.markCreativePublishState({
      taskId: "task-1",
      creativeId: "creative-1",
      publishState: "publishing",
    });

    expect(result).toBe(false);
    expect(commandUpdate).not.toHaveBeenCalled();
  });

  it("returns false and writes nothing when the matching row isn't a creative-ready card", async () => {
    commandFindFirst.mockResolvedValue({
      id: "cmd-1",
      parsedIntent: { card: { kind: "task-running", taskId: "task-1" } },
    });

    const result = await IdeaChatRepository.markCreativePublishState({
      taskId: "task-1",
      creativeId: "creative-1",
      publishState: "publishing",
    });

    expect(result).toBe(false);
    expect(commandUpdate).not.toHaveBeenCalled();
  });

  it("updates the matching creative-ready row in place and returns true", async () => {
    commandFindFirst.mockResolvedValue({
      id: "cmd-1",
      parsedIntent: {
        card: {
          kind: "creative-ready",
          creativeId: "creative-1",
          title: "A post",
          status: "APPROVED",
        },
        departmentKey: "SOCIAL_MEDIA",
      },
    });

    const result = await IdeaChatRepository.markCreativePublishState({
      taskId: "task-1",
      creativeId: "creative-1",
      publishState: "publishing",
    });

    expect(result).toBe(true);
    expect(commandUpdate).toHaveBeenCalledTimes(1);
    const updateArg = commandUpdate.mock.calls[0][0];
    expect(updateArg.where).toEqual({ id: "cmd-1" });
    expect(updateArg.data.parsedIntent.card).toMatchObject({
      kind: "creative-ready",
      creativeId: "creative-1",
      title: "A post",
      status: "APPROVED",
      publishState: "publishing",
    });
    expect(updateArg.data.parsedIntent.departmentKey).toBe("SOCIAL_MEDIA");
  });

  it("also flips the card's own status to PUBLISHED when publishState is published", async () => {
    commandFindFirst.mockResolvedValue({
      id: "cmd-1",
      parsedIntent: {
        card: {
          kind: "creative-ready",
          creativeId: "creative-1",
          title: "A post",
          status: "APPROVED",
        },
      },
    });

    const result = await IdeaChatRepository.markCreativePublishState({
      taskId: "task-1",
      creativeId: "creative-1",
      publishState: "published",
      publishedAt: new Date("2026-01-01T00:00:00.000Z"),
    });

    expect(result).toBe(true);
    const updateArg = commandUpdate.mock.calls[0][0];
    expect(updateArg.data.parsedIntent.card.status).toBe("PUBLISHED");
    expect(updateArg.data.parsedIntent.card.publishState).toBe("published");
    expect(updateArg.data.parsedIntent.card.publishedAt).toBe(
      "2026-01-01T00:00:00.000Z",
    );
  });
});
