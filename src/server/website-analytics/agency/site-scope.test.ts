import type { GaPropertyLink } from "@prisma/client";
import { beforeEach, describe, expect, it, vi } from "vitest";

// Bu dosyanın kanıtladığı: GA_AGENCY kapalıyken ya da proje izin listesinde
// değilken loadSitePropertyScope hiç sorgu atmadan enabled:false verir; açıkken
// seçili bağ, çipler, yönetici/ekleme bilgisi ve arşiv süzgeci (seçili bağ
// kimliği) gelir; runInSiteScope yalnız ek mülkte geçersiz kılar ve primaryGaLink
// bunu görür; ana mülkte okuyucular bugünkü sorguyu atar.

const db = vi.hoisted(() => ({
  gaPropertyLink: { findMany: vi.fn(), findFirst: vi.fn() },
  integrationCredential: { findFirst: vi.fn() },
}));
const tenant = vi.hoisted(() => ({ isWorkspaceManager: vi.fn() }));

vi.mock("@/lib/prisma", () => ({ prisma: db }));
vi.mock("@/server/security/tenant-context", () => ({
  isWorkspaceManager: tenant.isWorkspaceManager,
}));
vi.mock("@/server/integrations/google-client", () => ({
  GOOGLE_PROVIDER: { analytics: "google_analytics" },
}));

const { loadSitePropertyScope, runInSiteScope } = await import("./site-scope");
const { primaryGaLink } = await import("@/server/website-analytics/store");

function link(partial: Record<string, unknown>): GaPropertyLink {
  return {
    projectId: "p1",
    propertyName: null,
    serviceLevel: null,
    health: "OK",
    isPrimary: false,
    isSecondary: false,
    ...partial,
  } as unknown as GaPropertyLink;
}

const MAIN = link({ id: "l1", propertyId: "100", propertyName: "Main", isPrimary: true });
const EXTRA = link({ id: "l2", propertyId: "200", propertyName: "Blog", isSecondary: true });

const INPUT = {
  projectId: "p1",
  userId: "u1",
  workspaceId: "w1",
  requestedPropertyId: null,
  period: null,
};

beforeEach(() => {
  vi.unstubAllEnvs();
  vi.stubEnv("NODE_ENV", "test");
  vi.stubEnv("GA_SYNC", "true");
  vi.stubEnv("GA_AGENCY", "true");
  for (const model of Object.values(db)) {
    for (const fn of Object.values(model)) fn.mockReset();
  }
  tenant.isWorkspaceManager.mockReset();
  db.gaPropertyLink.findMany.mockResolvedValue([MAIN, EXTRA]);
  db.gaPropertyLink.findFirst.mockResolvedValue(MAIN);
  tenant.isWorkspaceManager.mockResolvedValue(true);
  db.integrationCredential.findFirst.mockResolvedValue({
    metadata: {
      ga4Properties: [
        { propertyId: "100", propertyName: "Main", accountName: "Acme" },
        { propertyId: "200", propertyName: "Blog", accountName: "Acme" },
        { propertyId: "300", propertyName: "Shop", accountName: "Acme" },
      ],
    },
  });
});

