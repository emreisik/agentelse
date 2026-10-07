import { beforeEach, describe, expect, it, vi } from "vitest";

// Bu dosyanın kanıtladığı: bayrak kapalıyken (ya da dev izin listesi dışında)
// okuyucu sorgusuz null döner; görünüm şekli ve ISO metinler; canDecide /
// canUndo / canManage / canMuteOutside kuralları; PROPOSED satırın durumu
// Approval satırından türer (sohbette ret hemen "Rejected"); kapatma anahtarı
// kapalıyken APPROVED alpha satır "switched off" gösterir; öneriler gerçek
// computeFixOffers'tan gelir; çıktıda mülk adı ve Google verisi yok.

const mocks = vi.hoisted(() => ({
  memberFindUnique: vi.fn(),
  changeFindMany: vi.fn(),
  approvalFindMany: vi.fn(),
  primaryGaLink: vi.fn(),
  listOpen: vi.fn(),
  editAccess: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    workspaceMember: { findUnique: mocks.memberFindUnique },
    gaConfigChange: { findMany: mocks.changeFindMany },
    approval: { findMany: mocks.approvalFindMany },
  },
}));
vi.mock("@/server/website-analytics/store", () => ({
  primaryGaLink: mocks.primaryGaLink,
}));
vi.mock("@/server/monitoring/site-alerts", () => ({
  SiteAlerts: { listOpen: mocks.listOpen },
}));
vi.mock("./edit-grant", () => ({ loadGaEditAccess: mocks.editAccess }));

const { loadGaFixesView, listRecentGaConfigChanges } = await import("./read");

const NOW = new Date("2026-10-07T21:30:00.000Z");
const LINK = {
  id: "link-1",
  workspaceId: "w1",
  projectId: "proj-1",
  propertyId: "424242",
  propertyName: "Acme Web Secret",
  timeZone: "Pacific/Auckland",
  keyEvents: [{ eventName: "purchase", countingMethod: "ONCE_PER_EVENT" }],
  dataRetention: "TWO_MONTHS",
  streamId: "stream-1",
  serviceLevel: "GOOGLE_ANALYTICS_STANDARD",
};

function row(overrides: Record<string, unknown> = {}) {
  return {
    id: "c1",
    kind: "RETENTION_14M",
    status: "PROPOSED",
    source: "GUIDE",
    title: "Keep Google Analytics event data for 14 months",
    dedupeKey: "RETENTION_14M:-",
    noop: false,
    approvalId: "a1",
    createdAt: new Date("2026-10-06T10:00:00.000Z"),
    updatedAt: new Date("2026-10-06T10:00:00.000Z"),
    expiresAt: new Date("2026-10-13T10:00:00.000Z"),
    verifiedAt: null,
    rolledBackAt: null,
    failedAt: null,
    error: null,
    ...overrides,
  };
}

function alert(overrides: Record<string, unknown> = {}) {
  return {
    id: "al1",
    source: "GA4",
    kind: "GA_CHG_KEY_EVENT_REMOVED",
    severity: "WARN",
    title: "A key event was removed in Google Analytics",
    detail: null,
    lastSeenAt: new Date("2026-10-07T08:00:00.000Z"),
    dedupeKey: "ga4:link-1:CHG:KEY_EVENT_REMOVED:generate_lead",
    ...overrides,
  };
}

const CHECKS = [
  {
    key: "MH14" as const,
    status: "WARN" as const,
    evidence: { reason: "two_months" },
  },
];

function view(overrides: Partial<Parameters<typeof loadGaFixesView>[0]> = {}) {
  return loadGaFixesView({
    projectId: "proj-1",
    userId: "u1",
    checks: CHECKS,
    now: NOW,
    ...overrides,
  });
}

function setApproval(status: string, reviewedAt: Date | null = null) {
  mocks.approvalFindMany.mockResolvedValue([{ id: "a1", status, reviewedAt }]);
}

beforeEach(() => {
  vi.unstubAllEnvs();
  vi.stubEnv("GA_SYNC", "true");
  vi.stubEnv("GA_FIXES", "true");
  vi.stubEnv("GA_FIXES_ALPHA", "true");
  vi.stubEnv("GA_HEALTH", "true");
  for (const mock of Object.values(mocks)) mock.mockReset();
  mocks.primaryGaLink.mockResolvedValue(LINK);
  mocks.memberFindUnique.mockResolvedValue({ role: "OWNER" });
  mocks.changeFindMany.mockResolvedValue([]);
  mocks.approvalFindMany.mockResolvedValue([]);
  mocks.listOpen.mockResolvedValue([]);
  mocks.editAccess.mockResolvedValue({ granted: true });
});

