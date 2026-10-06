import { beforeEach, describe, expect, it, vi } from "vitest";

// Ajans bağlantısı (docs/meta-ads-plan.md F8): BISU türü, hesabın projeye
// atanması (yalnız bağlantının kendi hesabı, yalnız workspace'in projesi) ve
// Disconnect sırası (önce güvenlik kuralları, sonra kopyalar ve bağlantı).

const db = vi.hoisted(() => ({
  connectionFindFirst: vi.fn(),
  connectionCreate: vi.fn(),
  connectionUpdate: vi.fn(),
  projectFindFirst: vi.fn(),
  brandFindFirst: vi.fn(),
  credentialUpsert: vi.fn(),
  credentialFindMany: vi.fn(),
  credentialUpdate: vi.fn(),
  credentialUpdateMany: vi.fn(),
  accountUpdate: vi.fn(),
  accountUpdateMany: vi.fn(),
  linkDeleteMany: vi.fn(),
  executeRaw: vi.fn(),
}));
const graph = vi.hoisted(() => ({
  exchangeBusinessCode: vi.fn(),
  readBusinessIdentity: vi.fn(),
  listBusinessAdAccounts: vi.fn(),
  listBusinessPages: vi.fn(),
  inspectMetaToken: vi.fn(),
}));
const rows = vi.hoisted(() => ({ ensureAdsAccountRow: vi.fn() }));
const insurance = vi.hoisted(() => ({ removeForProject: vi.fn() }));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/prisma", () => ({
  prisma: {
    adsConnection: {
      findFirst: db.connectionFindFirst,
      create: db.connectionCreate,
      update: db.connectionUpdate,
    },
    project: { findFirst: db.projectFindFirst },
    brand: { findFirst: db.brandFindFirst },
    integrationCredential: {
      upsert: db.credentialUpsert,
      findMany: db.credentialFindMany,
      update: db.credentialUpdate,
      updateMany: db.credentialUpdateMany,
    },
    adsAccount: { update: db.accountUpdate, updateMany: db.accountUpdateMany },
    adsAccountProject: { deleteMany: db.linkDeleteMany },
    $executeRaw: db.executeRaw,
  },
}));
vi.mock("@/server/integrations/meta/business-login", () => graph);
vi.mock("@/server/integrations/meta-client", () => ({
  inspectMetaToken: graph.inspectMetaToken,
  META_PROVIDER: { instagram: "instagram", facebook: "facebook", ads: "meta_ads" },
}));
vi.mock("@/server/ads/accounts", () => rows);
vi.mock("@/server/ads/insurance", () => ({ AdsInsurance: insurance }));
vi.mock("@/server/repositories/audit-log.repository", () => ({
  AuditLogRepository: { record: vi.fn().mockResolvedValue(undefined) },
}));
vi.mock("@/server/integrations/meta/call-context", () => ({
  withMetaCallContext: (_c: unknown, run: () => unknown) => run(),
}));

import { decryptSecret } from "@/server/security/crypto";
import { decryptToken } from "@/server/security/key-ring";

import { AdsConnections } from "./connections";

const NOW = new Date("2026-10-06T10:00:00Z");

function connection(overrides: Record<string, unknown> = {}) {
  return {
    id: "conn-1",
    workspaceId: "ws-1",
    kind: "BISU",
    name: "Client Co",
    clientBusinessId: "biz-1",
    encryptedSecret: "",
    keyId: "legacy",
    scopes: [],
    expiresAt: null,
    dataAccessExpiresAt: null,
    status: "ACTIVE",
    lastCheckedAt: NOW,
    ...overrides,
  };
}

