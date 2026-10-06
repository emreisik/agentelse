import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Bu dosyanın kanıtladığı: Search Console eylemleri proje erişimini doğrular,
// açılış listesi dışındaki projeyi reddeder ve hiç fırlatmaz. Refresh'in her
// sonucu doğru mesajı verir; marka terimleri ayrıştırılıp kaydedilir ve
// denetim kaydına düşer; arşiv ve "Delete stored data" yalnız OWNER/ADMIN'e
// açıktır; arşiv kapanınca bağ hemen budanır; silme denetim kaydı yazar.

const revalidatePath = vi.fn();
vi.mock("next/cache", () => ({ revalidatePath }));

const requireUser = vi.fn();
const requireProjectAccess = vi.fn();
const isWorkspaceManager = vi.fn();
vi.mock("@/server/security/tenant-context", () => ({
  requireUser,
  requireProjectAccess,
  isWorkspaceManager,
}));

const updateLink = vi.fn();
vi.mock("@/lib/prisma", () => ({
  prisma: { gscSiteLink: { update: updateLink } },
}));

const recordAudit = vi.fn();
vi.mock("@/server/repositories/audit-log.repository", () => ({
  AuditLogRepository: { record: recordAudit },
}));

const refreshNow = vi.fn();
vi.mock("@/server/seo/sync/runner", () => ({ GscSync: { refreshNow } }));

const deleteGscDataForProject = vi.fn();
vi.mock("@/server/seo/sync/links", () => ({ deleteGscDataForProject }));

const pruneLink = vi.fn();
vi.mock("@/server/seo/retention", () => ({ GscRetention: { pruneLink } }));

const primaryGscLink = vi.fn();
vi.mock("@/server/seo/store", () => ({ primaryGscLink }));

const saveBrandTerms = vi.fn();
vi.mock("@/server/seo/brand-terms", () => ({ saveBrandTerms }));

const {
  deleteSearchDataAction,
  refreshSearchAnalyticsAction,
  saveBrandTermsAction,
  setSearchArchiveAction,
} = await import("./search-analytics-actions");

const form = (fields: Record<string, string> = {}) => {
  const data = new FormData();
  data.set("projectId", "proj-1");
  for (const [key, value] of Object.entries(fields)) data.set(key, value);
  return data;
};

const NOT_ALLOWED = {
  ok: false,
  message: "Search Console isn't set up for this project here.",
};
const MANAGERS_ONLY = {
  ok: false,
  message: "Only workspace owners and admins can change this.",
};