describe("loadGaFixesView: kapılar", () => {
  it("returns null without any query when GA_FIXES is off", async () => {
    vi.stubEnv("GA_FIXES", "false");
    expect(await view()).toBeNull();
    for (const mock of Object.values(mocks)) {
      expect(mock).not.toHaveBeenCalled();
    }
  });

  it("returns null in a dev process for a project outside the allow-list", async () => {
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("DATABASE_URL", "postgresql://u:p@ep-live.neon.tech/db");
    vi.stubEnv("GA_SYNC_DEV_PROJECTS", "someone-else");
    expect(await view()).toBeNull();
    expect(mocks.primaryGaLink).not.toHaveBeenCalled();
  });

  it("returns null when the project has no primary link", async () => {
    mocks.primaryGaLink.mockResolvedValue(null);
    expect(await view()).toBeNull();
    expect(mocks.changeFindMany).not.toHaveBeenCalled();
  });
});

describe("loadGaFixesView: şekil", () => {
  it("builds a serialisable view of the latest changes", async () => {
    mocks.changeFindMany.mockResolvedValue([row()]);
    setApproval("PENDING");
    const result = await view();

    expect(mocks.changeFindMany).toHaveBeenCalledWith({
      where: { linkId: "link-1" },
      orderBy: { createdAt: "desc" },
      take: 30,
    });
    expect(mocks.listOpen).toHaveBeenCalledWith("proj-1", ["GA4"], 100);
    expect(result).toMatchObject({
      editAccess: "granted",
      canManage: true,
      alphaEnabled: true,
      canMuteOutside: true,
      upgradeHref:
        "/api/integrations/google/start?projectId=proj-1&service=analytics&upgrade=edit",
      outside: [],
      // Pasifik/Auckland'da 8 Ekim sabahı (UTC 21:30).
      annotationDefaultDay: "2026-10-08",
    });
    expect(result?.changes).toEqual([
      {
        id: "c1",
        kind: "RETENTION_14M",
        title: "Keep Google Analytics event data for 14 months",
        status: "PROPOSED",
        statusLabel: "Waiting for approval",
        source: "GUIDE",
        createdAt: "2026-10-06T10:00:00.000Z",
        resolvedAt: null,
        expiresAt: "2026-10-13T10:00:00.000Z",
        approvalId: "a1",
        canDecide: true,
        canUndo: false,
        undoWarning: expect.stringContaining("shortens"),
        noop: false,
        switchedOff: false,
        error: null,
      },
    ]);
    // JSON'a çevrilebilir: Date nesnesi kalmaz.
    expect(JSON.parse(JSON.stringify(result))).toEqual(result);
  });

  it("only looks up approvals of PROPOSED rows", async () => {
    mocks.changeFindMany.mockResolvedValue([
      row({ id: "c1", approvalId: "a1" }),
      row({ id: "c2", status: "VERIFIED", approvalId: "a2" }),
    ]);
    setApproval("PENDING");
    await view();
    expect(mocks.approvalFindMany).toHaveBeenCalledWith({
      where: { id: { in: ["a1"] } },
      select: { id: true, status: true, reviewedAt: true },
    });
  });

  it("makes no approval query when no row is PROPOSED", async () => {
    mocks.changeFindMany.mockResolvedValue([row({ status: "VERIFIED" })]);
    await view();
    expect(mocks.approvalFindMany).not.toHaveBeenCalled();
  });

  it("carries no property name, id or Google metric", async () => {
    mocks.changeFindMany.mockResolvedValue([row()]);
    mocks.listOpen.mockResolvedValue([alert()]);
    setApproval("PENDING");
    const text = JSON.stringify(await view());
    expect(text).not.toContain("Acme Web Secret");
    expect(text).not.toContain("424242");
    expect(text).not.toContain("stream-1");
    expect(text).not.toContain("workspaceId");
  });
});

