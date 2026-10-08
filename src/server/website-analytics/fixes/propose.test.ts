import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";

// Bu dosyanın kanıtladığı: öneri kapıları doğru sırada ve doğru kodla reddeder
// (bayrak, alpha, bağ, mock uyuşmazlığı, izin, doğrulama, saklı veriyle ön
// kontroller, 3 açık SYSTEM notu sınırı); aynı konu ikinci Task açmaz; reddedilmiş
// açık satır kapanıp taze değişiklik doğar; proposeAnnotation'ın saklı dedupeKey'i
// tam olarak ANNOTATION_CREATE:<anahtar>'tır; Task ve Approval şekilleri
// (ANALYTICS_EDIT, CRITICAL_CHANGE_APPROVAL, notify:false, 7 gün); öneri sırasında
// yazıcı hiç çağrılmaz; onay kartı satırlarında mülk adı yoktur.

const NOW = new Date("2026-10-07T09:00:00.000Z");

const mocks = vi.hoisted(() => ({
  primaryGaLink: vi.fn(),
  loadGaEditAccess: vi.fn(),
  syncState: vi.fn(),
  audit: vi.fn(),
  changeFindFirst: vi.fn(),
  changeCreate: vi.fn(),
  changeUpdate: vi.fn(),
  changeUpdateMany: vi.fn(),
  changeCount: vi.fn(),
  credentialFindUnique: vi.fn(),
  brandFindFirst: vi.fn(),
  taskCreate: vi.fn(),
  taskTransition: vi.fn(),
  approvalCreate: vi.fn(),
  postCard: vi.fn(),
  createWriter: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    gaConfigChange: {
      findFirst: mocks.changeFindFirst,
      create: mocks.changeCreate,
      update: mocks.changeUpdate,
      updateMany: mocks.changeUpdateMany,
      count: mocks.changeCount,
    },
    integrationCredential: { findUnique: mocks.credentialFindUnique },
    brand: { findFirst: mocks.brandFindFirst },
  },
}));
vi.mock("@/server/website-analytics/store", () => ({
  primaryGaLink: mocks.primaryGaLink,
}));
vi.mock("./edit-grant", () => ({ loadGaEditAccess: mocks.loadGaEditAccess }));
vi.mock("./approval-hook", () => ({
  syncGaFixApprovalState: mocks.syncState,
}));
vi.mock("./audit", () => ({ recordGaFixAudit: mocks.audit }));
vi.mock("@/server/repositories/task.repository", () => ({
  TaskRepository: { create: mocks.taskCreate, transition: mocks.taskTransition },
}));
vi.mock("@/server/repositories/approval.repository", () => ({
  ApprovalRepository: { create: mocks.approvalCreate },
}));
vi.mock("@/server/repositories/idea-chat.repository", () => ({
  IdeaChatRepository: { postApprovalRequestCard: mocks.postCard },
}));
vi.mock("@/server/integrations/google-analytics/admin-write", () => ({
  createGaAdminWriter: mocks.createWriter,
}));

const { proposeGaFix, proposeGaAnnotation } = await import("./propose");

const LINK = {
  id: "link-1",
  workspaceId: "ws-1",
  projectId: "proj-1",
  credentialId: "cred-1",
  propertyName: "Acme Shop Secret Property",
  isMock: false,
  timeZone: "Europe/Istanbul",
  keyEvents: null as unknown,
  dataRetention: "TWO_MONTHS" as string | null,
  streamId: "stream-1" as string | null,
  serviceLevel: null as string | null,
};
const USER = { type: "USER", userId: "user-1" } as const;

function input(overrides: Record<string, unknown> = {}) {
  return {
    projectId: "proj-1",
    kind: "KEY_EVENT_CREATE" as const,
    raw: { eventName: "generate_lead" },
    source: "PANEL" as const,
    actor: USER,
    now: NOW,
    ...overrides,
  };
}

const MOCK_OFF = { mock: false };

