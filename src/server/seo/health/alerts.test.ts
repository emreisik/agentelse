import { beforeEach, describe, expect, it, vi } from "vitest";

import type { SeoAlertDraft } from "@/lib/seo/health/alert-kinds";

// Bu dosyanın kanıtladığı: bağdaştırıcı her taslağı SiteAlerts.raise'e verir,
// resolveMissing'i kaynak başına yalnız değerlendirilen türlerle çağırır (boş
// kaynakta çağırmaz) ve taslakların anahtarlarını açık tutar; susturma yalnız
// projenin GSC/SEO uyarısında çalışır; GSC uyarılarının silinmesi yalnız
// source "GSC" satırlarına dokunur; saklama çözülmüş GSC ve SEO uyarılarını
// 180 gün sonra siler.

const mocks = vi.hoisted(() => ({
  raise: vi.fn(),
  resolveMissing: vi.fn(),
  listOpen: vi.fn(),
  mute: vi.fn(),
  purgeResolved: vi.fn(),
  findFirst: vi.fn(),
  deleteMany: vi.fn(),
  links: vi.fn(),
}));

vi.mock("@/server/monitoring/site-alerts", () => ({
  SiteAlerts: {
    raise: mocks.raise,
    resolveMissing: mocks.resolveMissing,
    listOpen: mocks.listOpen,
    mute: mocks.mute,
    purgeResolved: mocks.purgeResolved,
  },
}));
vi.mock("@/lib/prisma", () => ({
  prisma: {
    adsAlert: { findFirst: mocks.findFirst, deleteMany: mocks.deleteMany },
    gscSiteLink: { findMany: mocks.links },
  },
}));

const {
  deleteSearchConsoleAlerts,
  deleteSearchConsoleAlertsForProjects,
  muteSearchAlert,
  purgeResolvedSearchAlerts,
  raiseSeoAlerts,
} = await import("./alerts");

const NOW = new Date("2026-10-06T12:00:00.000Z");

const DRAFT: SeoAlertDraft = {
  source: "SEO",
  kind: "SEO_KEY_PAGE_NOINDEX",
  severity: "CRITICAL",
  dedupeKey: "seo:SEO_KEY_PAGE_NOINDEX",
  title: "Your homepage is set to noindex",
  detail: "Search engines are told not to index: / (meta tag).",
};

beforeEach(() => {
  for (const mock of Object.values(mocks)) mock.mockReset();
  mocks.resolveMissing.mockResolvedValue(1);
  mocks.deleteMany.mockResolvedValue({ count: 2 });
});

describe("raiseSeoAlerts", () => {
  it("raises drafts and resolves per source with the evaluated kinds", async () => {
    const result = await raiseSeoAlerts({
      workspaceId: "w1",
      projectId: "p1",
      drafts: [DRAFT],
      evaluated: {
        GSC: [],
        SEO: ["SEO_KEY_PAGE_NOINDEX", "SEO_KEY_PAGE_ERROR"],
      },
      now: NOW,
    });
    expect(mocks.raise).toHaveBeenCalledWith(
      {
        workspaceId: "w1",
        projectId: "p1",
        source: "SEO",
        kind: "SEO_KEY_PAGE_NOINDEX",
        severity: "CRITICAL",
        dedupeKey: "seo:SEO_KEY_PAGE_NOINDEX",
        title: DRAFT.title,
        detail: DRAFT.detail,
      },
      NOW,
    );
    expect(mocks.resolveMissing).toHaveBeenCalledTimes(1);
    expect(mocks.resolveMissing).toHaveBeenCalledWith(
      {
        projectId: "p1",
        source: "SEO",
        kinds: ["SEO_KEY_PAGE_NOINDEX", "SEO_KEY_PAGE_ERROR"],
        stillOpen: new Set(["seo:SEO_KEY_PAGE_NOINDEX"]),
      },
      NOW,
    );
    expect(result).toEqual({ raised: 1, resolved: 1 });
  });

  it("keeps resolving when one raise fails", async () => {
    mocks.raise.mockRejectedValueOnce(new Error("db"));
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const result = await raiseSeoAlerts({
      workspaceId: "w1",
      projectId: "p1",
      drafts: [DRAFT],
      evaluated: { GSC: ["GSC_SEARCH_DROP"], SEO: ["SEO_KEY_PAGE_NOINDEX"] },
      now: NOW,
    });
    expect(result.raised).toBe(0);
    expect(mocks.resolveMissing).toHaveBeenCalledTimes(2);
  });
});

describe("muteSearchAlert", () => {
  it("refuses alerts that are not this project's GSC/SEO alerts", async () => {
    mocks.findFirst.mockResolvedValue(null);
    expect(await muteSearchAlert("ads-alert", "p1")).toBe(false);
    expect(mocks.findFirst).toHaveBeenCalledWith({
      where: {
        id: "ads-alert",
        projectId: "p1",
        source: { in: ["GSC", "SEO"] },
      },
      select: { id: true },
    });
    expect(mocks.mute).not.toHaveBeenCalled();
  });

  it("mutes for seven days by default", async () => {
    mocks.findFirst.mockResolvedValue({ id: "a1" });
    expect(await muteSearchAlert("a1", "p1")).toBe(true);
    expect(mocks.mute).toHaveBeenCalledWith("a1", "p1", 7);
  });
});

describe("Search Console alert deletion", () => {
  it("deletes only GSC alerts of the credential's projects", async () => {
    mocks.links.mockResolvedValue([
      { projectId: "p1" },
      { projectId: "p1" },
      { projectId: "p2" },
    ]);
    const result = await deleteSearchConsoleAlerts("cred-1");
    expect(mocks.links).toHaveBeenCalledWith({
      where: { credentialId: "cred-1" },
      select: { projectId: true },
    });
    expect(mocks.deleteMany).toHaveBeenCalledWith({
      where: { projectId: { in: ["p1", "p2"] }, source: "GSC" },
    });
    expect(result).toEqual({ deleted: 2, projectIds: ["p1", "p2"] });
  });

  it("does not query for an empty project list", async () => {
    expect(await deleteSearchConsoleAlertsForProjects([])).toBe(0);
    expect(mocks.deleteMany).not.toHaveBeenCalled();
    expect(await deleteSearchConsoleAlertsForProjects(["p1"])).toBe(2);
  });
});

describe("purgeResolvedSearchAlerts", () => {
  it("purges resolved GSC and SEO alerts older than 180 days", async () => {
    mocks.purgeResolved.mockResolvedValueOnce(3).mockResolvedValueOnce(2);
    expect(await purgeResolvedSearchAlerts(NOW)).toBe(5);
    expect(mocks.purgeResolved).toHaveBeenNthCalledWith(1, "GSC", 180, NOW);
    expect(mocks.purgeResolved).toHaveBeenNthCalledWith(2, "SEO", 180, NOW);
  });
});