describe("loadGaFixesView: yetkiler", () => {
  it("lets only owners and admins decide or manage", async () => {
    mocks.changeFindMany.mockResolvedValue([row()]);
    setApproval("PENDING");
    for (const role of ["OWNER", "ADMIN"]) {
      mocks.memberFindUnique.mockResolvedValue({ role });
      const result = await view();
      expect(result?.canManage).toBe(true);
      expect(result?.changes[0]?.canDecide).toBe(true);
    }
    for (const member of [{ role: "MEMBER" }, null]) {
      mocks.memberFindUnique.mockResolvedValue(member);
      const result = await view();
      expect(result?.canManage).toBe(false);
      expect(result?.changes[0]?.canDecide).toBe(false);
    }
    expect(mocks.memberFindUnique).toHaveBeenCalledWith({
      where: { workspaceId_userId: { workspaceId: "w1", userId: "u1" } },
      select: { role: true },
    });
  });

  it("cannot decide once the approval is no longer pending", async () => {
    mocks.changeFindMany.mockResolvedValue([row()]);
    setApproval("APPROVED");
    expect((await view())?.changes[0]?.canDecide).toBe(false);
  });

  it("allows undo only for a verified, non-noop, undoable change by a manager", async () => {
    const retention = {
      before: { kind: "RETENTION_14M", eventDataRetention: "TWO_MONTHS" },
      after: { kind: "RETENTION_14M", eventDataRetention: "FOURTEEN_MONTHS" },
    };
    mocks.changeFindMany.mockResolvedValue([
      row({ id: "ok", status: "VERIFIED", verifiedAt: NOW, ...retention }),
      row({
        id: "noop",
        status: "VERIFIED",
        noop: true,
        verifiedAt: NOW,
        ...retention,
      }),
      row({ id: "undone", status: "UNDONE", rolledBackAt: NOW, ...retention }),
    ]);
    const result = await view();
    expect(
      result?.changes.map((change) => [change.id, change.canUndo]),
    ).toEqual([
      ["ok", true],
      ["noop", false],
      ["undone", false],
    ]);
    mocks.memberFindUnique.mockResolvedValue({ role: "MEMBER" });
    const member = await view();
    expect(member?.changes[0]?.canUndo).toBe(false);
  });

  it("hides undo when the snapshots say it cannot work (Google-defined, non-deletable key event)", async () => {
    const keyEvent = (deletable: boolean | null) => ({
      kind: "KEY_EVENT_CREATE",
      before: {
        kind: "KEY_EVENT_CREATE",
        exists: false,
        resourceName: null,
        deletable: null,
      },
      after: {
        kind: "KEY_EVENT_CREATE",
        exists: true,
        resourceName: "properties/1/keyEvents/9",
        deletable,
      },
      resourceName: "properties/1/keyEvents/9",
    });
    mocks.changeFindMany.mockResolvedValue([
      row({ id: "custom", status: "VERIFIED", verifiedAt: NOW, ...keyEvent(true) }),
      row({ id: "builtin", status: "VERIFIED", verifiedAt: NOW, ...keyEvent(false) }),
      row({ id: "nosnapshot", status: "VERIFIED", verifiedAt: NOW }),
    ]);
    const result = await view();
    expect(
      result?.changes.map((change) => [change.id, change.canUndo]),
    ).toEqual([
      ["custom", true],
      ["builtin", false],
      ["nosnapshot", false],
    ]);
  });

  it("hides the mute control without GA_HEALTH", async () => {
    vi.stubEnv("GA_HEALTH", "false");
    expect((await view())?.canMuteOutside).toBe(false);
  });

  it("reports not_granted when the edit grant is missing", async () => {
    mocks.editAccess.mockResolvedValue({ granted: false });
    expect((await view())?.editAccess).toBe("not_granted");
    mocks.editAccess.mockResolvedValue(null);
    expect((await view())?.editAccess).toBe("not_granted");
  });
});

