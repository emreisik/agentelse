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
const commandCreate = vi.fn();
vi.mock("@/lib/prisma", () => ({
  prisma: {
    task: { findUnique: taskFindUnique },
    command: {
      findFirst: commandFindFirst,
      findUnique: commandFindUnique,
      update: commandUpdate,
      create: commandCreate,
    },
  },
}));

let worksOn = true;
vi.mock("@/server/works/flag", () => ({ isWorksEnabled: () => worksOn }));

const { IdeaChatRepository } = await import("./idea-chat.repository");

beforeEach(() => {
  vi.clearAllMocks();
  worksOn = true;
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
    const updateArg = commandUpdate.mock.calls[0]![0];
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
    const updateArg = commandUpdate.mock.calls[0]![0];
    expect(updateArg.data.parsedIntent.card.status).toBe("PUBLISHED");
    expect(updateArg.data.parsedIntent.card.publishState).toBe("published");
    expect(updateArg.data.parsedIntent.card.publishedAt).toBe(
      "2026-01-01T00:00:00.000Z",
    );
  });
});

describe("IdeaChatRepository.postSystemMessage: which Work it lands in", () => {
  const base = {
    workspaceId: "ws-1",
    projectId: "proj-1",
    ideaId: null,
    text: "done",
  };

  it("takes the Work of the Command that started the task", async () => {
    taskFindUnique.mockResolvedValue({ commandId: "cmd-1" });
    commandFindUnique.mockResolvedValue({ workId: "work-7" });
    await IdeaChatRepository.postSystemMessage({ ...base, taskId: "task-1" });
    expect(commandCreate.mock.calls[0]?.[0].data.workId).toBe("work-7");
  });

  it("flag off: no Work lookup at all, the row is one plain insert", async () => {
    worksOn = false;
    taskFindUnique.mockResolvedValue({ commandId: "cmd-1" });
    commandFindUnique.mockResolvedValue({ workId: "work-7" });
    await IdeaChatRepository.postSystemMessage({ ...base, taskId: "task-1" });
    expect(taskFindUnique).not.toHaveBeenCalled();
    expect(commandFindUnique).not.toHaveBeenCalled();
    expect(commandCreate.mock.calls[0]?.[0].data).not.toHaveProperty("workId");
  });

  it("a failing Work lookup still posts the message (outside any Work)", async () => {
    taskFindUnique.mockRejectedValue(new Error("db blip"));
    await IdeaChatRepository.postSystemMessage({ ...base, taskId: "task-1" });
    expect(commandCreate).toHaveBeenCalledTimes(1);
    expect(commandCreate.mock.calls[0]?.[0].data).not.toHaveProperty("workId");
  });

  it("an explicit workId wins and is not looked up", async () => {
    await IdeaChatRepository.postSystemMessage({
      ...base,
      workId: "work-2",
      taskId: "task-1",
    });
    expect(commandCreate.mock.calls[0]?.[0].data.workId).toBe("work-2");
    expect(taskFindUnique).not.toHaveBeenCalled();
  });

  it("a task whose Command has no Work (legacy/background) writes no workId", async () => {
    taskFindUnique.mockResolvedValue({ commandId: "cmd-1" });
    commandFindUnique.mockResolvedValue({ workId: null });
    await IdeaChatRepository.postSystemMessage({ ...base, taskId: "task-1" });
    expect(commandCreate.mock.calls[0]?.[0].data).not.toHaveProperty("workId");
  });

  it("without a task or a Work the row is exactly as before", async () => {
    await IdeaChatRepository.postSystemMessage(base);
    expect(commandCreate.mock.calls[0]?.[0].data).not.toHaveProperty("workId");
  });
});
