import { beforeEach, describe, expect, it, vi } from "vitest";

// Bu dosyanın kanıtladığı (SC-F3 eylemleri): altısı da oturum ve proje
// erişimi ister, SEO_HEALTH kapalıyken ve açılış listesi dışındaki projede
// hiçbir iş yapmaz; tarama ayarı ve "Delete audit data" yalnız OWNER/ADMIN;
// requestInspection sonuçları doğru mesaja döner; başka kaynaklı (ör. reklam)
// uyarı susturulamaz; başarıda denetim kaydı yazılır ve Search sayfası
// tazelenir. Kardeş paketlerin modülleri taklit edilir.

const mocks = vi.hoisted(() => ({
  revalidatePath: vi.fn(),
  requireUser: vi.fn(),
  requireProjectAccess: vi.fn(),
  isWorkspaceManager: vi.fn(),
  record: vi.fn(),
  health: vi.fn(),
  crawl: vi.fn(),
  allowed: vi.fn(),
  requestInspection: vi.fn(),
  checkSiteVerification: vi.fn(),
  setCrawlSettings: vi.fn(),
  requestRecrawl: vi.fn(),
  deleteAuditData: vi.fn(),
  muteSearchAlert: vi.fn(),
}));

vi.mock("next/cache", () => ({ revalidatePath: mocks.revalidatePath }));
vi.mock("@/server/security/tenant-context", () => ({
  requireUser: mocks.requireUser,
  requireProjectAccess: mocks.requireProjectAccess,
  isWorkspaceManager: mocks.isWorkspaceManager,
}));
vi.mock("@/server/repositories/audit-log.repository", () => ({
  AuditLogRepository: { record: mocks.record },
}));
vi.mock("@/lib/seo/health-flags", () => ({
  SeoFlags: { health: mocks.health, crawl: mocks.crawl },
  seoWorkAllowedFor: mocks.allowed,
}));
vi.mock("@/lib/seo/crawl-url", () => ({
  normalizeCrawlUrl: (url: string) => url,
  crawlUrlHash: () => "hash-1",
}));
vi.mock("@/server/seo/health/inspection", () => ({
  SeoInspection: { requestInspection: mocks.requestInspection },
}));
vi.mock("@/server/seo/site/verify", () => ({
  checkSiteVerification: mocks.checkSiteVerification,
}));
vi.mock("@/server/seo/site/sites", () => ({
  SeoSites: {
    setCrawlSettings: mocks.setCrawlSettings,
    requestRecrawl: mocks.requestRecrawl,
    deleteAuditData: mocks.deleteAuditData,
  },
}));
vi.mock("@/server/seo/health/alerts", () => ({
  muteSearchAlert: mocks.muteSearchAlert,
}));

const actions = await import("./search-health-actions");
const {
  checkSiteVerificationAction,
  deleteSiteAuditDataAction,
  muteSearchAlertAction,
  recrawlSiteAction,
  requestInspectionAction,
  setSiteCrawlAction,
} = actions;

const form = (fields: Record<string, string> = {}) => {
  const data = new FormData();
  data.set("projectId", "proj-1");
  for (const [key, value] of Object.entries(fields)) data.set(key, value);
  return data;
};

// Altı eylem, geçerli girdileriyle.
const ALL: [string, () => Promise<unknown>][] = [
  [
    "requestInspection",
    () => requestInspectionAction(form({ url: "https://www.example.com/a" })),
  ],
  ["checkSiteVerification", () => checkSiteVerificationAction(form())],
  [
    "setSiteCrawl",
    () => setSiteCrawlAction(form({ crawlEnabled: "on", pageLimit: "250" })),
  ],
  ["recrawlSite", () => recrawlSiteAction(form())],
  [
    "muteSearchAlert",
    () => muteSearchAlertAction(form({ alertId: "alert-1" })),
  ],
  ["deleteSiteAuditData", () => deleteSiteAuditDataAction(form())],
];

const WORK = [
  "requestInspection",
  "checkSiteVerification",
  "setCrawlSettings",
  "requestRecrawl",
  "deleteAuditData",
  "muteSearchAlert",
] as const;

function expectNoWork() {
  for (const name of WORK) expect(mocks[name], name).not.toHaveBeenCalled();
  expect(mocks.record).not.toHaveBeenCalled();
  expect(mocks.revalidatePath).not.toHaveBeenCalled();
}

