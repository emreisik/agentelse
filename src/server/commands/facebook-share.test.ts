import { beforeEach, describe, expect, it, vi } from "vitest";

// What this suite proves: a creative is shared on the project's Facebook Page
// only when it is approved and a Page is selected, as a photo post whenever the
// piece's file is a picture (generated pieces are CREATIVE assets, uploads
// IMAGE), never twice while the post is live (a post deleted on Facebook can be
// shared again), through a FACEBOOK_PUBLISH task driven inline that names the
// piece as `sharedCreativeId` — never `creativeId`, which would mirror the
// share onto the piece's own card and flip it to PUBLISHED. A share that never
// settles, or whose inline run throws, is closed as FAILED so it can be tried
// again. The live post is read back from Facebook and its text can be changed
// or the post deleted with the Page token; only the user-token step can flag
// the connection for reconnecting.

const db = vi.hoisted(() => ({
  creativeFindUnique: vi.fn(),
  taskFindFirst: vi.fn(),
  credentialFindUnique: vi.fn(),
  credentialUpdate: vi.fn(),
  jobFindFirst: vi.fn(),
  jobUpdateMany: vi.fn(),
  jobCount: vi.fn(),
  txTaskFindFirst: vi.fn(),
  executeRaw: vi.fn(),
}));
vi.mock("@/lib/prisma", () => ({
  prisma: {
    creative: { findUnique: db.creativeFindUnique },
    task: { findFirst: db.taskFindFirst },
    integrationCredential: {
      findUnique: db.credentialFindUnique,
      update: db.credentialUpdate,
    },
    executionJob: {
      findFirst: db.jobFindFirst,
      updateMany: db.jobUpdateMany,
      count: db.jobCount,
    },
    $transaction: async (fn: (tx: unknown) => Promise<unknown>) =>
      fn({
        $executeRaw: db.executeRaw,
        task: { findFirst: db.txTaskFindFirst },
      }),
  },
}));

const mocks = vi.hoisted(() => ({
  submit: vi.fn(),
  recordReply: vi.fn(),
  driveJobInline: vi.fn(),
  getFacebookPublishTarget: vi.fn(),
  auditRecord: vi.fn(),
  taskTransition: vi.fn(),
  buildAssetPublicUrl: vi.fn(),
  fetchPageAccessToken: vi.fn(),
  fetchFacebookPagePost: vi.fn(),
  updateFacebookPagePost: vi.fn(),
  deleteFacebookPagePost: vi.fn(),
}));
vi.mock("@/server/commands/command-service", () => ({
  CommandService: { submit: mocks.submit },
}));
vi.mock("@/server/repositories/command.repository", () => ({
  CommandRepository: { recordReply: mocks.recordReply },
}));
vi.mock("@/server/repositories/task.repository", () => ({
  TaskRepository: { transition: mocks.taskTransition },
}));
vi.mock("@/server/chat/inline-job", () => ({
  driveJobInline: mocks.driveJobInline,
}));
vi.mock("@/server/integrations/meta-connection-status", () => ({
  getFacebookPublishTarget: mocks.getFacebookPublishTarget,
}));
vi.mock("@/server/repositories/audit-log.repository", () => ({
  AuditLogRepository: { record: mocks.auditRecord },
}));
vi.mock("@/server/security/asset-public-link", () => ({
  buildAssetPublicUrl: mocks.buildAssetPublicUrl,
}));
vi.mock("@/server/security/crypto", () => ({
  decryptSecret: () => "user-token",
}));
vi.mock("@/server/integrations/meta-client", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("@/server/integrations/meta-client")
  >()),
  fetchPageAccessToken: mocks.fetchPageAccessToken,
  fetchFacebookPagePost: mocks.fetchFacebookPagePost,
  updateFacebookPagePost: mocks.updateFacebookPagePost,
  deleteFacebookPagePost: mocks.deleteFacebookPagePost,
}));

const {
  deleteFacebookShareCore,
  editFacebookShareCore,
  readFacebookShareState,
  shareCreativeToFacebookCore,
} = await import("./facebook-share");
const { MetaApiError } = await import("@/server/integrations/meta-client");

