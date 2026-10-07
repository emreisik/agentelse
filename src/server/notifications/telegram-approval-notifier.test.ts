import { beforeEach, describe, expect, it, vi } from "vitest";

// Bu dosyanın kanıtladığı (GA-F7 paylaşılan düzenleme): CRITICAL_CHANGE_APPROVAL
// kararı (onay, ret, düzeltme isteği) Telegram'a mesaj göndermez ve Telegram
// bağlantısını sorgulamaz; başka onay tiplerinde bildirim sürer.

const credentialFindFirst = vi.fn();
const notifyProjectTelegram = vi.fn();
const editMarkup = vi.fn();

vi.mock("@/lib/prisma", () => ({
  prisma: { integrationCredential: { findFirst: credentialFindFirst } },
}));
vi.mock("@/server/security/crypto", () => ({
  decryptSecret: () => "token",
}));
vi.mock("@/server/integrations/telegram-client", () => ({
  telegramSendMessage: vi.fn(),
  telegramSendPhoto: vi.fn(),
  telegramEditMessageReplyMarkup: editMarkup,
}));
vi.mock("@/server/notifications/project-telegram-notifier", () => ({
  notifyProjectTelegram,
}));
vi.mock("@/server/storage/asset-storage", () => ({ readAsset: vi.fn() }));
vi.mock("@/lib/app-url", () => ({ appUrl: () => "https://app.test" }));

const { notifyApprovalDecision } = await import("./telegram-approval-notifier");

function approval(type: string) {
  return {
    id: "ap-1",
    projectId: "p-1",
    taskId: null,
    entityType: "TASK",
    entityId: "e-1",
    type,
    telegramMessageId: "42",
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  credentialFindFirst.mockResolvedValue({
    encryptedSecret: "x",
    metadata: { chatId: "chat-1" },
  });
  notifyProjectTelegram.mockResolvedValue(undefined);
  editMarkup.mockResolvedValue(undefined);
});

describe("notifyApprovalDecision", () => {
  it.each(["APPROVED", "REJECTED", "REVISION_REQUESTED"] as const)(
    "sends nothing and looks nothing up for a CRITICAL_CHANGE_APPROVAL that is %s",
    async (to) => {
      await notifyApprovalDecision(
        approval("CRITICAL_CHANGE_APPROVAL") as never,
        to,
        "user-1",
      );
      expect(credentialFindFirst).not.toHaveBeenCalled();
      expect(editMarkup).not.toHaveBeenCalled();
      expect(notifyProjectTelegram).not.toHaveBeenCalled();
    },
  );

  it("still looks up the connection and notifies for another approval type", async () => {
    await notifyApprovalDecision(
      approval("PUBLISH_APPROVAL") as never,
      "APPROVED",
      "user-1",
    );
    expect(credentialFindFirst).toHaveBeenCalledTimes(1);
    expect(notifyProjectTelegram).toHaveBeenCalledTimes(1);
  });
});
