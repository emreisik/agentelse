import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  enabled: vi.fn(() => true),
  enabledFor: vi.fn<(projectId: string) => boolean>(() => true),
  mockMode: vi.fn(() => false),
  syncOn: vi.fn(() => true),
  findFirst: vi.fn(),
  findMany: vi.fn(),
  credFindUnique: vi.fn(),
  upsert: vi.fn(),
  projectFindUnique: vi.fn(),
  projectFindMany: vi.fn(),
  brandFindFirst: vi.fn(),
  record: vi.fn(),
  ensureLink: vi.fn(),
  freshToken: vi.fn(),
  buildGoogleMetadata: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    integrationCredential: {
      findFirst: mocks.findFirst,
      findMany: mocks.findMany,
      findUnique: mocks.credFindUnique,
      upsert: mocks.upsert,
    },
    project: {
      findUnique: mocks.projectFindUnique,
      findMany: mocks.projectFindMany,
    },
    brand: { findFirst: mocks.brandFindFirst },
  },
}));
vi.mock("@/lib/website-analytics/agency/flags", () => ({
  gaAgencyEnabled: mocks.enabled,
  gaAgencyEnabledFor: mocks.enabledFor,
  gaAgencyMockMode: mocks.mockMode,
}));
vi.mock("@/lib/website-analytics/flags", () => ({
  GaFlags: { sync: mocks.syncOn },
}));
vi.mock("@/server/repositories/audit-log.repository", () => ({
  AuditLogRepository: { record: mocks.record },
}));
vi.mock("@/server/website-analytics/sync/links", () => ({
  ensureGaLinkForProject: mocks.ensureLink,
}));
vi.mock("@/server/integrations/google-token", () => ({
  getFreshGoogleAccessToken: mocks.freshToken,
}));
vi.mock("@/server/integrations/google-connection-metadata", () => ({
  buildGoogleConnectionMetadata: mocks.buildGoogleMetadata,
}));

import {
  BULK_LINK_MAX,
  bulkLinkGoogleAccount,
  listLinkableProjects,
  listWorkspaceGoogleAccounts,
} from "./bulk-link";

// Bu dosyanın kanıtladığı (GA-F8, toplu bağlama): tek jeton + tek mülk listesi,
// en çok 20 proje, mevcut ACTIVE bağlantıya dokunulmaz, projenin eski seçimi
// korunur, otomatik mülk seçimi varsayılan kapalıdır ve mock kipte Google'a
// gidilmez.

const WS = "ws1";
const PROPERTIES = [
  { propertyId: "111", propertyName: "Acme Shop", accountName: "Agency" },
  { propertyId: "222", propertyName: "Birch Dental", accountName: "Agency" },
];
const SOURCE = {
  id: "src1",
  workspaceId: WS,
  projectId: "p-src",
  accountLabel: "boss@agency.test",
  encryptedSecret: "cipher-1",
  metadata: { connectedEmail: "boss@agency.test", googleSub: "sub1" },
};

function project(id: string, over: Record<string, unknown> = {}) {
  return {
    id,
    name: `Project ${id}`,
    domain: null,
    workspaceId: WS,
    status: "ACTIVE",
    ...over,
  };
}

function setup(projects: Record<string, ReturnType<typeof project> | null>) {
  mocks.projectFindUnique.mockImplementation(
    async ({ where }: { where: { id: string } }) => projects[where.id] ?? null,
  );
  mocks.brandFindFirst.mockResolvedValue({ id: "brand1" });
  mocks.credFindUnique.mockResolvedValue(null);
  mocks.upsert.mockImplementation(async ({ create }: { create: { projectId: string } }) => ({
    id: `cred-${create.projectId}`,
  }));
}

const deps = () => ({
  getAccessToken: vi.fn(async () => "token"),
  buildMetadata: vi.fn(async () => ({
    connectedEmail: "boss@agency.test",
    googleSub: "sub1",
    ga4Properties: PROPERTIES,
    selectedGa4PropertyId: "999",
  })),
});

beforeEach(() => {
  vi.clearAllMocks();
  mocks.ensureLink.mockReset();
  mocks.enabled.mockReturnValue(true);
  mocks.enabledFor.mockReturnValue(true);
  mocks.mockMode.mockReturnValue(false);
  mocks.syncOn.mockReturnValue(true);
  mocks.findFirst.mockResolvedValue(SOURCE);
});