const scope = {
  creativeId: "cr-1",
  workspaceId: "ws-1",
  projectId: "proj-1",
  actorUserId: "user-1",
};
const target = {
  platform: "facebook" as const,
  pageId: "page-9",
  accountLabel: "Web Health",
};
const credential = (status = "ACTIVE") => ({
  id: "cred-fb",
  status,
  encryptedSecret: "encrypted",
  metadata: {
    selectedPageId: "page-9",
    pages: [{ pageId: "page-9", pageName: "Web Health" }],
  },
});
// A generated picture: stored as a CREATIVE asset, not IMAGE.
const generatedPicture = {
  id: "asset-1",
  type: "CREATIVE",
  mimeType: "image/png",
};
const creative = (over: Record<string, unknown> = {}) => ({
  id: "cr-1",
  projectId: "proj-1",
  status: "APPROVED",
  title: "Autumn launch",
  versions: [
    { caption: "Hello Facebook", copy: null, asset: generatedPicture },
  ],
  ...over,
});
const recently = () => new Date();
const longAgo = () => new Date(Date.now() - 10 * 60_000);
const shareTask = (
  jobStatus: string | null,
  rawResult: Record<string, unknown> = {},
  errorMessage: string | null = null,
  updatedAt: Date = recently(),
) => ({
  id: "task-1",
  status: jobStatus === "FAILED" ? "FAILED" : "RUNNING",
  updatedAt,
  executionJobs: jobStatus
    ? [{ status: jobStatus, rawResult, errorMessage, updatedAt }]
    : [],
});
const livePost = { postId: "page-9_post-1", pageId: "page-9" };
const deletedOnFacebook = () =>
  new MetaApiError("Object with ID does not exist", 100, 33);

beforeEach(() => {
  vi.clearAllMocks();
  db.creativeFindUnique.mockResolvedValue(creative());
  db.taskFindFirst.mockResolvedValue(null);
  db.txTaskFindFirst.mockResolvedValue(null);
  db.credentialFindUnique.mockResolvedValue(credential());
  db.credentialUpdate.mockResolvedValue({});
  db.jobUpdateMany.mockResolvedValue({ count: 1 });
  db.jobCount.mockResolvedValue(1);
  db.jobFindFirst.mockResolvedValue({
    id: "job-2",
    task: { riskLevel: "HIGH" },
  });
  mocks.taskTransition.mockResolvedValue({});
  mocks.getFacebookPublishTarget.mockResolvedValue(target);
  mocks.buildAssetPublicUrl.mockResolvedValue("https://cdn.example.com/a.png");
  mocks.fetchPageAccessToken.mockResolvedValue("page-token");
  mocks.fetchFacebookPagePost.mockResolvedValue({
    message: "Hello Facebook",
    permalinkUrl: "https://www.facebook.com/page-9/posts/1",
  });
  mocks.submit.mockResolvedValue({
    status: "PLANNED",
    commandId: "cmd-1",
    taskId: "task-2",
    dispatched: true,
    requiresApproval: false,
  });
  mocks.driveJobInline.mockResolvedValue({
    status: "VERIFYING",
    errorMessage: null,
  });
});