describe("loadGaFixesView: türetilen durum", () => {
  it.each([
    ["REJECTED", "REJECTED", "Rejected"],
    ["REVISION_REQUESTED", "REJECTED", "Rejected"],
    ["CANCELLED", "EXPIRED", "Expired"],
    ["EXPIRED", "EXPIRED", "Expired"],
  ])(
    "shows a PROPOSED row as %s -> %s when its approval was decided elsewhere",
    async (approval, status, label) => {
      mocks.changeFindMany.mockResolvedValue([row()]);
      setApproval(approval, new Date("2026-10-07T09:00:00.000Z"));
      const change = (await view())?.changes[0];
      expect(change).toMatchObject({
        status,
        statusLabel: label,
        canDecide: false,
        expiresAt: null,
        resolvedAt: "2026-10-07T09:00:00.000Z",
      });
    },
  );

  it("keeps APPROVED as stored for an approval that is approved", async () => {
    mocks.changeFindMany.mockResolvedValue([row()]);
    setApproval("APPROVED");
    expect((await view())?.changes[0]).toMatchObject({
      status: "PROPOSED",
      statusLabel: "Waiting for approval",
    });
  });

  it("picks the resolved time per terminal status", async () => {
    const at = (day: number) => new Date(`2026-10-0${day}T00:00:00.000Z`);
    mocks.changeFindMany.mockResolvedValue([
      row({ id: "v", status: "VERIFIED", verifiedAt: at(2) }),
      row({ id: "f", status: "FAILED", failedAt: at(3) }),
      row({ id: "u", status: "UNDONE", rolledBackAt: at(4) }),
      row({ id: "a", status: "APPLIED" }),
    ]);
    const changes = (await view())?.changes ?? [];
    expect(changes.map((change) => change.resolvedAt)).toEqual([
      "2026-10-02T00:00:00.000Z",
      "2026-10-03T00:00:00.000Z",
      "2026-10-04T00:00:00.000Z",
      null,
    ]);
  });
});

describe("loadGaFixesView: kapatma anahtarı ve hata", () => {
  it("marks an APPROVED alpha row as switched off while the kill switch is off", async () => {
    vi.stubEnv("GA_FIXES_ALPHA", "false");
    mocks.changeFindMany.mockResolvedValue([
      row({ kind: "ENHANCED_MEASUREMENT", status: "APPROVED" }),
      row({ id: "c2", kind: "RETENTION_14M", status: "APPROVED" }),
    ]);
    const result = await view();
    expect(result?.alphaEnabled).toBe(false);
    expect(result?.changes[0]).toMatchObject({
      switchedOff: true,
      statusLabel: "Approved, switched off right now",
    });
    expect(result?.changes[1]).toMatchObject({
      switchedOff: false,
      statusLabel: "Approved, applying",
    });
  });

  it("does not mark it when the kill switch is on", async () => {
    mocks.changeFindMany.mockResolvedValue([
      row({ kind: "ENHANCED_MEASUREMENT", status: "APPROVED" }),
    ]);
    expect((await view())?.changes[0]?.switchedOff).toBe(false);
  });

  it("shows the fixed message of a known error code, not stored text", async () => {
    mocks.changeFindMany.mockResolvedValue([
      row({
        status: "FAILED",
        error: { code: "readback_mismatch", message: "raw google text 424242" },
      }),
      row({ id: "c2", status: "FAILED", error: { code: "weird" } }),
      row({ id: "c3", status: "FAILED", error: null }),
    ]);
    const changes = (await view())?.changes ?? [];
    expect(changes[0]?.error).toEqual({
      code: "readback_mismatch",
      message:
        "Google accepted the change, but it doesn't show up yet. Check it in Google Analytics.",
    });
    expect(changes[1]?.error).toBeNull();
    expect(changes[2]?.error).toBeNull();
    expect(JSON.stringify(changes)).not.toContain("raw google text");
  });

  it("shows an undo failure on a VERIFIED row and hides stale errors elsewhere", async () => {
    mocks.changeFindMany.mockResolvedValue([
      row({
        status: "VERIFIED",
        error: { code: "cannot_undo", undo: true },
      }),
      row({ id: "c2", status: "VERIFIED", error: { code: "unknown" } }),
    ]);
    const changes = (await view())?.changes ?? [];
    expect(changes[0]?.error?.code).toBe("cannot_undo");
    expect(changes[1]?.error).toBeNull();
  });
});

describe("loadGaFixesView: Agentelse dışı değişiklikler", () => {
  it("lists only this link's GA_CHG_ alerts", async () => {
    mocks.listOpen.mockResolvedValue([
      alert(),
      alert({
        id: "al2",
        kind: "GA_CHG_RETENTION_SHORTENED",
        title: "Event data retention was shortened in Google Analytics",
        dedupeKey: "ga4:link-1:CHG:RETENTION",
      }),
      alert({ id: "al3", kind: "GA_MH5", dedupeKey: "ga4:link-1:MH5" }),
      alert({
        id: "al4",
        dedupeKey: "ga4:other-link:CHG:KEY_EVENT_REMOVED:x",
      }),
    ]);
    const result = await view();
    expect(result?.outside).toEqual([
      {
        alertId: "al1",
        kind: "KEY_EVENT_REMOVED",
        title: "A key event was removed in Google Analytics",
        detail: null,
        lastSeenAt: "2026-10-07T08:00:00.000Z",
      },
      {
        alertId: "al2",
        kind: "RETENTION_SHORTENED",
        title: "Event data retention was shortened in Google Analytics",
        detail: null,
        lastSeenAt: "2026-10-07T08:00:00.000Z",
      },
    ]);
  });
});

