import { beforeEach, describe, expect, it, vi } from "vitest";

// Bu dosyanın kanıtladığı (GA-F7 server action'ları): bayrak kapalıyken dört
// eylem de reddeder ve hiçbir iş yapmaz; yönetici olmayan onaylayamaz,
// reddedemez, geri alamaz, izni kapatamaz; tür doğrulaması; öneri her tür için
// doğru ham girdiyi motora geçirir; ret kodları mesaja dönüşür; karardan sonra
// syncApprovalState çağrılır; revalidatePath hedefleri.

const mocks = vi.hoisted(() => ({
  revalidatePath: vi.fn(),
  requireUser: vi.fn(),
  requireProjectAccess: vi.fn(),
  isWorkspaceManager: vi.fn(),
  propose: vi.fn(),
  syncApprovalState: vi.fn(),
  undo: vi.fn(),
  applyApprovalDecision: vi.fn(),
  changeFindFirst: vi.fn(),
  approvalFindUnique: vi.fn(),
  loadGaEditAccess: vi.fn(),
  clearGaEditGrant: vi.fn(),
  auditRecord: vi.fn(),
}));

vi.mock("next/cache", () => ({ revalidatePath: mocks.revalidatePath }));
vi.mock("@/server/security/tenant-context", () => ({
  requireUser: mocks.requireUser,
  requireProjectAccess: mocks.requireProjectAccess,
  isWorkspaceManager: mocks.isWorkspaceManager,
}));
vi.mock("@/lib/prisma", () => ({
  prisma: {
    gaConfigChange: { findFirst: mocks.changeFindFirst },
    approval: { findUnique: mocks.approvalFindUnique },
  },
}));
vi.mock("@/server/website-analytics/fixes/fixes", () => ({
  GaFixes: {
    propose: mocks.propose,
    syncApprovalState: mocks.syncApprovalState,
    undo: mocks.undo,
  },
}));
vi.mock("@/server/commands/approval-decisions", () => ({
  applyApprovalDecision: mocks.applyApprovalDecision,
}));
vi.mock("@/server/website-analytics/fixes/edit-grant", () => ({
  loadGaEditAccess: mocks.loadGaEditAccess,
  clearGaEditGrant: mocks.clearGaEditGrant,
}));
vi.mock("@/server/repositories/audit-log.repository", () => ({
  AuditLogRepository: { record: mocks.auditRecord },
}));

const {
  decideGaFixAction,
  proposeGaFixAction,
  turnOffGaEditAccessAction,
  undoGaFixAction,
} = await import("./ga-fix-actions");

const form = (fields: Record<string, string> = {}) => {
  const data = new FormData();
  data.set("projectId", "proj-1");
  for (const [key, value] of Object.entries(fields)) data.set(key, value);
  return data;
};

const approval = { id: "appr-1", projectId: "proj-1", status: "PENDING" };

beforeEach(() => {
  vi.unstubAllEnvs();
  vi.stubEnv("GA_FIXES", "true");
  vi.stubEnv("GA_SYNC", "true");
  for (const mock of Object.values(mocks)) mock.mockReset();
  mocks.requireUser.mockResolvedValue({ userId: "user-1" });
  mocks.requireProjectAccess.mockResolvedValue({ workspaceId: "ws-1" });
  mocks.isWorkspaceManager.mockResolvedValue(true);
  mocks.propose.mockResolvedValue({
    ok: true,
    changeId: "chg-1",
    status: "PROPOSED",
    created: true,
    approvalId: "appr-1",
  });
  mocks.syncApprovalState.mockResolvedValue("PROPOSED");
  mocks.undo.mockResolvedValue({ ok: true });
  mocks.applyApprovalDecision.mockResolvedValue(undefined);
  mocks.changeFindFirst.mockResolvedValue({
    id: "chg-1",
    approvalId: "appr-1",
  });
  mocks.approvalFindUnique.mockResolvedValue(approval);
  mocks.loadGaEditAccess.mockResolvedValue({ credentialId: "cred-1" });
  mocks.clearGaEditGrant.mockResolvedValue(undefined);
  mocks.auditRecord.mockResolvedValue(undefined);
});