describe("readFacebookShareState", () => {
  it("is unavailable without a Facebook Page, and before the piece is approved", async () => {
    mocks.getFacebookPublishTarget.mockResolvedValue(null);
    expect(await readFacebookShareState("proj-1", "cr-1")).toEqual({
      kind: "unavailable",
    });

    mocks.getFacebookPublishTarget.mockResolvedValue(target);
    db.creativeFindUnique.mockResolvedValue(creative({ status: "IN_REVIEW" }));
    expect(await readFacebookShareState("proj-1", "cr-1")).toEqual({
      kind: "unavailable",
    });
  });

  it("is ready for an approved or published piece once a Page is selected", async () => {
    expect(await readFacebookShareState("proj-1", "cr-1")).toEqual({
      kind: "ready",
      pageName: "Web Health",
    });
    db.creativeFindUnique.mockResolvedValue(creative({ status: "PUBLISHED" }));
    expect((await readFacebookShareState("proj-1", "cr-1")).kind).toBe("ready");
  });

  it("asks to reconnect when the Facebook connection expired, instead of disappearing", async () => {
    db.credentialFindUnique.mockResolvedValue(credential("EXPIRED"));
    mocks.getFacebookPublishTarget.mockResolvedValue(null);
    expect(await readFacebookShareState("proj-1", "cr-1")).toEqual({
      kind: "reconnect",
    });
  });

  it("is unavailable for another project's creative", async () => {
    db.creativeFindUnique.mockResolvedValue(creative({ projectId: "other" }));
    expect(await readFacebookShareState("proj-1", "cr-1")).toEqual({
      kind: "unavailable",
    });
  });

  it("looks the share up by sharedCreativeId, never by creativeId", async () => {
    await readFacebookShareState("proj-1", "cr-1");
    expect(db.taskFindFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          projectId: "proj-1",
          capability: "FACEBOOK_PUBLISH",
          payload: { path: ["sharedCreativeId"], equals: "cr-1" },
        },
      }),
    );
  });

  it("is sharing while the job is still running, and failed once it never settled", async () => {
    db.taskFindFirst.mockResolvedValue(shareTask("RUNNING"));
    expect((await readFacebookShareState("proj-1", "cr-1")).kind).toBe(
      "sharing",
    );

    db.taskFindFirst.mockResolvedValue(
      shareTask("QUEUED", {}, null, longAgo()),
    );
    expect(await readFacebookShareState("proj-1", "cr-1")).toEqual({
      kind: "failed",
      pageName: "Web Health",
      reason: "The share didn't finish.",
    });
  });

  it("reads the live post's text and link back from Facebook, also while it is being verified", async () => {
    for (const status of ["VERIFYING", "COMPLETED"]) {
      db.taskFindFirst.mockResolvedValue(shareTask(status, livePost));
      expect(await readFacebookShareState("proj-1", "cr-1")).toEqual({
        kind: "posted",
        pageName: "Web Health",
        postId: "page-9_post-1",
        message: "Hello Facebook",
        permalinkUrl: "https://www.facebook.com/page-9/posts/1",
      });
    }
    expect(mocks.fetchPageAccessToken).toHaveBeenCalledWith(
      "page-9",
      "user-token",
    );
    expect(mocks.fetchFacebookPagePost).toHaveBeenCalledWith(
      "page-9_post-1",
      "page-token",
    );
  });

  it("offers a post deleted on Facebook for sharing again", async () => {
    db.taskFindFirst.mockResolvedValue(shareTask("COMPLETED", livePost));
    mocks.fetchFacebookPagePost.mockRejectedValue(deletedOnFacebook());
    expect(await readFacebookShareState("proj-1", "cr-1")).toEqual({
      kind: "ready",
      pageName: "Web Health",
    });
  });

  it("keeps a post it cannot read as posted, also when the Page token step answers 100/33", async () => {
    db.taskFindFirst.mockResolvedValue(shareTask("COMPLETED", livePost));
    mocks.fetchFacebookPagePost.mockRejectedValue(
      new MetaApiError("rate limited", 4),
    );
    expect(await readFacebookShareState("proj-1", "cr-1")).toMatchObject({
      kind: "posted",
      detailsUnavailable: true,
    });

    mocks.fetchPageAccessToken.mockRejectedValue(deletedOnFacebook());
    expect(await readFacebookShareState("proj-1", "cr-1")).toMatchObject({
      kind: "posted",
      detailsUnavailable: true,
    });
    expect(db.credentialUpdate).not.toHaveBeenCalled();
  });

  it("flags the connection for reconnecting only when the user-token step answers 190", async () => {
    db.taskFindFirst.mockResolvedValue(shareTask("COMPLETED", livePost));
    mocks.fetchFacebookPagePost.mockRejectedValue(
      new MetaApiError("bad page token", 190),
    );
    await readFacebookShareState("proj-1", "cr-1");
    expect(db.credentialUpdate).not.toHaveBeenCalled();

    mocks.fetchPageAccessToken.mockRejectedValue(
      new MetaApiError("Token expired", 190),
    );
    expect(await readFacebookShareState("proj-1", "cr-1")).toEqual({
      kind: "reconnect",
    });
    expect(db.credentialUpdate).toHaveBeenCalledWith({
      where: { id: "cred-fb" },
      data: { status: "EXPIRED" },
    });
  });

  it("offers the selected Page when the old post's Page is out of reach", async () => {
    // Posted on Page A; the connection now reaches Page B (selected) only.
    db.taskFindFirst.mockResolvedValue(
      shareTask("COMPLETED", { postId: "page-A_post-1", pageId: "page-A" }),
    );
    mocks.fetchPageAccessToken.mockRejectedValue(
      new MetaApiError("Facebook gave no access to this Page"),
    );
    expect(await readFacebookShareState("proj-1", "cr-1")).toEqual({
      kind: "ready",
      pageName: "Web Health",
    });

    db.txTaskFindFirst.mockResolvedValue({ id: "task-1" });
    expect((await shareCreativeToFacebookCore(scope)).ok).toBe(true);
    expect(mocks.submit).toHaveBeenCalledOnce();
  });

  it("shows a failed share with Meta's reason", async () => {
    db.taskFindFirst.mockResolvedValue(
      shareTask("FAILED", {}, "(#200) Requires pages_manage_posts"),
    );
    expect(await readFacebookShareState("proj-1", "cr-1")).toEqual({
      kind: "failed",
      pageName: "Web Health",
      reason: "(#200) Requires pages_manage_posts",
    });
  });
});