beforeEach(() => {
  vi.stubEnv("GSC_SYNC", "true");
  vi.stubEnv("GSC_ROLLOUT_PROJECTS", "");
  vi.stubEnv("GSC_SYNC_DEV_PROJECTS", "");
  for (const mock of [
    revalidatePath,
    requireUser,
    requireProjectAccess,
    isWorkspaceManager,
    updateLink,
    recordAudit,
    refreshNow,
    deleteGscDataForProject,
    pruneLink,
    primaryGscLink,
    saveBrandTerms,
  ]) {
    mock.mockReset();
  }
  requireUser.mockResolvedValue({ userId: "user-1", email: null });
  requireProjectAccess.mockResolvedValue({
    workspaceId: "ws-1",
    projectId: "proj-1",
    defaultBrandId: "brand-1",
  });
  isWorkspaceManager.mockResolvedValue(true);
  primaryGscLink.mockResolvedValue({ id: "link-1", projectId: "proj-1" });
  updateLink.mockResolvedValue({});
  pruneLink.mockResolvedValue(3);
  recordAudit.mockResolvedValue({});
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("refreshSearchAnalyticsAction", () => {
  it("refreshes and revalidates the Search page", async () => {
    refreshNow.mockResolvedValue("refreshed");
    expect(await refreshSearchAnalyticsAction(form())).toEqual({ ok: true });
    expect(refreshNow).toHaveBeenCalledWith("proj-1");
    expect(revalidatePath).toHaveBeenCalledWith("/projects/proj-1/arama");
  });

  it.each([
    [
      "throttled",
      "Updated less than 5 minutes ago. Try again in a few minutes.",
    ],
    ["busy", "An update is already running. Try again in a moment."],
    ["failed", "The update didn't finish. Try again in a few minutes."],
    ["unavailable", "Search Console isn't connected for this project."],
  ])("says why a %s refresh did not run", async (result, message) => {
    refreshNow.mockResolvedValue(result);
    expect(await refreshSearchAnalyticsAction(form())).toEqual({
      ok: false,
      message,
    });
    expect(revalidatePath).not.toHaveBeenCalled();
  });

  it("returns a message instead of throwing when access fails", async () => {
    requireProjectAccess.mockRejectedValue(new Error("No access"));
    expect(await refreshSearchAnalyticsAction(form())).toEqual({
      ok: false,
      message: "No access",
    });
    expect(refreshNow).not.toHaveBeenCalled();
  });
});

describe("saveBrandTermsAction", () => {
  it("saves the parsed terms, audits and revalidates both pages", async () => {
    saveBrandTerms.mockResolvedValue({
      ok: true,
      terms: ["acme", "acme shop"],
    });
    const result = await saveBrandTermsAction(
      form({ terms: "Acme\nacme shop, " }),
    );
    expect(result).toEqual({ ok: true });
    expect(saveBrandTerms).toHaveBeenCalledWith({
      projectId: "proj-1",
      terms: ["acme", "acme shop"],
    });
    expect(recordAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: "ws-1",
        projectId: "proj-1",
        actorId: "user-1",
        action: "search_console.brand_terms_updated",
        entityType: "GscSiteLink",
      }),
    );
    expect(revalidatePath).toHaveBeenCalledWith("/projects/proj-1/arama");
    expect(revalidatePath).toHaveBeenCalledWith(
      "/projects/proj-1/integrations",
    );
  });

  it("refuses while GSC_SYNC is off and when there is no link", async () => {
    vi.stubEnv("GSC_SYNC", "false");
    expect(await saveBrandTermsAction(form({ terms: "acme" }))).toEqual({
      ok: false,
      message: "Search Console data isn't turned on.",
    });
    expect(saveBrandTerms).not.toHaveBeenCalled();

    vi.stubEnv("GSC_SYNC", "true");
    saveBrandTerms.mockResolvedValue({ ok: false, reason: "no_link" });
    expect(await saveBrandTermsAction(form({ terms: "acme" }))).toEqual({
      ok: false,
      message: "Search Console isn't connected for this project.",
    });
    expect(recordAudit).not.toHaveBeenCalled();
  });

  it("says when the terms do not fit in Google's brand filter", async () => {
    saveBrandTerms.mockResolvedValue({ ok: false, reason: "too_long" });
    expect(await saveBrandTermsAction(form({ terms: "acme" }))).toEqual({
      ok: false,
      message:
        "These brand terms are too long together. Remove some or use shorter ones.",
    });
    expect(recordAudit).not.toHaveBeenCalled();
  });
});