describe("flag off", () => {
  it.each([
    ["GA_FIXES", "false"],
    ["GA_SYNC", "false"],
  ])("refuses every action when %s=%s", async (name, value) => {
    vi.stubEnv(name, value);
    const message = "Editing isn't available right now.";
    const fields = {
      kind: "RETENTION_14M",
      changeId: "chg-1",
      decision: "approve",
    };
    expect(await proposeGaFixAction(form(fields))).toEqual({
      ok: false,
      message,
    });
    expect(await decideGaFixAction(form(fields))).toEqual({
      ok: false,
      message,
    });
    expect(await undoGaFixAction(form(fields))).toEqual({
      ok: false,
      message,
    });
    expect(await turnOffGaEditAccessAction(form(fields))).toEqual({
      ok: false,
      message,
    });
    expect(mocks.propose).not.toHaveBeenCalled();
    expect(mocks.applyApprovalDecision).not.toHaveBeenCalled();
    expect(mocks.undo).not.toHaveBeenCalled();
    expect(mocks.clearGaEditGrant).not.toHaveBeenCalled();
    expect(mocks.revalidatePath).not.toHaveBeenCalled();
  });

  it("refuses a project outside the dev allow-list", async () => {
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("DATABASE_URL", "postgresql://u:p@db.example.com:5432/live");
    vi.stubEnv("GA_SYNC_DEV_PROJECTS", "other-project");
    expect(await proposeGaFixAction(form({ kind: "RETENTION_14M" }))).toEqual({
      ok: false,
      message: "Editing isn't available right now.",
    });
    expect(mocks.propose).not.toHaveBeenCalled();
  });
});

describe("proposeGaFixAction", () => {
  it("rejects an unknown kind without calling the engine", async () => {
    const result = await proposeGaFixAction(form({ kind: "DELETE_PROPERTY" }));
    expect(result.ok).toBe(false);
    expect(mocks.propose).not.toHaveBeenCalled();
  });

  it("passes the project access check first", async () => {
    mocks.requireProjectAccess.mockRejectedValue(new Error("No access"));
    expect(await proposeGaFixAction(form({ kind: "RETENTION_14M" }))).toEqual({
      ok: false,
      message: "No access",
    });
    expect(mocks.propose).not.toHaveBeenCalled();
  });

  it("sends the event name for a key event", async () => {
    const result = await proposeGaFixAction(
      form({
        kind: "KEY_EVENT_CREATE",
        eventName: "generate_lead",
        source: "GUIDE",
      }),
    );
    expect(result).toEqual({ ok: true });
    expect(mocks.propose).toHaveBeenCalledWith({
      projectId: "proj-1",
      kind: "KEY_EVENT_CREATE",
      raw: { eventName: "generate_lead" },
      source: "GUIDE",
      actor: { type: "USER", userId: "user-1" },
    });
  });

  it("sends title and day for a note and defaults the source to PANEL", async () => {
    await proposeGaFixAction(
      form({
        kind: "ANNOTATION_CREATE",
        title: "New landing page",
        day: "2026-10-05",
        source: "SOMETHING_ELSE",
      }),
    );
    expect(mocks.propose).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "ANNOTATION_CREATE",
        raw: { title: "New landing page", day: "2026-10-05" },
        source: "PANEL",
      }),
    );
  });

  it.each(["RETENTION_14M", "ENHANCED_MEASUREMENT", "CHANNEL_GROUP_AI"])(
    "sends an empty raw input for %s",
    async (kind) => {
      await proposeGaFixAction(form({ kind, eventName: "ignored" }));
      expect(mocks.propose).toHaveBeenCalledWith(
        expect.objectContaining({ kind, raw: {} }),
      );
    },
  );

  it("revalidates the Website page and the dashboard on success", async () => {
    await proposeGaFixAction(form({ kind: "RETENTION_14M" }));
    expect(mocks.revalidatePath).toHaveBeenCalledWith("/projects/proj-1/site");
    expect(mocks.revalidatePath).toHaveBeenCalledWith("/dashboard");
  });

  it("surfaces a refusal as its message and revalidates nothing", async () => {
    mocks.propose.mockResolvedValue({
      ok: false,
      code: "no_edit_access",
      message: "Allow editing first, then try again.",
    });
    expect(await proposeGaFixAction(form({ kind: "RETENTION_14M" }))).toEqual({
      ok: false,
      message: "Allow editing first, then try again.",
    });
    expect(mocks.revalidatePath).not.toHaveBeenCalled();
  });

  it("turns a thrown error into a result", async () => {
    mocks.propose.mockRejectedValue(new Error("boom"));
    expect(await proposeGaFixAction(form({ kind: "RETENTION_14M" }))).toEqual({
      ok: false,
      message: "boom",
    });
  });
});