const base = {
  workspaceId: WS,
  userId: "u1",
  sourceCredentialId: "src1",
  autoProperty: false,
};

describe("bulkLinkGoogleAccount", () => {
  it("is off without the agency flag", async () => {
    mocks.enabled.mockReturnValue(false);
    const result = await bulkLinkGoogleAccount({ ...base, projectIds: ["a"] }, deps());
    expect(result).toEqual({ ok: false, reason: "off" });
    expect(mocks.findFirst).not.toHaveBeenCalled();
  });

  it("refuses more than 20 projects before any query", async () => {
    const ids = Array.from({ length: BULK_LINK_MAX + 1 }, (_, i) => `p${i}`);
    const result = await bulkLinkGoogleAccount({ ...base, projectIds: ids }, deps());
    expect(result).toEqual({ ok: false, reason: "too_many" });
    expect(mocks.findFirst).not.toHaveBeenCalled();
  });

  it("counts duplicate ids once", async () => {
    const ids = Array.from({ length: BULK_LINK_MAX }, () => "same");
    setup({ same: project("same") });
    const result = await bulkLinkGoogleAccount({ ...base, projectIds: ids }, deps());
    expect(result.ok && result.rows).toHaveLength(1);
  });

  it("refuses a source that is not an ACTIVE analytics credential of the workspace", async () => {
    mocks.findFirst.mockResolvedValue(null);
    const result = await bulkLinkGoogleAccount({ ...base, projectIds: ["a"] }, deps());
    expect(result).toEqual({ ok: false, reason: "bad_source" });
    const where = mocks.findFirst.mock.calls[0]?.[0].where;
    expect(where).toMatchObject({
      id: "src1",
      workspaceId: WS,
      provider: "google_analytics",
      status: "ACTIVE",
    });
  });

  it("never refreshes the source token when the source project is not allowed here", async () => {
    mocks.enabledFor.mockImplementation((id: string) => id !== "p-src");
    const d = deps();
    const result = await bulkLinkGoogleAccount({ ...base, projectIds: ["a"] }, d);
    expect(result).toEqual({ ok: false, reason: "bad_source" });
    expect(d.getAccessToken).not.toHaveBeenCalled();
    expect(d.buildMetadata).not.toHaveBeenCalled();
  });

  it("answers token_invalid when the token cannot be fetched", async () => {
    const d = deps();
    d.getAccessToken.mockRejectedValue(new Error("invalid_grant"));
    const result = await bulkLinkGoogleAccount({ ...base, projectIds: ["a"] }, d);
    expect(result).toEqual({ ok: false, reason: "token_invalid" });
    expect(mocks.upsert).not.toHaveBeenCalled();
  });

  it("skips closed, foreign, unknown, connected and not-allowed projects and links the rest", async () => {
    setup({
      ok1: project("ok1"),
      ok2: project("ok2"),
      closed: project("closed", { status: "CLOSED" }),
      foreign: project("foreign", { workspaceId: "other" }),
      blocked: project("blocked"),
      taken: project("taken"),
    });
    mocks.enabledFor.mockImplementation((id: string) => id !== "blocked");
    mocks.credFindUnique.mockImplementation(
      async ({ where }: { where: { projectId_provider: { projectId: string } } }) =>
        where.projectId_provider.projectId === "taken"
          ? { id: "c-taken", status: "ACTIVE", metadata: {} }
          : null,
    );
    const result = await bulkLinkGoogleAccount(
      {
        ...base,
        projectIds: ["ok1", "closed", "foreign", "missing", "blocked", "taken", "ok2"],
      },
      deps(),
    );
    expect(result.ok && result.linked).toBe(2);
    const byProject = Object.fromEntries(
      (result.ok ? result.rows : []).map((row) => [row.projectId, row]),
    );
    expect(byProject.ok1?.status).toBe("linked");
    expect(byProject.ok2?.status).toBe("linked");
    expect(byProject.closed?.reason).toBe("closed");
    expect(byProject.foreign?.reason).toBe("other_workspace");
    expect(byProject.missing?.reason).toBe("not_found");
    expect(byProject.blocked?.reason).toBe("not_allowed");
    expect(byProject.taken?.reason).toBe("already_connected");
    expect(mocks.upsert).toHaveBeenCalledTimes(2);
    expect(mocks.record).toHaveBeenCalledTimes(2);
  });

  it("builds the shared metadata exactly once and copies the same encrypted token", async () => {
    setup({ a: project("a"), b: project("b"), c: project("c") });
    const d = deps();
    await bulkLinkGoogleAccount({ ...base, projectIds: ["a", "b", "c"] }, d);
    expect(d.getAccessToken).toHaveBeenCalledTimes(1);
    expect(d.buildMetadata).toHaveBeenCalledTimes(1);
    for (const call of mocks.upsert.mock.calls) {
      expect(call[0].create.encryptedSecret).toBe("cipher-1");
      expect(call[0].update.encryptedSecret).toBe("cipher-1");
      expect(call[0].create.status).toBe("ACTIVE");
      expect(call[0].create.brandId).toBe("brand1");
    }
  });

  it("does not copy the source's own selection into the projects", async () => {
    setup({ a: project("a") });
    await bulkLinkGoogleAccount({ ...base, projectIds: ["a"] }, deps());
    const metadata = mocks.upsert.mock.calls[0]?.[0].create.metadata;
    expect(metadata.selectedGa4PropertyId).toBeUndefined();
    expect(metadata.ga4Properties).toEqual(PROPERTIES);
  });

  it("keeps a project's previous property selection and scan records when still listed", async () => {
    setup({ a: project("a"), b: project("b") });
    mocks.credFindUnique.mockImplementation(
      async ({ where }: { where: { projectId_provider: { projectId: string } } }) => {
        const id = where.projectId_provider.projectId;
        if (id === "a") {
          return {
            id: "old-a",
            status: "EXPIRED",
            metadata: {
              selectedGa4PropertyId: "222",
              selectedGa4PropertyName: "Birch Dental",
              lastAnalyticsScanAt: "2026-10-01T00:00:00.000Z",
              disconnectedAt: "2026-09-01",
              googleHealth: { state: "NEEDS_RECONNECT" },
              customKey: "kept",
            },
          };
        }
        // b: önceki seçim artık listede yok.
        return {
          id: "old-b",
          status: "EXPIRED",
          metadata: { selectedGa4PropertyId: "gone", selectedGa4PropertyName: "Gone" },
        };
      },
    );
    const result = await bulkLinkGoogleAccount({ ...base, projectIds: ["a", "b"] }, deps());
    const [a, b] = mocks.upsert.mock.calls.map((call) => call[0].update.metadata);
    expect(a).toMatchObject({
      selectedGa4PropertyId: "222",
      selectedGa4PropertyName: "Birch Dental",
      lastAnalyticsScanAt: "2026-10-01T00:00:00.000Z",
      customKey: "kept",
    });
    expect(a.disconnectedAt).toBeUndefined();
    expect(a.googleHealth).toBeUndefined();
    expect(b.selectedGa4PropertyId).toBeUndefined();
    expect(result.ok && result.rows.map((r) => r.propertyId)).toEqual(["222", null]);
  });

  it("picks the property by name only when autoProperty is on and the match is unique", async () => {
    setup({
      acme: project("acme", { name: "Acme Shop" }),
      nomatch: project("nomatch", { name: "Zebra Studio" }),
    });
    const off = await bulkLinkGoogleAccount({ ...base, projectIds: ["acme"] }, deps());
    expect(off.ok && off.rows[0]?.propertyId).toBeNull();

    vi.clearAllMocks();
    mocks.findFirst.mockResolvedValue(SOURCE);
    setup({
      acme: project("acme", { name: "Acme Shop" }),
      nomatch: project("nomatch", { name: "Zebra Studio" }),
    });
    const on = await bulkLinkGoogleAccount(
      { ...base, autoProperty: true, projectIds: ["acme", "nomatch"] },
      deps(),
    );
    expect(on.ok && on.rows.map((r) => r.propertyId)).toEqual(["111", null]);
    expect(mocks.upsert.mock.calls[0]?.[0].create.metadata.selectedGa4PropertyName).toBe("Acme Shop");
  });

  it("writes one audit row per linked project with bulk true and creates the link when GA_SYNC is on", async () => {
    setup({ a: project("a"), b: project("b") });
    await bulkLinkGoogleAccount({ ...base, projectIds: ["a", "b"] }, deps());
    expect(mocks.record).toHaveBeenCalledTimes(2);
    expect(mocks.record.mock.calls[0]?.[0]).toMatchObject({
      workspaceId: WS,
      projectId: "a",
      actorType: "USER",
      actorId: "u1",
      action: "integration_credential.connected",
      entityId: "cred-a",
      metadata: { provider: "google_analytics", reusedFromCredentialId: "src1", bulk: true },
    });
    expect(mocks.ensureLink).toHaveBeenCalledTimes(2);
  });

  it("does not create links when the warehouse flag is off and survives a link failure", async () => {
    setup({ a: project("a") });
    mocks.syncOn.mockReturnValue(false);
    await bulkLinkGoogleAccount({ ...base, projectIds: ["a"] }, deps());
    expect(mocks.ensureLink).not.toHaveBeenCalled();

    mocks.syncOn.mockReturnValue(true);
    mocks.ensureLink.mockRejectedValue(new Error("db down"));
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const result = await bulkLinkGoogleAccount({ ...base, projectIds: ["a"] }, deps());
    expect(result.ok && result.linked).toBe(1);
    // Yalnız hata adı loglanır, mesaj değil.
    expect(spy.mock.calls.flat().join(" ")).not.toContain("db down");
    spy.mockRestore();
  });

  it("makes no Google call in mock mode (default deps)", async () => {
    mocks.mockMode.mockReturnValue(true);
    setup({ a: project("a") });
    const fetchSpy = vi.fn(() => {
      throw new Error("network must not be used");
    });
    vi.stubGlobal("fetch", fetchSpy);
    mocks.findFirst.mockResolvedValue({
      ...SOURCE,
      metadata: { ...SOURCE.metadata, ga4Properties: PROPERTIES, selectedGa4PropertyId: "111" },
    });
    const result = await bulkLinkGoogleAccount({ ...base, projectIds: ["a"] });
    vi.unstubAllGlobals();
    expect(result.ok && result.linked).toBe(1);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(mocks.freshToken).not.toHaveBeenCalled();
    expect(mocks.buildGoogleMetadata).not.toHaveBeenCalled();
    const metadata = mocks.upsert.mock.calls[0]?.[0].create.metadata;
    expect(metadata.ga4Properties).toEqual(PROPERTIES);
    expect(metadata.selectedGa4PropertyId).toBeUndefined();
  });

  it("uses one real token fetch and the Google metadata builder outside mock mode", async () => {
    setup({ a: project("a"), b: project("b") });
    mocks.freshToken.mockResolvedValue("real-token");
    mocks.buildGoogleMetadata.mockResolvedValue({
      connectedEmail: "boss@agency.test",
      ga4Properties: PROPERTIES,
    });
    await bulkLinkGoogleAccount({ ...base, projectIds: ["a", "b"] });
    expect(mocks.freshToken).toHaveBeenCalledTimes(1);
    expect(mocks.freshToken).toHaveBeenCalledWith({ id: "src1", encryptedSecret: "cipher-1" });
    expect(mocks.buildGoogleMetadata).toHaveBeenCalledTimes(1);
    expect(mocks.buildGoogleMetadata.mock.calls[0]?.[0]).toBe("analytics");
    expect(mocks.buildGoogleMetadata.mock.calls[0]?.[1]).toBe("real-token");
  });
});