describe("setSearchArchiveAction", () => {
  it("is refused for members who are not owners or admins", async () => {
    isWorkspaceManager.mockResolvedValue(false);
    expect(await setSearchArchiveAction(form({ archive: "false" }))).toEqual(
      MANAGERS_ONLY,
    );
    expect(updateLink).not.toHaveBeenCalled();
    expect(pruneLink).not.toHaveBeenCalled();
  });

  it("turning the archive off saves it, prunes the link right away and audits", async () => {
    expect(await setSearchArchiveAction(form({ archive: "false" }))).toEqual({
      ok: true,
    });
    expect(isWorkspaceManager).toHaveBeenCalledWith("user-1", "ws-1");
    expect(updateLink).toHaveBeenCalledWith({
      where: { id: "link-1" },
      data: { archive: false },
    });
    expect(pruneLink).toHaveBeenCalledWith("link-1");
    expect(recordAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "search_console.archive_updated",
        entityType: "GscSiteLink",
        entityId: "link-1",
        metadata: { archive: false },
      }),
    );
  });

  it("turning it on does not prune", async () => {
    expect(await setSearchArchiveAction(form({ archive: "true" }))).toEqual({
      ok: true,
    });
    expect(updateLink).toHaveBeenCalledWith({
      where: { id: "link-1" },
      data: { archive: true },
    });
    expect(pruneLink).not.toHaveBeenCalled();
  });

  it("says when there is no link", async () => {
    primaryGscLink.mockResolvedValue(null);
    expect(await setSearchArchiveAction(form({ archive: "true" }))).toEqual({
      ok: false,
      message: "Search Console isn't connected for this project.",
    });
  });
});

describe("deleteSearchDataAction", () => {
  it("is refused for members who are not owners or admins", async () => {
    isWorkspaceManager.mockResolvedValue(false);
    expect(await deleteSearchDataAction(form())).toEqual(MANAGERS_ONLY);
    expect(deleteGscDataForProject).not.toHaveBeenCalled();
  });

  it("deletes the stored data, audits and revalidates", async () => {
    deleteGscDataForProject.mockResolvedValue({ deletedLinks: 2 });
    expect(await deleteSearchDataAction(form())).toEqual({ ok: true });
    expect(deleteGscDataForProject).toHaveBeenCalledWith("proj-1");
    expect(recordAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "search_console.data_deleted",
        entityType: "GscSiteLink",
        metadata: { deletedLinks: 2 },
      }),
    );
    expect(revalidatePath).toHaveBeenCalledWith(
      "/projects/proj-1/integrations",
    );
    expect(revalidatePath).toHaveBeenCalledWith("/projects/proj-1/arama");
  });

  it("returns a message instead of throwing when the delete fails", async () => {
    deleteGscDataForProject.mockRejectedValue(new Error("boom"));
    expect(await deleteSearchDataAction(form())).toEqual({
      ok: false,
      message: "boom",
    });
  });
});

describe("rollout allow-list", () => {
  it("every action refuses a project outside gscSyncAllowedFor", async () => {
    vi.stubEnv("GSC_ROLLOUT_PROJECTS", "proj-other");
    expect(await refreshSearchAnalyticsAction(form())).toEqual(NOT_ALLOWED);
    expect(await saveBrandTermsAction(form({ terms: "acme" }))).toEqual(
      NOT_ALLOWED,
    );
    expect(await setSearchArchiveAction(form({ archive: "false" }))).toEqual(
      NOT_ALLOWED,
    );
    expect(await deleteSearchDataAction(form())).toEqual(NOT_ALLOWED);
    expect(refreshNow).not.toHaveBeenCalled();
    expect(saveBrandTerms).not.toHaveBeenCalled();
    expect(updateLink).not.toHaveBeenCalled();
    expect(deleteGscDataForProject).not.toHaveBeenCalled();
    expect(recordAudit).not.toHaveBeenCalled();
  });
  it("every action refuses while GSC_SYNC is off", async () => {
    vi.stubEnv("GSC_SYNC", "false");
    const NOT_ON = {
      ok: false,
      message: "Search Console data isn't turned on.",
    };
    expect(await refreshSearchAnalyticsAction(form())).toEqual(NOT_ON);
    expect(await setSearchArchiveAction(form({ archive: "false" }))).toEqual(
      NOT_ON,
    );
    expect(await deleteSearchDataAction(form())).toEqual(NOT_ON);
    expect(refreshNow).not.toHaveBeenCalled();
    expect(updateLink).not.toHaveBeenCalled();
    expect(pruneLink).not.toHaveBeenCalled();
    expect(deleteGscDataForProject).not.toHaveBeenCalled();
  });
});