describe("shareCreativeToFacebookCore", () => {
  it("posts a generated picture as a photo, under sharedCreativeId, run inline", async () => {
    const result = await shareCreativeToFacebookCore(scope);

    expect(result).toEqual({
      ok: true,
      message: "📤 Shared on Facebook (Web Health).",
    });
    expect(mocks.buildAssetPublicUrl).toHaveBeenCalledWith("asset-1");
    const submitted = mocks.submit.mock.calls[0]![0];
    expect(submitted).toMatchObject({
      workspaceId: "ws-1",
      knownProjectId: "proj-1",
      contentApproved: true,
      topic: "PUBLISH_RELAY",
      intent: {
        kind: "CAPABILITY",
        capability: "FACEBOOK_PUBLISH",
        targetPlatform: "FACEBOOK",
      },
    });
    expect(submitted.payloadExtra).toEqual({
      caption: "Hello Facebook",
      sharedCreativeId: "cr-1",
      imageUrl: "https://cdn.example.com/a.png",
    });
    expect(submitted.payloadExtra).not.toHaveProperty("creativeId");
    expect(mocks.driveJobInline).toHaveBeenCalledWith("job-2", "HIGH");
    expect(db.executeRaw).toHaveBeenCalledOnce();
  });

  it("refuses an unapproved piece and a project without a Page, without submitting", async () => {
    db.creativeFindUnique.mockResolvedValue(creative({ status: "IN_REVIEW" }));
    expect((await shareCreativeToFacebookCore(scope)).ok).toBe(false);

    db.creativeFindUnique.mockResolvedValue(creative());
    mocks.getFacebookPublishTarget.mockResolvedValue(null);
    expect(await shareCreativeToFacebookCore(scope)).toEqual({
      ok: false,
      message: "There's no connected Facebook Page.",
    });
    expect(mocks.submit).not.toHaveBeenCalled();
  });

  it("does not share a piece twice while its post is live, or while a share runs", async () => {
    db.taskFindFirst.mockResolvedValue(shareTask("COMPLETED", livePost));
    expect(await shareCreativeToFacebookCore(scope)).toEqual({
      ok: false,
      message: "This piece is already on Facebook.",
    });

    db.taskFindFirst.mockResolvedValue(shareTask("RUNNING"));
    expect((await shareCreativeToFacebookCore(scope)).ok).toBe(false);
    expect(mocks.submit).not.toHaveBeenCalled();
  });

  it("does not share again when the live post can't be read right now", async () => {
    db.taskFindFirst.mockResolvedValue(shareTask("COMPLETED", livePost));
    mocks.fetchFacebookPagePost.mockRejectedValue(
      new MetaApiError("rate limited", 4),
    );
    expect(await shareCreativeToFacebookCore(scope)).toEqual({
      ok: false,
      message: "This piece is already on Facebook.",
    });
    expect(mocks.submit).not.toHaveBeenCalled();
  });

  it("shares again once the post was deleted on Facebook", async () => {
    db.taskFindFirst.mockResolvedValue(shareTask("COMPLETED", livePost));
    db.txTaskFindFirst.mockResolvedValue({ id: "task-1" });
    mocks.fetchFacebookPagePost.mockRejectedValue(deletedOnFacebook());

    expect((await shareCreativeToFacebookCore(scope)).ok).toBe(true);
    expect(mocks.submit).toHaveBeenCalledOnce();
  });

  it("closes a share that never settled before trying again", async () => {
    db.taskFindFirst.mockResolvedValue(
      shareTask("QUEUED", {}, null, longAgo()),
    );
    db.txTaskFindFirst.mockResolvedValue({ id: "task-1" });

    expect((await shareCreativeToFacebookCore(scope)).ok).toBe(true);
    // Re-checked at the write: only a job that hasn't moved since the cutoff.
    expect(db.jobUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          taskId: "task-1",
          status: { in: ["QUEUED", "RUNNING", "WAITING_PROVIDER"] },
          updatedAt: { lt: expect.any(Date) },
        },
        data: expect.objectContaining({ status: "FAILED" }),
      }),
    );
    expect(mocks.taskTransition).toHaveBeenCalledWith(
      "task-1",
      "proj-1",
      "FAILED",
      {
        failureReason: "The share didn't finish.",
      },
    );
    expect(mocks.submit).toHaveBeenCalledOnce();
  });

  it("posts nothing new when the stale job moved before it could be closed", async () => {
    db.taskFindFirst.mockResolvedValue(
      shareTask("QUEUED", {}, null, longAgo()),
    );
    db.jobUpdateMany.mockResolvedValue({ count: 0 });

    expect(await shareCreativeToFacebookCore(scope)).toEqual({
      ok: false,
      message: "This piece is already being shared.",
    });
    expect(mocks.taskTransition).not.toHaveBeenCalled();
    expect(mocks.submit).not.toHaveBeenCalled();
  });

  it("fails the share (not stuck as sharing) when the inline run throws", async () => {
    mocks.driveJobInline.mockRejectedValue(
      new Error(
        "No healthy execution provider available for capability FACEBOOK_PUBLISH",
      ),
    );

    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const result = await shareCreativeToFacebookCore(scope);

    // Only a job the inline run left QUEUED is closed; the internal error text
    // is logged, not shown or stored.
    expect(db.jobUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { taskId: "task-2", status: { in: ["QUEUED"] } },
      }),
    );
    expect(result).toEqual({
      ok: false,
      message:
        "Couldn't share on Facebook: Facebook sharing failed, please try again.",
    });
    expect(mocks.taskTransition).toHaveBeenCalledWith(
      "task-2",
      "proj-1",
      "FAILED",
      { failureReason: "Facebook sharing failed, please try again." },
    );
  });

  it("leaves a job that got past QUEUED to settle (it may already be on Facebook)", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    mocks.driveJobInline.mockRejectedValue(new Error("connection reset"));
    db.jobUpdateMany.mockResolvedValue({ count: 0 });

    expect(await shareCreativeToFacebookCore(scope)).toEqual({
      ok: true,
      message: "📤 Facebook share is still running.",
    });
    // Failing the task under a running or VERIFYING job would break the
    // worker's verification step.
    expect(mocks.taskTransition).not.toHaveBeenCalled();
  });

  it("stops when another share was created meanwhile (two tabs, double click)", async () => {
    db.txTaskFindFirst.mockResolvedValue({ id: "task-from-the-other-tab" });
    expect(await shareCreativeToFacebookCore(scope)).toEqual({
      ok: false,
      message: "This piece is already being shared.",
    });
    expect(mocks.submit).not.toHaveBeenCalled();
  });

  it("reports Meta's error when the post fails", async () => {
    mocks.driveJobInline.mockResolvedValue({
      status: "FAILED",
      errorMessage: "(#200) Requires pages_manage_posts",
    });
    const result = await shareCreativeToFacebookCore(scope);
    expect(result).toEqual({
      ok: false,
      message: "Couldn't share on Facebook: (#200) Requires pages_manage_posts",
    });
    expect(mocks.recordReply).toHaveBeenCalledWith(
      "cmd-1",
      result.message,
      "ERROR",
    );
  });

  it("posts the text alone when the piece's file is no picture, and refuses a piece with neither", async () => {
    db.creativeFindUnique.mockResolvedValue(
      creative({
        versions: [
          {
            caption: "Just words",
            copy: null,
            asset: { id: "v", type: "VIDEO", mimeType: "video/mp4" },
          },
        ],
      }),
    );
    await shareCreativeToFacebookCore(scope);
    expect(mocks.submit.mock.calls[0]![0].payloadExtra).toEqual({
      caption: "Just words",
      sharedCreativeId: "cr-1",
    });

    mocks.submit.mockClear();
    db.creativeFindUnique.mockResolvedValue(
      creative({ versions: [{ caption: "", copy: "", asset: null }] }),
    );
    expect((await shareCreativeToFacebookCore(scope)).ok).toBe(false);
    expect(mocks.submit).not.toHaveBeenCalled();
  });
});