describe("listWorkspaceGoogleAccounts", () => {
  it("returns one row per Google account with its project count", async () => {
    mocks.findMany.mockResolvedValue([
      { id: "c1", accountLabel: "a@x.test", metadata: { connectedEmail: "a@x.test", googleSub: "s1" } },
      { id: "c2", accountLabel: "a@x.test", metadata: { connectedEmail: "a@x.test", googleSub: "s1" } },
      { id: "c3", accountLabel: "b@x.test", metadata: {} },
      { id: "c4", accountLabel: null, metadata: {} },
    ]);
    expect(await listWorkspaceGoogleAccounts(WS)).toEqual([
      { credentialId: "c1", email: "a@x.test", projectCount: 2 },
      { credentialId: "c3", email: "b@x.test", projectCount: 1 },
    ]);
  });

  it("is empty without a query when the flag is off", async () => {
    mocks.enabled.mockReturnValue(false);
    expect(await listWorkspaceGoogleAccounts(WS)).toEqual([]);
    expect(mocks.findMany).not.toHaveBeenCalled();
  });
});

describe("listLinkableProjects", () => {
  it("leaves out projects that already have an ACTIVE analytics connection", async () => {
    mocks.projectFindMany.mockResolvedValue([
      { id: "p1", name: "One" },
      { id: "p2", name: "Two" },
    ]);
    mocks.findMany.mockResolvedValue([{ projectId: "p2" }]);
    expect(await listLinkableProjects(WS)).toEqual([{ id: "p1", name: "One" }]);
  });
});