beforeEach(() => {
  for (const mock of Object.values(mocks)) mock.mockReset();
  mocks.requireUser.mockResolvedValue({ userId: "user-1", email: null });
  mocks.requireProjectAccess.mockResolvedValue({
    workspaceId: "ws-1",
    projectId: "proj-1",
    defaultBrandId: "brand-1",
  });
  mocks.isWorkspaceManager.mockResolvedValue(true);
  mocks.record.mockResolvedValue({});
  mocks.health.mockReturnValue(true);
  mocks.crawl.mockReturnValue(true);
  mocks.allowed.mockReturnValue(true);
  mocks.requestInspection.mockResolvedValue("queued");
  mocks.checkSiteVerification.mockResolvedValue({ ok: true, method: "META" });
  mocks.setCrawlSettings.mockResolvedValue(undefined);
  mocks.requestRecrawl.mockResolvedValue("queued");
  mocks.deleteAuditData.mockResolvedValue(12);
  mocks.muteSearchAlert.mockResolvedValue(true);
});

describe("every search health action", () => {
  it.each(ALL)(
    "%s succeeds and revalidates the Search page",
    async (_, run) => {
      expect(await run()).toEqual({ ok: true });
      expect(mocks.requireProjectAccess).toHaveBeenCalledWith(
        "user-1",
        "proj-1",
      );
      expect(mocks.allowed).toHaveBeenCalledWith("proj-1");
      expect(mocks.revalidatePath).toHaveBeenCalledWith(
        "/projects/proj-1/arama",
      );
      expect(mocks.record).toHaveBeenCalledTimes(1);
    },
  );

  it.each(ALL)("%s requires a signed-in user", async (_, run) => {
    mocks.requireUser.mockRejectedValue(new Error("Authentication required"));
    expect(await run()).toEqual({
      ok: false,
      message: "Authentication required",
    });
    expect(mocks.requireProjectAccess).not.toHaveBeenCalled();
    expectNoWork();
  });

  it.each(ALL)("%s requires project access", async (_, run) => {
    mocks.requireProjectAccess.mockRejectedValue(new Error("No access"));
    expect(await run()).toEqual({ ok: false, message: "No access" });
    expectNoWork();
  });

  it.each(ALL)("%s does nothing while SEO_HEALTH is off", async (_, run) => {
    mocks.health.mockReturnValue(false);
    expect(await run()).toEqual({
      ok: false,
      message: "Search health is not available.",
    });
    expectNoWork();
  });

  it.each(ALL)("%s checks the allow-list", async (_, run) => {
    mocks.allowed.mockReturnValue(false);
    expect(await run()).toEqual({
      ok: false,
      message: "Search health is not enabled for this project yet.",
    });
    expectNoWork();
  });
});

describe("requestInspectionAction", () => {
  it("queues the page as a user request and audits only its hash", async () => {
    await requestInspectionAction(
      form({ url: "https://www.example.com/pricing" }),
    );
    expect(mocks.requestInspection).toHaveBeenCalledWith({
      projectId: "proj-1",
      url: "https://www.example.com/pricing",
      by: "user",
    });
    expect(mocks.record).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "seo_site.inspection_requested",
        entityType: "SeoSite",
        actorType: "USER",
        actorId: "user-1",
        workspaceId: "ws-1",
        projectId: "proj-1",
        metadata: { urlHash: "hash-1" },
      }),
    );
  });

  it.each([
    ["out_of_scope", "This page is outside your Search Console property."],
    ["no_link", "Connect Search Console to check pages with Google."],
    ["full", "Up to 20 pages can wait for inspection."],
    ["already_queued", "This page is already waiting for inspection."],
  ])("maps %s to its message", async (result, message) => {
    mocks.requestInspection.mockResolvedValue(result);
    expect(
      await requestInspectionAction(form({ url: "https://www.example.com/a" })),
    ).toEqual({ ok: false, message });
    expect(mocks.record).not.toHaveBeenCalled();
    expect(mocks.revalidatePath).not.toHaveBeenCalled();
  });

  it("rejects a missing address", async () => {
    const result = await requestInspectionAction(form());
    expect(result.ok).toBe(false);
    expect(mocks.requestInspection).not.toHaveBeenCalled();
  });
});