describe("editing and deleting the live post", () => {
  beforeEach(() => {
    db.taskFindFirst.mockResolvedValue(shareTask("COMPLETED", livePost));
  });

  it("changes the post's text with the Page token and records it", async () => {
    expect(
      await editFacebookShareCore({ ...scope, message: "  New text  " }),
    ).toEqual({
      ok: true,
      message: "Facebook post updated.",
    });
    expect(mocks.updateFacebookPagePost).toHaveBeenCalledWith(
      "page-9_post-1",
      "page-token",
      "New text",
    );
    expect(mocks.auditRecord).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "facebook_post.updated",
        entityId: "cr-1",
      }),
    );
  });

  it("refuses empty text, and a piece that isn't on Facebook, without calling Meta", async () => {
    expect((await editFacebookShareCore({ ...scope, message: "   " })).ok).toBe(
      false,
    );

    db.taskFindFirst.mockResolvedValue(null);
    expect(await editFacebookShareCore({ ...scope, message: "Text" })).toEqual({
      ok: false,
      message: "This piece isn't on Facebook.",
    });
    expect(mocks.updateFacebookPagePost).not.toHaveBeenCalled();
  });

  it("deletes the post; a post already gone on Facebook counts as deleted", async () => {
    expect((await deleteFacebookShareCore(scope)).ok).toBe(true);
    expect(mocks.deleteFacebookPagePost).toHaveBeenCalledWith(
      "page-9_post-1",
      "page-token",
    );

    mocks.deleteFacebookPagePost.mockRejectedValue(deletedOnFacebook());
    expect((await deleteFacebookShareCore(scope)).ok).toBe(true);
    expect(mocks.auditRecord).toHaveBeenCalledWith(
      expect.objectContaining({ action: "facebook_post.deleted" }),
    );
  });

  it("surfaces Meta's errors; only an expired user token flags the connection", async () => {
    mocks.deleteFacebookPagePost.mockRejectedValue(
      new MetaApiError("No permission", 10),
    );
    expect((await deleteFacebookShareCore(scope)).ok).toBe(false);
    expect(db.credentialUpdate).not.toHaveBeenCalled();

    mocks.fetchPageAccessToken.mockRejectedValue(
      new MetaApiError("Token expired", 190),
    );
    const result = await deleteFacebookShareCore(scope);
    expect(result.ok).toBe(false);
    expect(result.message).toContain("Reconnect Facebook");
    expect(db.credentialUpdate).toHaveBeenCalledWith({
      where: { id: "cred-fb" },
      data: { status: "EXPIRED" },
    });
  });
});
