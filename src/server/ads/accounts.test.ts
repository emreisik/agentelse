import { beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({
  credentialFindUnique: vi.fn(),
  accountFindUnique: vi.fn(),
  accountUpsert: vi.fn(),
  linkUpdateMany: vi.fn(),
  linkUpsert: vi.fn(),
  transaction: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    integrationCredential: { findUnique: m.credentialFindUnique },
    adsAccount: { findUnique: m.accountFindUnique, upsert: m.accountUpsert },
    adsAccountProject: { updateMany: m.linkUpdateMany, upsert: m.linkUpsert },
    $transaction: m.transaction,
  },
}));
vi.mock("@/server/security/crypto", () => ({ decryptSecret: () => "tok" }));

const { AdsAccounts } = await import("./accounts");

const credential = (metadata: Record<string, unknown>) => ({
  id: "cred-1",
  status: "ACTIVE",
  workspaceId: "ws-1",
  brandId: "b-1",
  metadata,
});

const ready = {
  selectedAdAccountId: "act_1",
  adAccounts: [{ adAccountId: "act_1", adAccountName: "Main", currency: "try" }],
  selectedPageId: "pg1",
  pages: [{ pageId: "pg1", pageName: "Cafe Lale" }],
};

beforeEach(() => {
  vi.clearAllMocks();
  m.accountFindUnique.mockResolvedValue(null);
  m.accountUpsert.mockResolvedValue({
    id: "row-1",
    name: "Main",
    currency: "TRY",
    timezoneName: null,
    healthStatus: "UNKNOWN",
    healthReason: null,
    rateLimitedUntil: null,
  });
  m.transaction.mockResolvedValue([]);
});

describe("AdsAccounts.resolve (docs/meta-ads-plan.md F1)", () => {
  it("says what is missing", async () => {
    m.credentialFindUnique.mockResolvedValueOnce(null);
    expect((await AdsAccounts.resolve("p1")).status).toBe("needs-connect");

    m.credentialFindUnique.mockResolvedValueOnce(credential({}));
    expect((await AdsAccounts.resolve("p1")).status).toBe("needs-account");

    m.credentialFindUnique.mockResolvedValueOnce(
      credential({ ...ready, selectedPageId: undefined }),
    );
    expect((await AdsAccounts.resolve("p1")).status).toBe("needs-page");
  });

  it("creates the account row on first read and selects it for the project", async () => {
    m.credentialFindUnique.mockResolvedValue(credential(ready));
    const account = await AdsAccounts.resolve("p1");
    expect(account).toMatchObject({
      status: "ready",
      adAccountId: "act_1",
      currency: "TRY",
      pageName: "Cafe Lale",
      adsAccountRowId: "row-1",
    });
    expect(m.accountUpsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          workspaceId_platform_externalId: {
            workspaceId: "ws-1",
            platform: "META",
            externalId: "act_1",
          },
        },
      }),
    );
    expect(m.transaction).toHaveBeenCalledTimes(1);
  });

  it("writes nothing when the row is already current", async () => {
    m.credentialFindUnique.mockResolvedValue(credential(ready));
    m.accountFindUnique.mockResolvedValue({
      id: "row-1",
      credentialId: "cred-1",
      name: "Main",
      currency: "TRY",
      pageId: "pg1",
      projects: [{ selected: true }],
      healthStatus: "OK",
    });
    await AdsAccounts.resolve("p1");
    expect(m.accountUpsert).not.toHaveBeenCalled();
    expect(m.transaction).not.toHaveBeenCalled();
  });

  it("still answers from the connection when the account table cannot be read", async () => {
    m.credentialFindUnique.mockResolvedValue(credential(ready));
    m.accountFindUnique.mockRejectedValue(new Error("db down"));
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(await AdsAccounts.resolve("p1")).toMatchObject({
      status: "ready",
      adAccountId: "act_1",
      currency: "TRY",
    });
    err.mockRestore();
  });
});
