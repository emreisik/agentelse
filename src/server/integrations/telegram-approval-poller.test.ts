import { beforeEach, describe, expect, it, vi } from "vitest";

// What Telegram tells an approver when a decision cannot be applied. A task that
// cannot run says so in plain words and stays undecided; every other refusal
// keeps the old "already decided" answer (which is what it means for them).

const credentialFindMany = vi.fn();
const credentialUpdate = vi.fn();
const approvalFindFirst = vi.fn();
// F1: the per-bot poll lease (one statement, returns rows changed).
const executeRaw = vi.fn();
vi.mock("@/lib/prisma", () => ({
  prisma: {
    integrationCredential: {
      findMany: credentialFindMany,
      update: credentialUpdate,
    },
    approval: { findFirst: approvalFindFirst },
    $executeRaw: executeRaw,
  },
}));
vi.mock("@/server/security/crypto", () => ({
  decryptSecret: vi.fn().mockReturnValue("bot-token"),
}));
const getUpdates = vi.fn();
const answerCallback = vi.fn();
vi.mock("@/server/integrations/telegram-client", () => ({
  telegramGetUpdates: getUpdates,
  telegramAnswerCallbackQuery: answerCallback,
  telegramEditMessageReplyMarkup: vi.fn().mockResolvedValue(undefined),
}));
const applyApprovalDecision = vi.fn();
vi.mock("@/server/commands/approval-decisions", () => ({
  applyApprovalDecision,
}));
vi.mock("@/server/commands/publish-creative", () => ({
  publishCreativeCore: vi.fn(),
}));

const { pollTelegramApprovals } = await import("./telegram-approval-poller");
const { AgentelseError } = await import("@/server/security/errors");
import { missingInputAdvice } from "@/server/execution/capability-input";

const credential = {
  id: "cred-1",
  projectId: "proj-1",
  encryptedSecret: "secret",
  metadata: { allowedApproverIds: ["42"] },
};

const click = (action: "approve" | "reject") => [
  {
    update_id: 7,
    callback_query: {
      id: "cb-1",
      data: `${action}:appr-1`,
      from: { id: 42 },
    },
  },
];

beforeEach(() => {
  vi.clearAllMocks();
  executeRaw.mockResolvedValue(1);
  credentialFindMany.mockResolvedValue([credential]);
  credentialUpdate.mockResolvedValue(undefined);
  approvalFindFirst.mockResolvedValue({ id: "appr-1", projectId: "proj-1" });
  answerCallback.mockResolvedValue(undefined);
  getUpdates.mockResolvedValue(click("approve"));
  applyApprovalDecision.mockResolvedValue(undefined);
});

const answered = () =>
  answerCallback.mock.calls.at(-1)![2] as {
    text: string;
    showAlert?: boolean;
  };

describe("pollTelegramApprovals: a decision that cannot be applied", () => {
  it("tells the approver why a task cannot run, in the words the card uses", async () => {
    const advice = missingInputAdvice({
      field: "platform",
      problem: "missing",
      allowed: ["INSTAGRAM", "TIKTOK", "LINKEDIN"],
    });
    applyApprovalDecision.mockRejectedValue(
      new AgentelseError("INVALID_INPUT", advice),
    );

    await pollTelegramApprovals();

    expect(answered()).toEqual({ text: advice, showAlert: true });
    expect(answered().text).not.toContain("already been decided");
  });

  it("keeps saying 'already decided' for any other refusal", async () => {
    applyApprovalDecision.mockRejectedValue(
      new AgentelseError(
        "INVALID_STATE_TRANSITION",
        "Approval: APPROVED -> REJECTED",
      ),
    );

    await pollTelegramApprovals();

    expect(answered().text).toBe(
      "This approval can no longer be decided (it has probably already been decided)",
    );
  });

  it("keeps a generic answer for an unexpected failure", async () => {
    applyApprovalDecision.mockRejectedValue(new Error("db down"));

    await pollTelegramApprovals();

    expect(answered().text).toBe("The action failed");
  });

  it("confirms an approval that went through", async () => {
    await pollTelegramApprovals();

    expect(answered().text).toBe("✅ Approved");
  });

  it("confirms a rejection, which never needed the platform", async () => {
    getUpdates.mockResolvedValue(click("reject"));

    await pollTelegramApprovals();

    expect(applyApprovalDecision).toHaveBeenCalledWith(
      expect.objectContaining({ to: "REJECTED" }),
    );
    expect(answered().text).toBe("❌ Rejected");
  });
});

describe("pollTelegramApprovals: one process per bot (F1)", () => {
  it("leaves a bot alone while another process holds its poll lease", async () => {
    executeRaw.mockResolvedValue(0);
    credentialFindMany.mockResolvedValue([
      { id: "tg-1", projectId: "p1", encryptedSecret: "x", metadata: {} },
    ]);
    await pollTelegramApprovals();
    expect(getUpdates).not.toHaveBeenCalled();
  });
});