describe("decideGaFixAction", () => {
  const approve = { changeId: "chg-1", decision: "approve" };

  it.each(["approve", "reject"])(
    "refuses %s for a non-manager before touching anything",
    async (decision) => {
      mocks.isWorkspaceManager.mockResolvedValue(false);
      expect(
        await decideGaFixAction(form({ changeId: "chg-1", decision })),
      ).toEqual({
        ok: false,
        message: "Only a workspace owner or admin can approve this.",
      });
      expect(mocks.applyApprovalDecision).not.toHaveBeenCalled();
      expect(mocks.syncApprovalState).not.toHaveBeenCalled();
      expect(mocks.changeFindFirst).not.toHaveBeenCalled();
      expect(mocks.revalidatePath).not.toHaveBeenCalled();
    },
  );

  it("rejects an unknown decision", async () => {
    const result = await decideGaFixAction(
      form({ changeId: "chg-1", decision: "maybe" }),
    );
    expect(result.ok).toBe(false);
    expect(mocks.applyApprovalDecision).not.toHaveBeenCalled();
  });

  it("approves through the shared decision command, then syncs", async () => {
    const order: string[] = [];
    mocks.applyApprovalDecision.mockImplementation(async () => {
      order.push("decide");
    });
    mocks.syncApprovalState.mockImplementation(async () => {
      order.push("sync");
      return "APPROVED";
    });
    expect(await decideGaFixAction(form(approve))).toEqual({ ok: true });
    expect(mocks.changeFindFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "chg-1", projectId: "proj-1" } }),
    );
    expect(mocks.applyApprovalDecision).toHaveBeenCalledWith({
      approval,
      to: "APPROVED",
      reviewedByUserId: "user-1",
      actorType: "USER",
    });
    expect(mocks.syncApprovalState).toHaveBeenCalledWith("chg-1");
    expect(order).toEqual(["decide", "sync"]);
    expect(mocks.revalidatePath).toHaveBeenCalledWith("/projects/proj-1/site");
    expect(mocks.revalidatePath).toHaveBeenCalledWith("/dashboard");
  });

  it("rejects through the same command", async () => {
    await decideGaFixAction(form({ changeId: "chg-1", decision: "reject" }));
    expect(mocks.applyApprovalDecision).toHaveBeenCalledWith(
      expect.objectContaining({ to: "REJECTED" }),
    );
    expect(mocks.syncApprovalState).toHaveBeenCalledWith("chg-1");
  });

  it("refuses a change without an approval or from another project", async () => {
    mocks.changeFindFirst.mockResolvedValue(null);
    expect((await decideGaFixAction(form(approve))).ok).toBe(false);
    mocks.changeFindFirst.mockResolvedValue({ id: "chg-1", approvalId: null });
    expect((await decideGaFixAction(form(approve))).ok).toBe(false);
    mocks.changeFindFirst.mockResolvedValue({
      id: "chg-1",
      approvalId: "appr-1",
    });
    mocks.approvalFindUnique.mockResolvedValue({
      ...approval,
      projectId: "proj-2",
    });
    expect((await decideGaFixAction(form(approve))).ok).toBe(false);
    expect(mocks.applyApprovalDecision).not.toHaveBeenCalled();
  });

  it("does not decide an approval that is no longer pending", async () => {
    mocks.approvalFindUnique.mockResolvedValue({
      ...approval,
      status: "APPROVED",
    });
    const result = await decideGaFixAction(form(approve));
    expect(result.ok).toBe(false);
    expect(mocks.applyApprovalDecision).not.toHaveBeenCalled();
    expect(mocks.syncApprovalState).not.toHaveBeenCalled();
  });

  it("passes the error message of a failed decision through", async () => {
    mocks.applyApprovalDecision.mockRejectedValue(
      new Error("Only a workspace owner or admin can approve this change."),
    );
    expect(await decideGaFixAction(form(approve))).toEqual({
      ok: false,
      message:
        "Only a workspace owner or admin can approve this change.",
    });
    expect(mocks.syncApprovalState).not.toHaveBeenCalled();
  });
});

