import { beforeEach, describe, expect, it, vi } from "vitest";

const prismaMocks = vi.hoisted(() => ({
  findUnique: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: { integrationCredential: { findUnique: prismaMocks.findUnique } },
}));

const envMocks = vi.hoisted(() => ({ configured: true }));
vi.mock("@/lib/env", () => ({
  isIntegrationConfigured: () => envMocks.configured,
}));

import { MetaApiProvider } from "@/server/execution/providers/meta/meta-api-provider";
import type { ExecutionPolicyContext } from "@/server/execution/types";

const context: ExecutionPolicyContext = {
  workspaceId: "ws-1",
  projectId: "project-1",
  brandId: "brand-1",
  taskId: "task-1",
  capability: "INSTAGRAM_PUBLISH",
  riskLevel: "HIGH",
};

describe("MetaApiProvider.canExecute", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    envMocks.configured = true;
  });

  it("returns false when META env vars are not configured", async () => {
    envMocks.configured = false;
    const provider = new MetaApiProvider();
    expect(await provider.canExecute("INSTAGRAM_PUBLISH", context)).toBe(false);
    expect(prismaMocks.findUnique).not.toHaveBeenCalled();
  });

  it("returns false for a capability it does not own", async () => {
    const provider = new MetaApiProvider();
    expect(await provider.canExecute("WEB_RESEARCH", context)).toBe(false);
    expect(prismaMocks.findUnique).not.toHaveBeenCalled();
  });

  it("returns false when no active Meta credential exists for the project", async () => {
    prismaMocks.findUnique.mockResolvedValue(null);
    const provider = new MetaApiProvider();
    expect(await provider.canExecute("META_ADS_ANALYSIS", context)).toBe(false);
  });

  it("returns false when the credential is not ACTIVE", async () => {
    prismaMocks.findUnique.mockResolvedValue({
      status: "EXPIRED",
      metadata: { selectedAdAccountId: "act_1" },
    });
    const provider = new MetaApiProvider();
    expect(await provider.canExecute("META_ADS_ANALYSIS", context)).toBe(false);
  });

  it("requires a selected ad account for campaign/adset/ad/analysis capabilities", async () => {
    prismaMocks.findUnique.mockResolvedValue({
      status: "ACTIVE",
      metadata: { pages: [], adAccounts: [] },
    });
    const provider = new MetaApiProvider();
    expect(await provider.canExecute("META_ADS_ANALYSIS", context)).toBe(false);
    expect(await provider.canExecute("META_CAMPAIGN_CREATE", context)).toBe(
      false,
    );
    expect(await provider.canExecute("META_ADSET_CREATE", context)).toBe(false);
    expect(await provider.canExecute("META_ADSET_UPDATE", context)).toBe(false);
    expect(await provider.canExecute("META_AD_CREATE", context)).toBe(false);
  });

  it("allows campaign/adset/analysis capabilities once an ad account is selected", async () => {
    prismaMocks.findUnique.mockResolvedValue({
      status: "ACTIVE",
      metadata: { pages: [], adAccounts: [], selectedAdAccountId: "act_1" },
    });
    const provider = new MetaApiProvider();
    expect(await provider.canExecute("META_ADS_ANALYSIS", context)).toBe(true);
    expect(await provider.canExecute("META_CAMPAIGN_UPDATE", context)).toBe(
      true,
    );
    expect(await provider.canExecute("META_ADSET_CREATE", context)).toBe(true);
    expect(await provider.canExecute("META_ADSET_UPDATE", context)).toBe(true);
  });

  it("requires BOTH a selected ad account and a selected Page for META_AD_CREATE", async () => {
    const provider = new MetaApiProvider();

    // Ad account only, no Page selected — createAd() needs the Page to
    // build the AdCreative's object_story_spec.
    prismaMocks.findUnique.mockResolvedValue({
      status: "ACTIVE",
      metadata: { pages: [], adAccounts: [], selectedAdAccountId: "act_1" },
    });
    expect(await provider.canExecute("META_AD_CREATE", context)).toBe(false);

    // Page selected but no ad account.
    prismaMocks.findUnique.mockResolvedValue({
      status: "ACTIVE",
      metadata: {
        selectedPageId: "page-1",
        pages: [{ pageId: "page-1", pageName: "Test Page" }],
        adAccounts: [],
      },
    });
    expect(await provider.canExecute("META_AD_CREATE", context)).toBe(false);

    // Both selected.
    prismaMocks.findUnique.mockResolvedValue({
      status: "ACTIVE",
      metadata: {
        selectedAdAccountId: "act_1",
        selectedPageId: "page-1",
        pages: [{ pageId: "page-1", pageName: "Test Page" }],
        adAccounts: [],
      },
    });
    expect(await provider.canExecute("META_AD_CREATE", context)).toBe(true);
  });

  it("requires the selected page to have a linked Instagram business account for INSTAGRAM_PUBLISH", async () => {
    prismaMocks.findUnique.mockResolvedValue({
      status: "ACTIVE",
      metadata: {
        selectedPageId: "page-1",
        pages: [{ pageId: "page-1", pageName: "Test Page" }],
        adAccounts: [],
      },
    });
    const provider = new MetaApiProvider();
    expect(await provider.canExecute("INSTAGRAM_PUBLISH", context)).toBe(false);
  });

  it("allows INSTAGRAM_PUBLISH once the selected page has a linked Instagram account", async () => {
    prismaMocks.findUnique.mockResolvedValue({
      status: "ACTIVE",
      metadata: {
        selectedPageId: "page-1",
        pages: [
          {
            pageId: "page-1",
            pageName: "Test Page",
            instagramBusinessAccountId: "ig-1",
          },
        ],
        adAccounts: [],
      },
    });
    const provider = new MetaApiProvider();
    expect(await provider.canExecute("INSTAGRAM_PUBLISH", context)).toBe(true);
  });
});