describe("loadSitePropertyScope", () => {
  it("returns enabled:false with zero queries when GA_AGENCY is off", async () => {
    vi.stubEnv("GA_AGENCY", "");
    const scope = await loadSitePropertyScope(INPUT);
    expect(scope.enabled).toBe(false);
    expect(scope).toMatchObject({
      selected: null,
      linkId: null,
      isSecondary: false,
      chips: [],
      addable: [],
      canAdd: false,
      canManage: false,
      archiveLinkId: null,
    });
    expect(db.gaPropertyLink.findMany).not.toHaveBeenCalled();
    expect(db.integrationCredential.findFirst).not.toHaveBeenCalled();
    expect(tenant.isWorkspaceManager).not.toHaveBeenCalled();
  });

  it("returns enabled:false for a project outside a dev allow-list", async () => {
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("DATABASE_URL", "postgresql://u:p@ep-x.neon.tech/app");
    vi.stubEnv("GA_SYNC_DEV_PROJECTS", "other");
    const scope = await loadSitePropertyScope(INPUT);
    expect(scope.enabled).toBe(false);
    expect(db.gaPropertyLink.findMany).not.toHaveBeenCalled();
  });

  it("selects the main property by default and filters the archive by its link", async () => {
    const scope = await loadSitePropertyScope(INPUT);
    expect(scope.enabled).toBe(true);
    expect(scope.selected).toBe(MAIN);
    expect(scope.linkId).toBe("l1");
    expect(scope.isSecondary).toBe(false);
    expect(scope.archiveLinkId).toBe("l1");
    expect(scope.chips.map((chip) => chip.linkId)).toEqual(["l1", "l2"]);
    expect(scope.canManage).toBe(true);
    expect(scope.canAdd).toBe(true);
    expect(scope.addable).toEqual([
      { propertyId: "300", label: "Shop (Acme)" },
    ]);
  });

  it("selects a requested extra property", async () => {
    const scope = await loadSitePropertyScope({
      ...INPUT,
      requestedPropertyId: "200",
      period: "7d",
    });
    expect(scope.selected).toBe(EXTRA);
    expect(scope.isSecondary).toBe(true);
    expect(scope.archiveLinkId).toBe("l2");
    expect(scope.chips[1]?.selected).toBe(true);
    expect(scope.chips[1]?.href).toBe("/projects/p1/site?property=200&period=7d");
  });

  it("falls back to the main property for an unknown request", async () => {
    const scope = await loadSitePropertyScope({
      ...INPUT,
      requestedPropertyId: "999",
    });
    expect(scope.selected).toBe(MAIN);
  });

  it("reads no credential for a non-manager and offers nothing to add", async () => {
    tenant.isWorkspaceManager.mockResolvedValue(false);
    const scope = await loadSitePropertyScope(INPUT);
    expect(scope.canManage).toBe(false);
    expect(scope.addable).toEqual([]);
    expect(db.integrationCredential.findFirst).not.toHaveBeenCalled();
  });

  it("reads no credential when the extra limit is reached", async () => {
    const extras = [1, 2, 3, 4].map((n) =>
      link({ id: `x${n}`, propertyId: `x${n}`, isSecondary: true }),
    );
    db.gaPropertyLink.findMany.mockResolvedValue([MAIN, ...extras]);
    const scope = await loadSitePropertyScope(INPUT);
    expect(scope.canAdd).toBe(false);
    expect(scope.addable).toEqual([]);
    expect(db.integrationCredential.findFirst).not.toHaveBeenCalled();
  });

  it("handles a project without any engine link", async () => {
    db.gaPropertyLink.findMany.mockResolvedValue([]);
    const scope = await loadSitePropertyScope(INPUT);
    expect(scope.enabled).toBe(true);
    expect(scope.selected).toBeNull();
    expect(scope.archiveLinkId).toBeNull();
    expect(scope.chips).toEqual([]);
  });
});

describe("runInSiteScope", () => {
  it("makes primaryGaLink return the selected extra inside the run only", async () => {
    const scope = await loadSitePropertyScope({
      ...INPUT,
      requestedPropertyId: "200",
    });
    const inside = await runInSiteScope(scope, async () => {
      await Promise.resolve();
      return primaryGaLink("p1");
    });
    expect(inside).toBe(EXTRA);
    expect(db.gaPropertyLink.findFirst).not.toHaveBeenCalled();
    // Dışarıda bugünkü sorgu.
    expect(await primaryGaLink("p1")).toBe(MAIN);
    expect(db.gaPropertyLink.findFirst).toHaveBeenCalledTimes(1);
  });

  it("sets no override when the main property is selected", async () => {
    const scope = await loadSitePropertyScope(INPUT);
    const result = await runInSiteScope(scope, async () => primaryGaLink("p1"));
    expect(result).toBe(MAIN);
    expect(db.gaPropertyLink.findFirst).toHaveBeenCalledTimes(1);
  });

  it("just awaits run() for a disabled scope", async () => {
    vi.stubEnv("GA_AGENCY", "");
    const scope = await loadSitePropertyScope(INPUT);
    expect(await runInSiteScope(scope, async () => "ok")).toBe("ok");
  });
});
