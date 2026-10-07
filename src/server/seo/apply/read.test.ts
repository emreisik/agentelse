import { beforeEach, describe, expect, it, vi } from "vitest";

import { changeFixture, siteFixture } from "@/lib/seo/apply/test-support";

// Bu dosyanın kanıtladığı: bayrak kapalıyken iki okuyucu da sorgusuz null
// döner; PROPOSED satırın görünen durumu Approval satırından türer (sohbette
// verilen ret hemen "Rejected"); canDecide / canUndo (yazısı inmiş FAILED
// dahil) / canMakeLive matrisi; makale durumu iki tür için de creativeId
// SÜTUNUyla bulunur (JSON yol süzgeci yok); engel nedenleri sabit metindir.

const mocks = vi.hoisted(() => ({
  projectFindUnique: vi.fn(),
  approvalFindMany: vi.fn(),
  changeFindMany: vi.fn(),
  changeFindFirst: vi.fn(),
  loadCmsSite: vi.fn(),
  loadConnection: vi.fn(),
  isManager: vi.fn(),
  applied: vi.fn(),
  settings: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    project: { findUnique: mocks.projectFindUnique },
    approval: { findMany: mocks.approvalFindMany },
    seoChange: {
      findMany: mocks.changeFindMany,
      findFirst: mocks.changeFindFirst,
    },
  },
}));
vi.mock("@/server/integrations/wordpress/connection", () => ({
  loadCmsSite: mocks.loadCmsSite,
}));
vi.mock("@/server/integrations/wordpress/connect", () => ({
  loadWordPressConnectionView: mocks.loadConnection,
}));
vi.mock("./roles", () => ({ isManagerInline: mocks.isManager }));
vi.mock("./rate", () => ({ appliedCountSince: mocks.applied }));
vi.mock("./settings", () => ({ readApplySettings: mocks.settings }));

const { loadSeoApplyView, loadPublishStatus } = await import("./read");

const NOW = new Date("2026-10-07T12:00:00.000Z");
const CONNECTION = {
  connected: true,
  siteId: "site_1",
  origin: "https://example.com",
  host: "example.com",
  accountLabel: "agentelse @ example.com",
  health: "OK",
  healthLabel: "Connected",
  healthReason: null,
  seoPlugin: "YOAST",
  descriptionWritable: true,
  capabilities: null,
  lastCheckedAt: null,
  canManage: true,
  adminWarning: false,
  canRebind: false,
};

function enableFlags(): void {
  // Gerçek kip; CI'nın mock kipi sızmasın.
  vi.stubEnv("AGENTELSE_PROVIDER_MODE", "live");
  vi.stubEnv("SEO_APPLY", "true");
  vi.stubEnv("SEO_HEALTH", "true");
}

beforeEach(() => {
  vi.unstubAllEnvs();
  for (const mock of Object.values(mocks)) mock.mockReset();
  mocks.projectFindUnique.mockResolvedValue({ workspaceId: "ws_1" });
  mocks.approvalFindMany.mockResolvedValue([]);
  mocks.changeFindMany.mockResolvedValue([]);
  mocks.changeFindFirst.mockResolvedValue(null);
  mocks.loadCmsSite.mockResolvedValue(siteFixture());
  mocks.loadConnection.mockResolvedValue(CONNECTION);
  mocks.isManager.mockResolvedValue(true);
  mocks.applied.mockResolvedValue([]);
  mocks.settings.mockResolvedValue({ dailyLimit: 10, indexNow: null });
});

describe("flag off", () => {
  it("loadSeoApplyView returns null without any query", async () => {
    expect(await loadSeoApplyView({ projectId: "p1", userId: "u1" })).toBeNull();
    for (const mock of Object.values(mocks)) {
      expect(mock).not.toHaveBeenCalled();
    }
  });

  it("loadPublishStatus returns null without any query", async () => {
    expect(
      await loadPublishStatus({ projectId: "p1", creativeId: "c1", userId: "u1" }),
    ).toBeNull();
    for (const mock of Object.values(mocks)) {
      expect(mock).not.toHaveBeenCalled();
    }
  });
});

