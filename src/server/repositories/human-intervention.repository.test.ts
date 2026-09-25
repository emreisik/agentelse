import { beforeEach, describe, expect, it, vi } from "vitest";

// The single-chat consolidation gap this file closes: WAITING_HUMAN
// requests previously posted nothing to chat at all (only a Telegram
// notify) — invisible outside the Human Action Center panel despite being
// architecturally central. create() now also posts a chat card;
// resolve()/transition() resolve that same card in place. Both are
// best-effort — a chat failure must never break the actual state change,
// which is the real thing these methods exist for.

const create = vi.fn();
const findFirst = vi.fn();
const update = vi.fn();
vi.mock("@/lib/prisma", () => ({
  prisma: { humanInterventionRequest: { create, findFirst, update } },
}));

const notifyProjectTelegram = vi.fn().mockResolvedValue(undefined);
vi.mock("@/server/notifications/project-telegram-notifier", () => ({
  notifyProjectTelegram,
}));

const resolveIdeaIdForTask = vi.fn();
const postSystemMessage = vi.fn();
const resolveHumanActionCard = vi.fn();
vi.mock("@/server/repositories/idea-chat.repository", () => ({
  IdeaChatRepository: {
    resolveIdeaIdForTask,
    postSystemMessage,
    resolveHumanActionCard,
  },
}));

const { HumanInterventionRepository } =
  await import("./human-intervention.repository");

beforeEach(() => {
  vi.clearAllMocks();
  notifyProjectTelegram.mockResolvedValue(undefined);
  resolveIdeaIdForTask.mockResolvedValue(null);
  postSystemMessage.mockResolvedValue(undefined);
  resolveHumanActionCard.mockResolvedValue(undefined);
});

describe("HumanInterventionRepository.create", () => {
  it("posts a human-action-required card, resolving the idea via the task", async () => {
    create.mockResolvedValue({ id: "req-1" });
    resolveIdeaIdForTask.mockResolvedValue("idea-1");

    await HumanInterventionRepository.create({
      workspaceId: "ws-1",
      projectId: "proj-1",
      brandId: "brand-1",
      taskId: "task-1",
      type: "OTP_REQUIRED",
      inputType: "OTP",
      title: "Enter the SMS code",
      message: "Sent to +1...",
    });

    expect(resolveIdeaIdForTask).toHaveBeenCalledWith("task-1");
    expect(postSystemMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: "ws-1",
        projectId: "proj-1",
        ideaId: "idea-1",
        card: {
          kind: "human-action-required",
          requestId: "req-1",
          title: "Enter the SMS code",
          message: "Sent to +1...",
          interventionType: "OTP_REQUIRED",
          inputType: "OTP",
          status: "PENDING",
        },
      }),
    );
  });

  it("posts to the general chat (ideaId: null) when there's no taskId", async () => {
    create.mockResolvedValue({ id: "req-2" });

    await HumanInterventionRepository.create({
      workspaceId: "ws-1",
      projectId: "proj-1",
      brandId: "brand-1",
      type: "CAPTCHA_REQUIRED",
      inputType: "MANUAL_BROWSER",
      title: "Solve the captcha",
    });

    expect(resolveIdeaIdForTask).not.toHaveBeenCalled();
    expect(postSystemMessage).toHaveBeenCalledWith(
      expect.objectContaining({ ideaId: null }),
    );
  });

  it("still returns the created request when the chat post fails", async () => {
    create.mockResolvedValue({ id: "req-3" });
    postSystemMessage.mockRejectedValue(new Error("db blip"));

    const result = await HumanInterventionRepository.create({
      workspaceId: "ws-1",
      projectId: "proj-1",
      brandId: "brand-1",
      type: "OTP_REQUIRED",
      inputType: "OTP",
      title: "Enter the code",
    });

    expect(result).toEqual({ id: "req-3" });
  });
});

describe("HumanInterventionRepository.resolve", () => {
  it("resolves the chat card in place after a successful resolve", async () => {
    findFirst.mockResolvedValue({
      id: "req-1",
      projectId: "proj-1",
      taskId: "task-1",
      status: "PENDING",
    });
    update.mockResolvedValue({ id: "req-1", status: "RESOLVED" });
    resolveIdeaIdForTask.mockResolvedValue("idea-1");

    await HumanInterventionRepository.resolve("req-1", "proj-1", "user-1");

    expect(resolveIdeaIdForTask).toHaveBeenCalledWith("task-1");
    expect(resolveHumanActionCard).toHaveBeenCalledWith({
      ideaId: "idea-1",
      requestId: "req-1",
      status: "RESOLVED",
    });
  });

  it("still returns the resolved request when resolving the chat card fails", async () => {
    findFirst.mockResolvedValue({
      id: "req-1",
      projectId: "proj-1",
      taskId: null,
      status: "PENDING",
    });
    update.mockResolvedValue({ id: "req-1", status: "RESOLVED" });
    resolveHumanActionCard.mockRejectedValue(new Error("db blip"));

    const result = await HumanInterventionRepository.resolve(
      "req-1",
      "proj-1",
      "user-1",
    );

    expect(result).toEqual({ id: "req-1", status: "RESOLVED" });
  });
});

describe("HumanInterventionRepository.transition", () => {
  it("resolves the chat card as CANCELLED", async () => {
    findFirst.mockResolvedValue({
      id: "req-1",
      projectId: "proj-1",
      taskId: null,
      status: "PENDING",
    });
    update.mockResolvedValue({ id: "req-1", status: "CANCELLED" });

    await HumanInterventionRepository.transition(
      "req-1",
      "proj-1",
      "CANCELLED",
    );

    expect(resolveHumanActionCard).toHaveBeenCalledWith({
      ideaId: null,
      requestId: "req-1",
      status: "CANCELLED",
    });
  });

  it("resolves the chat card as EXPIRED", async () => {
    findFirst.mockResolvedValue({
      id: "req-1",
      projectId: "proj-1",
      taskId: null,
      status: "PENDING",
    });
    update.mockResolvedValue({ id: "req-1", status: "EXPIRED" });

    await HumanInterventionRepository.transition("req-1", "proj-1", "EXPIRED");

    expect(resolveHumanActionCard).toHaveBeenCalledWith({
      ideaId: null,
      requestId: "req-1",
      status: "EXPIRED",
    });
  });

  // RESOLVED has its own dedicated method (.resolve(), tested above,
  // which also stores the TemporarySecret value and resumes the paused
  // execution job) — .transition() only ever gets called with CANCELLED
  // or EXPIRED in practice. This guards against a future caller passing
  // RESOLVED through here and double-resolving the chat card.
  it("does not resolve the chat card when transitioned straight to RESOLVED", async () => {
    findFirst.mockResolvedValue({
      id: "req-1",
      projectId: "proj-1",
      taskId: null,
      status: "PENDING",
    });
    update.mockResolvedValue({ id: "req-1", status: "RESOLVED" });

    await HumanInterventionRepository.transition("req-1", "proj-1", "RESOLVED");

    expect(resolveHumanActionCard).not.toHaveBeenCalled();
  });
});
