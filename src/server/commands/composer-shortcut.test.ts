import { beforeEach, describe, expect, it, vi } from "vitest";

// The composer "+" menu's "Social Account Setup" shortcut sends a fixed sentence
// and cannot say which platform the account is for. It used to create the task
// anyway (and fail after the client approved it). Now it asks with buttons, and
// every other outcome keeps working as it did.

const submit = vi.fn();
vi.mock("@/server/commands/command-service", () => ({
  CommandService: { submit },
}));
const recordReply = vi.fn().mockResolvedValue(undefined);
const attachParsedIntent = vi.fn().mockResolvedValue(undefined);
vi.mock("@/server/repositories/command.repository", () => ({
  CommandRepository: { recordReply, attachParsedIntent },
}));
// Only the type is used from here.
vi.mock("@/server/actions/command-actions", () => ({}));

const { submitComposerShortcut } = await import("./composer-shortcut");

const shortcut = (overrides: Record<string, unknown> = {}) =>
  submitComposerShortcut({
    capability: "SOCIAL_ACCOUNT_SETUP",
    request: "Set up a new social media account",
    workspaceId: "ws-1",
    projectId: "proj-1",
    ideaId: "idea-1",
    actorUserId: "user-1",
    ...overrides,
  });

const needsPlatform = {
  status: "NEEDS_INPUT",
  commandId: "cmd-1",
  field: "platform",
  problem: "missing",
  allowed: ["INSTAGRAM", "TIKTOK", "LINKEDIN"],
};

beforeEach(() => {
  vi.clearAllMocks();
  recordReply.mockResolvedValue(undefined);
  attachParsedIntent.mockResolvedValue(undefined);
});

describe("submitComposerShortcut: a platform is needed", () => {
  it("asks which platform, as a reply the chat shows, not as an error", async () => {
    submit.mockResolvedValue(needsPlatform);

    const result = await shortcut();

    expect(result).toMatchObject({
      ok: true,
      commandId: "cmd-1",
      reply:
        "Which platform should the new account be for? Instagram, TikTok or LinkedIn?",
      attachments: [],
    });
    expect(recordReply).toHaveBeenCalledWith(
      "cmd-1",
      result.ok && result.reply,
      "ANSWERED",
    );
  });

  it("stores the platform buttons on the same row so they appear after the refresh", async () => {
    submit.mockResolvedValue(needsPlatform);

    await shortcut();

    const [commandId, parsedIntent, projectId] =
      attachParsedIntent.mock.calls[0]!;
    expect(commandId).toBe("cmd-1");
    expect(projectId).toBe("proj-1");
    expect(parsedIntent.card).toMatchObject({
      kind: "question",
      projectId: "proj-1",
      ideaId: "idea-1",
    });
    expect(
      parsedIntent.card.questions[0].options.map(
        (o: { label: string }) => o.label,
      ),
    ).toEqual(["Instagram", "TikTok", "LinkedIn"]);
  });

  it("returns the buttons too, so they show at once (this action does not refresh the page)", async () => {
    submit.mockResolvedValue(needsPlatform);

    const result = await shortcut();

    const stored = attachParsedIntent.mock.calls[0]![1].card;
    expect(result.ok && result.card).toEqual(stored);
    expect(result.ok && result.card).toMatchObject({ kind: "question" });
  });

  it("attaches no buttons when it is an approval that could not be granted", async () => {
    submit.mockResolvedValue({ ...needsPlatform, approvalId: "appr-1" });

    const result = await shortcut();

    expect(result.ok && result.card).toBeUndefined();
    expect(attachParsedIntent).not.toHaveBeenCalled();
    expect(result.ok && result.reply).toContain("Reject it and ask again");
  });
});

describe("submitComposerShortcut: everything else is as it was", () => {
  it("says a planned task is on its way", async () => {
    submit.mockResolvedValue({
      status: "PLANNED",
      commandId: "cmd-2",
      taskId: "t-1",
      dispatched: true,
      requiresApproval: false,
    });

    const result = await shortcut({ capability: "CREATE_COPY" });

    expect(result).toMatchObject({
      ok: true,
      reply: "On it — I'll post the result here.",
    });
    expect(attachParsedIntent).not.toHaveBeenCalled();
  });

  it("passes the platform it was given straight through, so it is not asked for", async () => {
    submit.mockResolvedValue({
      status: "PLANNED",
      commandId: "cmd-2",
      taskId: "t-1",
      dispatched: false,
      requiresApproval: true,
    });

    const result = await shortcut({ targetPlatform: "INSTAGRAM" });

    expect(submit.mock.calls[0]![0].intent).toMatchObject({
      capability: "SOCIAL_ACCOUNT_SETUP",
      targetPlatform: "INSTAGRAM",
    });
    expect(result).toMatchObject({ ok: true, reply: "Sent for approval." });
  });

  it("keeps the generic error for a refusal that has nothing to ask", async () => {
    submit.mockResolvedValue({
      status: "PROJECT_INACTIVE",
      commandId: "cmd-3",
    });

    const result = await shortcut({ capability: "CREATE_COPY" });

    expect(result).toEqual({
      ok: false,
      message:
        "Couldn't start this — please try describing it in chat instead.",
    });
    expect(recordReply).toHaveBeenCalledWith(
      "cmd-3",
      expect.any(String),
      "ERROR",
    );
  });
});