describe("checkSiteVerificationAction", () => {
  it("audits a successful verification", async () => {
    await checkSiteVerificationAction(form());
    expect(mocks.checkSiteVerification).toHaveBeenCalledWith("proj-1");
    expect(mocks.record).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "seo_site.verified",
        metadata: { method: "META" },
      }),
    );
  });

  it("explains a missing tag or record", async () => {
    mocks.checkSiteVerification.mockResolvedValue({
      ok: false,
      reason: "not_found",
    });
    expect(await checkSiteVerificationAction(form())).toEqual({
      ok: false,
      message:
        "We couldn't find the tag or DNS record yet. DNS changes can take a while.",
    });
    expect(mocks.record).not.toHaveBeenCalled();
  });
});

describe("setSiteCrawlAction", () => {
  it("saves the settings for owners and admins", async () => {
    await setSiteCrawlAction(form({ pageLimit: "100" }));
    expect(mocks.isWorkspaceManager).toHaveBeenCalledWith("user-1", "ws-1");
    expect(mocks.setCrawlSettings).toHaveBeenCalledWith("proj-1", {
      crawlEnabled: false,
      pageLimit: 100,
    });
    expect(mocks.record).toHaveBeenCalledWith(
      expect.objectContaining({ action: "seo_site.crawl_settings_updated" }),
    );
  });

  it("refuses members", async () => {
    mocks.isWorkspaceManager.mockResolvedValue(false);
    expect(
      await setSiteCrawlAction(form({ crawlEnabled: "on", pageLimit: "500" })),
    ).toEqual({
      ok: false,
      message: "Only workspace owners and admins can change this.",
    });
    expectNoWork();
  });

  it("rejects a page limit outside 100/250/500", async () => {
    const result = await setSiteCrawlAction(
      form({ crawlEnabled: "on", pageLimit: "5000" }),
    );
    expect(result.ok).toBe(false);
    expectNoWork();
  });
});

describe("recrawlSiteAction", () => {
  it("needs SEO_CRAWL", async () => {
    mocks.crawl.mockReturnValue(false);
    expect(await recrawlSiteAction(form())).toEqual({
      ok: false,
      message: "The site audit is off.",
    });
    expectNoWork();
  });

  it("explains too_soon", async () => {
    mocks.requestRecrawl.mockResolvedValue("too_soon");
    expect(await recrawlSiteAction(form())).toEqual({
      ok: false,
      message: "The audit ran less than a day ago. Try again tomorrow.",
    });
    expect(mocks.record).not.toHaveBeenCalled();
  });

  it("audits a queued recrawl", async () => {
    await recrawlSiteAction(form());
    expect(mocks.record).toHaveBeenCalledWith(
      expect.objectContaining({ action: "seo_site.recrawl_requested" }),
    );
  });
});

describe("muteSearchAlertAction", () => {
  it("mutes for 7 days and audits it", async () => {
    await muteSearchAlertAction(form({ alertId: "alert-1" }));
    expect(mocks.muteSearchAlert).toHaveBeenCalledWith("alert-1", "proj-1", 7);
    expect(mocks.record).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "seo_site.alert_muted",
        metadata: { alertId: "alert-1", days: 7 },
      }),
    );
  });

  it("rejects an alert that isn't a search alert of this project", async () => {
    mocks.muteSearchAlert.mockResolvedValue(false);
    expect(await muteSearchAlertAction(form({ alertId: "ads-alert" }))).toEqual(
      {
        ok: false,
        message: "This alert was not found.",
      },
    );
    expect(mocks.record).not.toHaveBeenCalled();
    expect(mocks.revalidatePath).not.toHaveBeenCalled();
  });
});

describe("deleteSiteAuditDataAction", () => {
  it("deletes for owners and admins and audits the count", async () => {
    await deleteSiteAuditDataAction(form());
    expect(mocks.deleteAuditData).toHaveBeenCalledWith("proj-1");
    expect(mocks.record).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "seo_site.audit_data_deleted",
        metadata: { deleted: 12 },
      }),
    );
  });

  it("refuses members", async () => {
    mocks.isWorkspaceManager.mockResolvedValue(false);
    expect(await deleteSiteAuditDataAction(form())).toEqual({
      ok: false,
      message: "Only workspace owners and admins can change this.",
    });
    expectNoWork();
  });
});
