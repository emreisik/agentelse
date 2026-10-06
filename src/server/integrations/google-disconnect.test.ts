import { beforeEach, describe, expect, it, vi } from "vitest";

// Bu dosyanın kanıtladığı: Disconnect token'ı ve Google verisini her
// durumda hemen siler; Google'da iptal yalnız aynı hesabı kullanan başka canlı
// bağlantı yoksa yapılır ve iptal başarısız olsa da silme yine olur.

const mocks = vi.hoisted(() => ({
  findMany: vi.fn(),
  update: vi.fn(),
  deleteLinks: vi.fn(),
  revokeGoogleToken: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    integrationCredential: { findMany: mocks.findMany, update: mocks.update },
    gaPropertyLink: { deleteMany: mocks.deleteLinks },
  },
}));
vi.mock("@/server/security/crypto", () => ({
  decryptSecret: (value: string) => `plain(${value})`,
}));
vi.mock("@/server/integrations/google/oauth", () => ({
  revokeGoogleToken: mocks.revokeGoogleToken,
}));

const { disconnectGoogleCredential } = await import("./google-disconnect");

const credential = {
  id: "cred-ga",
  encryptedSecret: "enc-1",
  metadata: {
    googleSub: "sub-1",
    connectedEmail: "owner@example.com",
    ga4Properties: [{ propertyId: "1", propertyName: "Web", accountName: "A" }],
    selectedGa4PropertyId: "1",
  },
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.findMany.mockResolvedValue([]);
  mocks.update.mockResolvedValue({});
  mocks.deleteLinks.mockResolvedValue({ count: 1 });
  mocks.revokeGoogleToken.mockResolvedValue(undefined);
});

function expectWiped() {
  expect(mocks.update).toHaveBeenCalledWith({
    where: { id: "cred-ga" },
    data: {
      status: "REVOKED",
      encryptedSecret: "",
      metadata: { disconnectedAt: expect.any(String) },
    },
  });
  // Google Analytics ambarı da bağla birlikte gider.
  expect(mocks.deleteLinks).toHaveBeenCalledWith({
    where: { credentialId: "cred-ga" },
  });
}

describe("disconnectGoogleCredential", () => {
  it("revokes at Google when no other connection uses the account", async () => {
    expect(await disconnectGoogleCredential(credential)).toEqual({
      revokedAtGoogle: true,
    });
    expect(mocks.revokeGoogleToken).toHaveBeenCalledWith("plain(enc-1)");
    expectWiped();
  });

  it("keeps Google access while the same account still runs Search Console", async () => {
    mocks.findMany.mockResolvedValue([
      {
        id: "cred-gsc",
        encryptedSecret: "enc-2",
        metadata: { googleSub: "sub-1", connectedEmail: "owner@example.com" },
      },
    ]);
    expect(await disconnectGoogleCredential(credential)).toEqual({
      revokedAtGoogle: false,
    });
    expect(mocks.revokeGoogleToken).not.toHaveBeenCalled();
    expectWiped();
  });

  it("looks for the same account across every workspace, except revoked rows", async () => {
    await disconnectGoogleCredential(credential);
    const where = mocks.findMany.mock.calls[0]?.[0].where;
    expect(where.id).toEqual({ not: "cred-ga" });
    expect(where.status).toEqual({ not: "REVOKED" });
    expect(where.workspaceId).toBeUndefined();
    expect(where.OR).toEqual(
      expect.arrayContaining([
        { encryptedSecret: "enc-1" },
        { metadata: { path: ["googleSub"], equals: "sub-1" } },
      ]),
    );
  });

  it("still wipes the token when Google's revoke fails", async () => {
    mocks.revokeGoogleToken.mockRejectedValue(new Error("network"));
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    expect(await disconnectGoogleCredential(credential)).toEqual({
      revokedAtGoogle: false,
    });
    expectWiped();
  });

  it("does not call Google for a row whose token is already gone", async () => {
    await disconnectGoogleCredential({ ...credential, encryptedSecret: "" });
    expect(mocks.findMany).not.toHaveBeenCalled();
    expect(mocks.revokeGoogleToken).not.toHaveBeenCalled();
    expectWiped();
  });
});