beforeEach(() => {
  vi.resetAllMocks();
  vi.stubEnv("GA_FIXES", "true");
  vi.stubEnv("GA_SYNC", "true");
  vi.stubEnv("GA_FIXES_ALPHA", "true");
  mocks.primaryGaLink.mockResolvedValue({ ...LINK });
  mocks.credentialFindUnique.mockResolvedValue({ status: "ACTIVE" });
  mocks.loadGaEditAccess.mockResolvedValue({ granted: true });
  mocks.changeFindFirst.mockResolvedValue(null);
  mocks.changeCount.mockResolvedValue(0);
  mocks.changeCreate.mockImplementation(({ data }) =>
    Promise.resolve({ id: "chg-1", taskId: null, approvalId: null, ...data }),
  );
  mocks.changeUpdate.mockImplementation(({ data }) =>
    Promise.resolve({ id: "chg-1", ...data }),
  );
  mocks.changeUpdateMany.mockResolvedValue({ count: 1 });
  mocks.brandFindFirst.mockResolvedValue({ id: "brand-1" });
  mocks.taskCreate.mockResolvedValue({ id: "task-1" });
  mocks.taskTransition.mockResolvedValue({});
  mocks.approvalCreate.mockResolvedValue({ id: "appr-1" });
  mocks.postCard.mockResolvedValue(undefined);
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("proposeGaFix refusals", () => {
  it("not_enabled when GA_FIXES is off", async () => {
    vi.stubEnv("GA_FIXES", "false");
    const result = await proposeGaFix(input(), MOCK_OFF);
    expect(result).toMatchObject({ ok: false, code: "not_enabled" });
    expect(mocks.primaryGaLink).not.toHaveBeenCalled();
  });

  it("alpha_off for an alpha kind with the kill switch off", async () => {
    vi.stubEnv("GA_FIXES_ALPHA", "false");
    const result = await proposeGaFix(
      input({ kind: "ENHANCED_MEASUREMENT", raw: {} }),
      MOCK_OFF,
    );
    expect(result).toMatchObject({ ok: false, code: "alpha_off" });
  });

  it("no_link without a primary link and with a non-active credential", async () => {
    mocks.primaryGaLink.mockResolvedValue(null);
    expect(await proposeGaFix(input(), MOCK_OFF)).toMatchObject({
      ok: false,
      code: "no_link",
    });
    mocks.primaryGaLink.mockResolvedValue({ ...LINK });
    mocks.credentialFindUnique.mockResolvedValue({ status: "REVOKED" });
    expect(await proposeGaFix(input(), MOCK_OFF)).toMatchObject({
      ok: false,
      code: "no_link",
    });
  });

  it("not_allowed_here on a mock mismatch in both directions", async () => {
    // Mock süreç gerçek bağda.
    expect(await proposeGaFix(input(), { mock: true })).toMatchObject({
      ok: false,
      code: "not_allowed_here",
    });
    // Gerçek süreç mock bağda.
    mocks.primaryGaLink.mockResolvedValue({ ...LINK, isMock: true });
    expect(await proposeGaFix(input(), { mock: false })).toMatchObject({
      ok: false,
      code: "not_allowed_here",
    });
    expect(mocks.loadGaEditAccess).not.toHaveBeenCalled();
  });

  it("no_edit_access when editing was not granted or access is missing", async () => {
    mocks.loadGaEditAccess.mockResolvedValue({ granted: false });
    expect(await proposeGaFix(input(), MOCK_OFF)).toMatchObject({
      ok: false,
      code: "no_edit_access",
    });
    mocks.loadGaEditAccess.mockResolvedValue(null);
    expect(await proposeGaFix(input(), MOCK_OFF)).toMatchObject({
      ok: false,
      code: "no_edit_access",
    });
  });

  it("invalid for a reserved event name", async () => {
    const result = await proposeGaFix(
      input({ raw: { eventName: "page_view" } }),
      MOCK_OFF,
    );
    expect(result).toMatchObject({ ok: false, code: "invalid" });
  });

  it("already_satisfied from stored data: key event present, retention 14 months", async () => {
    mocks.primaryGaLink.mockResolvedValue({
      ...LINK,
      keyEvents: [{ eventName: "generate_lead" }],
    });
    expect(await proposeGaFix(input(), MOCK_OFF)).toMatchObject({
      ok: false,
      code: "already_satisfied",
    });
    mocks.primaryGaLink.mockResolvedValue({
      ...LINK,
      dataRetention: "FOURTEEN_MONTHS",
    });
    expect(
      await proposeGaFix(input({ kind: "RETENTION_14M", raw: {} }), MOCK_OFF),
    ).toMatchObject({ ok: false, code: "already_satisfied" });
  });

  it("limit_reached at 30 stored key events (50 for 360), absent event only", async () => {
    const thirty = Array.from({ length: 30 }, (_, i) => ({ eventName: `ev_${i}` }));
    mocks.primaryGaLink.mockResolvedValue({ ...LINK, keyEvents: thirty });
    expect(await proposeGaFix(input(), MOCK_OFF)).toMatchObject({
      ok: false,
      code: "limit_reached",
    });
    mocks.primaryGaLink.mockResolvedValue({
      ...LINK,
      keyEvents: thirty,
      serviceLevel: "GOOGLE_ANALYTICS_360",
    });
    expect(await proposeGaFix(input(), MOCK_OFF)).toMatchObject({ ok: true });
  });

  it("no_stream for enhanced measurement without a stream", async () => {
    mocks.primaryGaLink.mockResolvedValue({ ...LINK, streamId: null });
    expect(
      await proposeGaFix(input({ kind: "ENHANCED_MEASUREMENT", raw: {} }), MOCK_OFF),
    ).toMatchObject({ ok: false, code: "no_stream" });
  });

  it("caps unreviewed SYSTEM annotations at 3 but not USER ones", async () => {
    mocks.changeCount.mockResolvedValue(3);
    const system = await proposeGaFix(
      input({
        kind: "ANNOTATION_CREATE",
        raw: { title: "Agentelse: x launched" },
        source: "AUTO",
        actor: { type: "SYSTEM" },
      }),
      MOCK_OFF,
    );
    expect(system).toMatchObject({ ok: false, code: "not_allowed_here" });
    const user = await proposeGaFix(
      input({ kind: "ANNOTATION_CREATE", raw: { title: "Agentelse: x launched" } }),
      MOCK_OFF,
    );
    expect(user).toMatchObject({ ok: true });
  });
});

describe("proposeGaFix creation", () => {
  it("creates the change, a Task and an Approval with the contract shapes", async () => {
    const result = await proposeGaFix(input(), MOCK_OFF);
    expect(result).toEqual({
      ok: true,
      changeId: "chg-1",
      status: "PROPOSED",
      created: true,
      approvalId: "appr-1",
    });

    const created = mocks.changeCreate.mock.calls[0]![0].data;
    expect(created).toMatchObject({
      linkId: "link-1",
      kind: "KEY_EVENT_CREATE",
      status: "PROPOSED",
      source: "PANEL",
      dedupeKey: "KEY_EVENT_CREATE:generate_lead",
      openKey: "KEY_EVENT_CREATE:generate_lead",
      proposedByType: "USER",
      proposedByUserId: "user-1",
    });
    expect(created.title.length).toBeLessThanOrEqual(80);
    expect(created.expiresAt).toEqual(
      new Date(NOW.getTime() + 7 * 24 * 60 * 60 * 1000),
    );

    const task = mocks.taskCreate.mock.calls[0]![0];
    expect(task).toMatchObject({
      capability: "ANALYTICS_EDIT",
      riskLevel: "MEDIUM",
      requiresApproval: true,
      requiresVerification: false,
      departmentKey: "DATA_ANALYTICS",
      createdByType: "USER",
      createdByUserId: "user-1",
    });
    expect(task.title.length).toBeLessThanOrEqual(80);
    expect(task.payload).toMatchObject({
      gaConfigChangeId: "chg-1",
      kind: "KEY_EVENT_CREATE",
    });
    expect(mocks.taskTransition).toHaveBeenCalledWith(
      "task-1",
      "proj-1",
      "WAITING_APPROVAL",
    );

    const approval = mocks.approvalCreate.mock.calls[0]![0];
    expect(approval).toMatchObject({
      taskId: "task-1",
      entityType: "Task",
      entityId: "task-1",
      type: "CRITICAL_CHANGE_APPROVAL",
      level: "LEVEL_3_CLIENT",
      notify: false,
      brandId: "brand-1",
    });
    expect(approval.expiresAt).toEqual(created.expiresAt);

    expect(mocks.changeUpdate).toHaveBeenCalledWith({
      where: { id: "chg-1" },
      data: { taskId: "task-1", approvalId: "appr-1" },
    });
    expect(mocks.audit).toHaveBeenCalledWith(
      "ga_config_change.proposed",
      { changeId: "chg-1", kind: "KEY_EVENT_CREATE", source: "PANEL" },
      expect.objectContaining({ workspaceId: "ws-1", userId: "user-1" }),
    );
  });

  it("card details come from the catalog and carry no property name", async () => {
    await proposeGaFix(input(), MOCK_OFF);
    const task = mocks.taskCreate.mock.calls[0]![0];
    const card = mocks.postCard.mock.calls[0]![0];
    expect(card.details).toEqual(task.payload.details);
    expect(card.details.length).toBeGreaterThan(0);
    const serialized = JSON.stringify([task, card, mocks.approvalCreate.mock.calls]);
    expect(serialized).not.toContain("Acme Shop Secret Property");
    expect(card).toMatchObject({
      riskLevel: "MEDIUM",
      departmentKey: "DATA_ANALYTICS",
      category: "action",
    });
  });

  it("never calls the Google writer", async () => {
    await proposeGaFix(input(), MOCK_OFF);
    expect(mocks.createWriter).not.toHaveBeenCalled();
  });

  it("a failing chat card does not fail the proposal", async () => {
    mocks.postCard.mockRejectedValue(new Error("chat down"));
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const result = await proposeGaFix(input(), MOCK_OFF);
    spy.mockRestore();
    expect(result).toMatchObject({ ok: true, created: true });
  });

  it("closes the row and refuses when the approval cannot be created", async () => {
    mocks.approvalCreate.mockRejectedValue(new Error("db"));
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const result = await proposeGaFix(input(), MOCK_OFF);
    spy.mockRestore();
    expect(result).toMatchObject({ ok: false, code: "not_allowed_here" });
    expect(mocks.changeUpdateMany).toHaveBeenCalledWith({
      where: { id: "chg-1", status: "PROPOSED" },
      data: { status: "EXPIRED", openKey: null },
    });
    // Kurulmuş Task bekleyen iş olarak kalmaz.
    expect(mocks.taskTransition).toHaveBeenCalledWith(
      "task-1",
      "proj-1",
      "CANCELLED",
      expect.anything(),
    );
  });

  it("returns the winner's row on a unique violation", async () => {
    mocks.changeFindFirst
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({
        id: "chg-9",
        status: "PROPOSED",
        approvalId: "appr-9",
      });
    mocks.changeCreate.mockRejectedValue(
      Object.assign(new Error("unique"), { code: "P2002" }),
    );
    const result = await proposeGaFix(input(), MOCK_OFF);
    expect(result).toEqual({
      ok: true,
      changeId: "chg-9",
      status: "PROPOSED",
      created: false,
      approvalId: "appr-9",
    });
    expect(mocks.taskCreate).not.toHaveBeenCalled();
  });
});

describe("proposeGaFix dedupe", () => {
  it("returns the open row without a second Task", async () => {
    mocks.changeFindFirst.mockResolvedValue({
      id: "chg-7",
      status: "PROPOSED",
      approvalId: "appr-7",
    });
    mocks.syncState.mockResolvedValue("PROPOSED");
    const result = await proposeGaFix(input(), MOCK_OFF);
    expect(result).toEqual({
      ok: true,
      changeId: "chg-7",
      status: "PROPOSED",
      created: false,
      approvalId: "appr-7",
    });
    expect(mocks.taskCreate).not.toHaveBeenCalled();
    expect(mocks.changeCreate).not.toHaveBeenCalled();
  });

  it("returns a row in another open status as is, without syncing", async () => {
    mocks.changeFindFirst.mockResolvedValue({
      id: "chg-7",
      status: "APPLYING",
      approvalId: "appr-7",
    });
    const result = await proposeGaFix(input(), MOCK_OFF);
    expect(result).toMatchObject({ ok: true, created: false, status: "APPLYING" });
    expect(mocks.syncState).not.toHaveBeenCalled();
  });

  it.each(["REJECTED", "EXPIRED"] as const)(
    "an open PROPOSED row whose approval closed (%s) is replaced by a fresh change",
    async (closed) => {
      mocks.changeFindFirst.mockResolvedValue({
        id: "chg-old",
        status: "PROPOSED",
        approvalId: "appr-old",
      });
      mocks.syncState.mockResolvedValue(closed);
      const result = await proposeGaFix(input(), MOCK_OFF);
      expect(mocks.syncState).toHaveBeenCalledWith("chg-old", { now: NOW });
      expect(result).toMatchObject({ ok: true, created: true, changeId: "chg-1" });
      expect(mocks.taskCreate).toHaveBeenCalledTimes(1);
    },
  );

  it("proposeAnnotation stores exactly ANNOTATION_CREATE:<dedupeKey>", async () => {
    const result = await proposeGaAnnotation(
      {
        projectId: "proj-1",
        title: "Agentelse: Spring sale launched",
        dedupeKey: "launch:abc123",
      },
      MOCK_OFF,
    );
    expect(result).toMatchObject({ ok: true, created: true });
    const created = mocks.changeCreate.mock.calls[0]![0].data;
    expect(created.dedupeKey).toBe("ANNOTATION_CREATE:launch:abc123");
    expect(created.openKey).toBe("ANNOTATION_CREATE:launch:abc123");
    expect(created).toMatchObject({
      source: "AUTO",
      proposedByType: "SYSTEM",
      proposedByUserId: null,
    });
    // Gün verilmedi: mülkün bugünü (Europe/Istanbul) kullanılır. Sabit tarih
    // her gün yarın bozulurdu; beklenen gün de aynı saat diliminden hesaplanır.
    const today = new Intl.DateTimeFormat("en-CA", {
      timeZone: "Europe/Istanbul",
    }).format(new Date());
    expect(created.params).toMatchObject({
      kind: "ANNOTATION_CREATE",
      day: today,
    });
  });

  it("a manual note's key is kind:day:title", async () => {
    await proposeGaFix(
      input({
        kind: "ANNOTATION_CREATE",
        raw: { title: "Agentelse: Price change", day: "2026-10-06" },
      }),
      MOCK_OFF,
    );
    const created = mocks.changeCreate.mock.calls[0]![0].data;
    expect(created.dedupeKey).toBe(
      "ANNOTATION_CREATE:2026-10-06:Agentelse: Price change",
    );
  });

  it("uses '-' as the subject for singleton kinds", async () => {
    await proposeGaFix(input({ kind: "RETENTION_14M", raw: {} }), MOCK_OFF);
    expect(mocks.changeCreate.mock.calls[0]![0].data.dedupeKey).toBe(
      "RETENTION_14M:-",
    );
  });
});
