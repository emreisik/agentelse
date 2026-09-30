import { beforeEach, describe, expect, it, vi } from "vitest";

// The flag is read at the edge (here) and handed to ChatService as a plain
// boolean, so ChatService and buildContext stay env-free.

const turn = vi.fn();
vi.mock("@/server/commands/chat-service", () => ({
  ChatService: { turn },
}));
vi.mock("@/server/commands/command-service", () => ({
  CommandService: { submit: vi.fn() },
}));

const requireUser = vi.fn();
const requireProjectAccess = vi.fn();
vi.mock("@/server/security/tenant-context", () => ({
  requireUser,
  requireProjectAccess,
}));

const storeChatFiles = vi.fn();
vi.mock("@/server/chat/attachments", () => ({
  storeChatFiles,
  validateChatFiles: vi.fn().mockReturnValue(null),
}));

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

const getEnv = vi.fn();
vi.mock("@/lib/env", () => ({ getEnv }));

const { submitChatMessageAction } = await import("./command-actions");

function form(): FormData {
  const data = new FormData();
  data.set("projectId", "proj-1");
  data.set("text", "hello");
  return data;
}

beforeEach(() => {
  vi.clearAllMocks();
  requireUser.mockResolvedValue({ userId: "user-1" });
  requireProjectAccess.mockResolvedValue({
    workspaceId: "ws-1",
    defaultBrandId: "brand-1",
  });
  storeChatFiles.mockResolvedValue({ attachments: [], attachmentBodies: [] });
  turn.mockResolvedValue({
    commandId: "cmd-1",
    reply: "Hi",
    status: "REPLIED",
  });
});

describe("submitChatMessageAction", () => {
  it.each([true, false])(
    "passes guidedSetup=%s from GUIDED_SETUP to ChatService.turn",
    async (flag) => {
      getEnv.mockReturnValue({ GUIDED_SETUP: flag });

      const result = await submitChatMessageAction(form());

      expect(result.ok).toBe(true);
      expect(turn).toHaveBeenCalledTimes(1);
      expect(turn).toHaveBeenCalledWith(
        expect.objectContaining({
          projectId: "proj-1",
          workspaceId: "ws-1",
          guidedSetup: flag,
        }),
      );
      expect(turn.mock.calls[0]?.[0].guidedSetup).toBe(flag);
    },
  );
});