describe("undoGaFixAction", () => {
  it("refuses a non-manager without calling undo", async () => {
    mocks.isWorkspaceManager.mockResolvedValue(false);
    const result = await undoGaFixAction(form({ changeId: "chg-1" }));
    expect(result.ok).toBe(false);
    expect(mocks.undo).not.toHaveBeenCalled();
  });

  it("undoes and revalidates", async () => {
    expect(await undoGaFixAction(form({ changeId: "chg-1" }))).toEqual({
      ok: true,
    });
    expect(mocks.undo).toHaveBeenCalledWith({
      projectId: "proj-1",
      changeId: "chg-1",
      userId: "user-1",
    });
    expect(mocks.revalidatePath).toHaveBeenCalledWith("/projects/proj-1/site");
  });

  it("surfaces the engine's refusal", async () => {
    mocks.undo.mockResolvedValue({ ok: false, message: "Cannot undo this." });
    expect(await undoGaFixAction(form({ changeId: "chg-1" }))).toEqual({
      ok: false,
      message: "Cannot undo this.",
    });
    expect(mocks.revalidatePath).not.toHaveBeenCalled();
  });
});

describe("turnOffGaEditAccessAction", () => {
  it("refuses a non-manager without touching the grant", async () => {
    mocks.isWorkspaceManager.mockResolvedValue(false);
    const result = await turnOffGaEditAccessAction(form());
    expect(result.ok).toBe(false);
    expect(mocks.clearGaEditGrant).not.toHaveBeenCalled();
    expect(mocks.auditRecord).not.toHaveBeenCalled();
  });

  it("clears the grant, records an audit entry and revalidates", async () => {
    expect(await turnOffGaEditAccessAction(form())).toEqual({ ok: true });
    expect(mocks.clearGaEditGrant).toHaveBeenCalledWith("cred-1");
    expect(mocks.auditRecord).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: "ws-1",
        projectId: "proj-1",
        actorId: "user-1",
        action: "integration_credential.edit_access_turned_off",
        entityId: "cred-1",
      }),
    );
    expect(mocks.revalidatePath).toHaveBeenCalledWith(
      "/projects/proj-1/integrations",
    );
    expect(mocks.revalidatePath).toHaveBeenCalledWith("/projects/proj-1/site");
  });

  it("explains when Google Analytics is not connected", async () => {
    mocks.loadGaEditAccess.mockResolvedValue(null);
    const result = await turnOffGaEditAccessAction(form());
    expect(result.ok).toBe(false);
    expect(mocks.clearGaEditGrant).not.toHaveBeenCalled();
  });
});