describe("AdsConnections", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    db.credentialFindMany.mockResolvedValue([]);
    db.connectionCreate.mockImplementation(async ({ data }: { data: Record<string, unknown> }) =>
      connection({ ...data, id: "conn-new" }),
    );
    db.connectionUpdate.mockImplementation(async ({ data }: { data: Record<string, unknown> }) =>
      connection(data),
    );
    graph.listBusinessAdAccounts.mockResolvedValue([
      { adAccountId: "act_111", adAccountName: "Client main", currency: "EUR" },
    ]);
    graph.listBusinessPages.mockResolvedValue([{ pageId: "page-1", pageName: "Client Page" }]);
    db.projectFindFirst.mockResolvedValue({ id: "p-1" });
    db.brandFindFirst.mockResolvedValue({ id: "b-1" });
    db.credentialUpsert.mockResolvedValue({ id: "cred-1" });
    rows.ensureAdsAccountRow.mockResolvedValue({ id: "row-1" });
  });

  it("stores a permanent business login as BISU with the token encrypted", async () => {
    graph.exchangeBusinessCode.mockResolvedValue("bisu-token");
    graph.readBusinessIdentity.mockResolvedValue({ id: "su-1", name: "Client Co", clientBusinessId: "biz-1" });
    graph.inspectMetaToken.mockResolvedValue({ isValid: true, scopes: ["ads_management"], granularScopes: [] });
    db.connectionFindFirst.mockResolvedValue(null);
    const created = await AdsConnections.connectFromCode({
      workspaceId: "ws-1",
      userId: "u-1",
      code: "code-1",
      now: NOW,
    });
    const data = db.connectionCreate.mock.calls[0]![0].data;
    expect(data).toMatchObject({ kind: "BISU", clientBusinessId: "biz-1", expiresAt: null, workspaceId: "ws-1" });
    expect(data.encryptedSecret).not.toContain("bisu-token");
    expect(decryptToken(data.encryptedSecret, data.keyId)).toBe("bisu-token");
    expect(created.id).toBe("conn-new");
  });

  it("a login that expires is a USER connection, and reconnecting updates the same row", async () => {
    graph.exchangeBusinessCode.mockResolvedValue("user-token");
    graph.readBusinessIdentity.mockResolvedValue({ id: "u-9", name: null, clientBusinessId: "biz-1" });
    graph.inspectMetaToken.mockResolvedValue({
      isValid: true,
      expiresAt: 1_800_000_000,
      scopes: [],
      granularScopes: [],
    });
    db.connectionFindFirst.mockResolvedValue(connection());
    await AdsConnections.connectFromCode({ workspaceId: "ws-1", userId: "u-1", code: "c", now: NOW });
    expect(db.connectionCreate).not.toHaveBeenCalled();
    expect(db.connectionUpdate.mock.calls[0]![0]).toMatchObject({
      where: { id: "conn-1" },
      data: { kind: "USER" },
    });
  });

  it("assigns only the connection's own ad account to a project of the workspace", async () => {
    const sealedConnection = connection({ encryptedSecret: "" });
    const { encryptToken } = await import("@/server/security/key-ring");
    Object.assign(sealedConnection, encryptToken("bisu-token"));
    db.connectionFindFirst.mockResolvedValue(sealedConnection);

    expect(
      await AdsConnections.assign({
        connectionId: "conn-1",
        workspaceId: "ws-1",
        projectId: "p-1",
        adAccountId: "act_999",
        userId: "u-1",
        now: NOW,
      }),
    ).toEqual({ ok: false, message: "This ad account isn't in this connection." });
    expect(db.credentialUpsert).not.toHaveBeenCalled();

    db.projectFindFirst.mockResolvedValue(null);
    expect(
      (
        await AdsConnections.assign({
          connectionId: "conn-1",
          workspaceId: "ws-1",
          projectId: "p-other",
          adAccountId: "act_111",
          userId: "u-1",
          now: NOW,
        })
      ).ok,
    ).toBe(false);

    db.projectFindFirst.mockResolvedValue({ id: "p-1" });
    expect(
      await AdsConnections.assign({
        connectionId: "conn-1",
        workspaceId: "ws-1",
        projectId: "p-1",
        adAccountId: "111",
        pageId: "page-1",
        userId: "u-1",
        now: NOW,
      }),
    ).toEqual({ ok: true });
    const upsert = db.credentialUpsert.mock.calls[0]![0];
    expect(upsert.where).toEqual({ projectId_provider: { projectId: "p-1", provider: "meta_ads" } });
    expect(upsert.create.metadata).toMatchObject({
      selectedAdAccountId: "act_111",
      selectedPageId: "page-1",
      connectionId: "conn-1",
      connectionKind: "BISU",
      tokenHealth: { isValid: true },
    });
    // Proje kopyası mevcut yolların okuduğu ortak anahtarla şifreli.
    expect(decryptSecret(upsert.create.encryptedSecret)).toBe("bisu-token");
    expect(db.accountUpdate).toHaveBeenCalledWith({
      where: { id: "row-1" },
      data: { connectionId: "conn-1" },
    });
  });

  it("disconnect removes safety rules first, then the copies and the connection", async () => {
    const { encryptToken } = await import("@/server/security/key-ring");
    db.connectionFindFirst.mockResolvedValue(connection(encryptToken("bisu-token")));
    db.credentialFindMany.mockResolvedValue([
      { id: "cred-1", projectId: "p-1", workspaceId: "ws-1", status: "ACTIVE" },
      { id: "cred-2", projectId: "p-2", workspaceId: "ws-1", status: "ACTIVE" },
    ]);
    const order: string[] = [];
    insurance.removeForProject.mockImplementation(async (projectId: string) => {
      order.push(`rules:${projectId}`);
      return { removed: 1, failed: 0 };
    });
    db.credentialUpdate.mockImplementation(async ({ where }: { where: { id: string } }) => {
      order.push(`revoke:${where.id}`);
    });
    db.linkDeleteMany.mockResolvedValue({ count: 1 });
    expect(
      await AdsConnections.disconnect({ connectionId: "conn-1", workspaceId: "ws-1", userId: "u-1" }),
    ).toEqual({ ok: true });
    expect(order).toEqual(["rules:p-1", "revoke:cred-1", "rules:p-2", "revoke:cred-2"]);
    expect(insurance.removeForProject).toHaveBeenCalledWith("p-1", "bisu-token");
    expect(db.connectionUpdate).toHaveBeenCalledWith({
      where: { id: "conn-1" },
      data: { status: "REVOKED", encryptedSecret: "" },
    });
  });
});