describe("loadSeoApplyView", () => {
  beforeEach(enableFlags);

  it("derives the PROPOSED status label from the Approval row", async () => {
    mocks.changeFindMany.mockResolvedValue([
      changeFixture({ id: "a", approvalId: "ap1" }),
      changeFixture({ id: "b", approvalId: "ap2" }),
      changeFixture({ id: "c", approvalId: "ap3" }),
      changeFixture({ id: "d", approvalId: "ap4" }),
    ]);
    mocks.approvalFindMany.mockResolvedValue([
      { id: "ap1", status: "PENDING" },
      { id: "ap2", status: "REJECTED" },
      { id: "ap3", status: "REVISION_REQUESTED" },
      { id: "ap4", status: "EXPIRED" },
    ]);
    const view = await loadSeoApplyView({
      projectId: "p1",
      userId: "u1",
      now: NOW,
    });
    expect(view?.changes.map((c) => c.statusLabel)).toEqual([
      "Waiting for approval",
      "Rejected",
      "Rejected",
      "Expired",
    ]);
    expect(view?.changes.map((c) => c.canDecide)).toEqual([
      true,
      false,
      false,
      false,
    ]);
  });

  it("only asks for the approvals of PROPOSED rows", async () => {
    mocks.changeFindMany.mockResolvedValue([
      changeFixture({ id: "a", status: "VERIFIED", approvalId: "ap1" }),
    ]);
    await loadSeoApplyView({ projectId: "p1", userId: "u1", now: NOW });
    expect(mocks.approvalFindMany).not.toHaveBeenCalled();
  });

  it("canDecide needs an owner or admin viewer", async () => {
    mocks.isManager.mockResolvedValue(false);
    mocks.changeFindMany.mockResolvedValue([
      changeFixture({ approvalId: "ap1" }),
    ]);
    mocks.approvalFindMany.mockResolvedValue([{ id: "ap1", status: "PENDING" }]);
    const view = await loadSeoApplyView({
      projectId: "p1",
      userId: "u1",
      now: NOW,
    });
    expect(view?.canManage).toBe(false);
    expect(view?.changes[0]?.canDecide).toBe(false);
  });

  it("canUndo covers VERIFIED and a written FAILED row, not noops or unwritten rows", async () => {
    const appliedAt = new Date(NOW.getTime() - 3_600_000);
    mocks.changeFindMany.mockResolvedValue([
      changeFixture({ id: "v", status: "VERIFIED", appliedAt, openKey: null }),
      changeFixture({ id: "fw", status: "FAILED", appliedAt, openKey: null }),
      changeFixture({ id: "fu", status: "FAILED", appliedAt: null, openKey: null }),
      changeFixture({
        id: "n",
        status: "VERIFIED",
        noop: true,
        appliedAt,
        openKey: null,
      }),
      changeFixture({
        id: "old",
        status: "VERIFIED",
        appliedAt: new Date(NOW.getTime() - 100 * 24 * 3_600_000),
        openKey: null,
      }),
    ]);
    const view = await loadSeoApplyView({
      projectId: "p1",
      userId: "u1",
      now: NOW,
    });
    expect(
      Object.fromEntries(view?.changes.map((c) => [c.id, c.canUndo]) ?? []),
    ).toEqual({ v: true, fw: true, fu: false, n: false, old: false });
  });

  it("canMakeLive is true for a VERIFIED article without an open live change", async () => {
    mocks.changeFindMany.mockImplementation(
      async (args: { where: { kind?: string } }) =>
        args.where.kind === "PUBLISH_LIVE"
          ? [{ params: { draftChangeId: "art2" } }]
          : [
              changeFixture({
                id: "art1",
                kind: "PUBLISH_ARTICLE",
                status: "VERIFIED",
                openKey: null,
              }),
              changeFixture({
                id: "art2",
                kind: "PUBLISH_ARTICLE",
                status: "VERIFIED",
                openKey: null,
              }),
              changeFixture({
                id: "art3",
                kind: "PUBLISH_ARTICLE",
                status: "VERIFIED",
                noop: true,
                openKey: null,
              }),
              changeFixture({ id: "meta", status: "VERIFIED", openKey: null }),
            ],
    );
    const view = await loadSeoApplyView({
      projectId: "p1",
      userId: "u1",
      now: NOW,
    });
    expect(
      Object.fromEntries(view?.changes.map((c) => [c.id, c.canMakeLive]) ?? []),
    ).toEqual({ art1: true, art2: false, art3: false, meta: false });
  });

  it("reports the daily usage from the rolling 24 hour window", async () => {
    mocks.settings.mockResolvedValue({ dailyLimit: 3, indexNow: null });
    mocks.applied.mockResolvedValue([
      new Date(NOW.getTime() - 3_600_000),
      new Date(NOW.getTime() - 7_200_000),
    ]);
    const view = await loadSeoApplyView({
      projectId: "p1",
      userId: "u1",
      now: NOW,
    });
    expect(view?.dailyLimit).toBe(3);
    expect(view?.usedToday).toBe(2);
    expect(mocks.applied).toHaveBeenCalledWith(
      "site_1",
      new Date(NOW.getTime() - 24 * 3_600_000),
    );
  });

  it("falls back to a not-connected view without a site", async () => {
    mocks.loadCmsSite.mockResolvedValue(null);
    mocks.loadConnection.mockResolvedValue(null);
    const view = await loadSeoApplyView({
      projectId: "p1",
      userId: "u1",
      now: NOW,
    });
    expect(view?.connection.connected).toBe(false);
    expect(view?.connection.health).toBe("UNKNOWN");
    expect(view?.usedToday).toBe(0);
    expect(mocks.applied).not.toHaveBeenCalled();
  });
});