describe("loadGaFixesView: öneriler", () => {
  it("offers the retention fix and the channel group when editing is allowed", async () => {
    const result = await view();
    expect(result?.offers.map((offer) => [offer.kind, offer.state])).toEqual([
      ["RETENTION_14M", "available"],
      ["CHANNEL_GROUP_AI", "available"],
    ]);
  });

  it("asks for edit access when the grant is missing", async () => {
    mocks.editAccess.mockResolvedValue({ granted: false });
    const result = await view();
    expect(
      result?.offers.every((offer) => offer.state === "needs_access"),
    ).toBe(true);
  });

  it("hides alpha offers while the kill switch is off", async () => {
    vi.stubEnv("GA_FIXES_ALPHA", "false");
    const result = await view();
    expect(result?.offers.map((offer) => offer.kind)).toEqual([
      "RETENTION_14M",
    ]);
  });

  it("marks an offer pending while a change of that kind is open", async () => {
    mocks.changeFindMany.mockResolvedValue([row()]);
    setApproval("PENDING");
    const offer = (await view())?.offers.find(
      (item) => item.kind === "RETENTION_14M",
    );
    expect(offer).toMatchObject({ state: "pending", changeId: "c1" });
  });

  it("offers it again once the approval was rejected in the chat", async () => {
    mocks.changeFindMany.mockResolvedValue([row()]);
    setApproval("REJECTED");
    const offer = (await view())?.offers.find(
      (item) => item.kind === "RETENTION_14M",
    );
    expect(offer).toMatchObject({ state: "available", changeId: null });
  });

  it("offers nothing without checks except the standalone channel group", async () => {
    const result = await view({ checks: undefined });
    expect(result?.offers.map((offer) => offer.kind)).toEqual([
      "CHANNEL_GROUP_AI",
    ]);
  });

  it("excludes stored key events from the key-event options", async () => {
    const result = await view({
      checks: [
        {
          key: "MH5",
          status: "WARN",
          evidence: { reason: "only_purchase" },
        },
      ],
    });
    const offer = result?.offers.find(
      (item) => item.kind === "KEY_EVENT_CREATE",
    );
    expect(offer?.field?.options.map((option) => option.value)).not.toContain(
      "purchase",
    );
  });
});

describe("listRecentGaConfigChanges", () => {
  it("returns an empty list without a query when the flag is off", async () => {
    vi.stubEnv("GA_FIXES", "false");
    expect(await listRecentGaConfigChanges("proj-1", 7, NOW)).toEqual([]);
    expect(mocks.changeFindMany).not.toHaveBeenCalled();
  });

  it("returns kind, status and time for the window", async () => {
    mocks.changeFindMany.mockResolvedValue([
      {
        kind: "RETENTION_14M",
        status: "VERIFIED",
        createdAt: new Date("2026-10-05T10:00:00.000Z"),
        verifiedAt: new Date("2026-10-05T10:05:00.000Z"),
      },
      {
        kind: "KEY_EVENT_CREATE",
        status: "PROPOSED",
        createdAt: new Date("2026-10-06T10:00:00.000Z"),
        verifiedAt: null,
      },
      {
        kind: "SOMETHING_ELSE",
        status: "PROPOSED",
        createdAt: new Date("2026-10-06T10:00:00.000Z"),
        verifiedAt: null,
      },
    ]);
    const result = await listRecentGaConfigChanges("proj-1", 7, NOW);
    expect(mocks.changeFindMany).toHaveBeenCalledWith({
      where: {
        projectId: "proj-1",
        createdAt: { gte: new Date("2026-09-30T21:30:00.000Z") },
      },
      select: { kind: true, status: true, createdAt: true, verifiedAt: true },
      orderBy: { createdAt: "desc" },
      take: 200,
    });
    expect(result).toEqual([
      {
        kind: "RETENTION_14M",
        status: "VERIFIED",
        at: "2026-10-05T10:05:00.000Z",
      },
      {
        kind: "KEY_EVENT_CREATE",
        status: "PROPOSED",
        at: "2026-10-06T10:00:00.000Z",
      },
    ]);
  });
});