describe("loadPublishStatus", () => {
  beforeEach(enableFlags);

  const input = { projectId: "p1", creativeId: "cr1", userId: "u1", now: NOW };

  it("finds the article and the live change by the creativeId column", async () => {
    mocks.changeFindFirst.mockImplementation(
      async (args: { where: { kind: string } }) =>
        args.where.kind === "PUBLISH_ARTICLE"
          ? changeFixture({
              id: "art",
              kind: "PUBLISH_ARTICLE",
              status: "VERIFIED",
              creativeId: "cr1",
              openKey: null,
            })
          : changeFixture({
              id: "live",
              kind: "PUBLISH_LIVE",
              status: "PROPOSED",
              creativeId: "cr1",
              params: { kind: "PUBLISH_LIVE", draftChangeId: "art" },
              approvalId: "ap1",
            }),
    );
    mocks.approvalFindMany.mockResolvedValue([{ id: "ap1", status: "PENDING" }]);
    const view = await loadPublishStatus(input);

    const wheres = mocks.changeFindFirst.mock.calls.map((call) => call[0].where);
    expect(wheres).toEqual([
      { projectId: "p1", creativeId: "cr1", kind: "PUBLISH_ARTICLE" },
      { projectId: "p1", creativeId: "cr1", kind: "PUBLISH_LIVE" },
    ]);
    expect(JSON.stringify(wheres)).not.toContain("path");
    expect(view?.change?.id).toBe("art");
    expect(view?.liveChange?.id).toBe("live");
    // Açık PUBLISH_LIVE varken "Make it live" kapalıdır.
    expect(view?.change?.canMakeLive).toBe(false);
    expect(view?.liveChange?.canDecide).toBe(true);
    expect(view?.canPropose).toBe(false);
    expect(view?.isManager).toBe(true);
  });

  it("allows a new proposal for a healthy site with no change yet", async () => {
    const view = await loadPublishStatus(input);
    expect(view).toMatchObject({
      connected: true,
      healthy: true,
      canPropose: true,
      blockedReason: null,
      change: null,
      liveChange: null,
      connectHref: "/projects/p1/integrations?integration=wordpress",
    });
  });

  it("offers Make it live for a VERIFIED draft", async () => {
    mocks.changeFindFirst.mockImplementation(
      async (args: { where: { kind: string } }) =>
        args.where.kind === "PUBLISH_ARTICLE"
          ? changeFixture({
              id: "art",
              kind: "PUBLISH_ARTICLE",
              status: "VERIFIED",
              creativeId: "cr1",
              openKey: null,
            })
          : null,
    );
    const view = await loadPublishStatus(input);
    expect(view?.change?.canMakeLive).toBe(true);
    expect(view?.canPropose).toBe(false);
  });

  it("explains why it cannot propose", async () => {
    mocks.loadCmsSite.mockResolvedValue(null);
    expect((await loadPublishStatus(input))?.blockedReason).toBe(
      "Connect WordPress first.",
    );

    mocks.loadCmsSite.mockResolvedValue(siteFixture({ health: "AUTH" }));
    const unhealthy = await loadPublishStatus(input);
    expect(unhealthy?.healthy).toBe(false);
    expect(unhealthy?.canPropose).toBe(false);

    mocks.loadCmsSite.mockResolvedValue(
      siteFixture({
        health: "LIMITED",
        capabilities: { draftPosts: false },
      }),
    );
    const noDraft = await loadPublishStatus(input);
    expect(noDraft?.healthy).toBe(true);
    expect(noDraft?.canPropose).toBe(false);
    expect(noDraft?.blockedReason).toContain("not allowed");
  });

  it("treats a mock site as unhealthy in a real process", async () => {
    mocks.loadCmsSite.mockResolvedValue(siteFixture({ isMock: true }));
    expect((await loadPublishStatus(input))?.healthy).toBe(false);
  });

  it("members can propose but are not managers", async () => {
    mocks.isManager.mockResolvedValue(false);
    const view = await loadPublishStatus(input);
    expect(view?.isManager).toBe(false);
    expect(view?.canPropose).toBe(true);
  });
});
