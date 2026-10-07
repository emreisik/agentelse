import { beforeEach, describe, expect, it, vi } from "vitest";

// Bu dosyanın kanıtladığı: bayrak kapalıyken bağ eşitlemesi bugünkü sorguları ve
// yük verilerini birebir atar (fazladan updateMany yok); ek (isSecondary) bir
// bağ seçimle ana mülk olunca isSecondary:false yazılır, ek olmayan bağda bu
// alan hiç eklenmez; ek mülk seçili mülk değilse düşürülmez.

const db = vi.hoisted(() => ({
  gaPropertyLink: {
    findMany: vi.fn(),
    update: vi.fn(),
    updateMany: vi.fn(),
    upsert: vi.fn(),
  },
  integrationCredential: { findFirst: vi.fn() },
}));
vi.mock("@/lib/prisma", () => ({ prisma: db }));

const { ensureGaLinkForProject } = await import("./links");

const CREDENTIAL = {
  id: "cred-1",
  workspaceId: "ws-1",
  projectId: "p1",
  metadata: {
    selectedGa4PropertyId: "200",
    selectedGa4PropertyName: "Blog",
    ga4Properties: [
      { propertyId: "100", propertyName: "Main", accountName: "Acme" },
      { propertyId: "200", propertyName: "Blog", accountName: "Acme" },
    ],
  },
};

function link(partial: Record<string, unknown>) {
  return {
    id: "l",
    propertyId: "100",
    isPrimary: false,
    isSecondary: false,
    credentialId: "cred-1",
    ...partial,
  };
}

beforeEach(() => {
  vi.unstubAllEnvs();
  vi.stubEnv("NODE_ENV", "test");
  vi.stubEnv("GA_SYNC", "true");
  for (const model of Object.values(db)) {
    for (const fn of Object.values(model)) fn.mockReset();
  }
  db.integrationCredential.findFirst.mockResolvedValue(CREDENTIAL);
  db.gaPropertyLink.update.mockResolvedValue({});
  db.gaPropertyLink.updateMany.mockResolvedValue({ count: 1 });
  db.gaPropertyLink.upsert.mockResolvedValue({});
});

describe("reconcileProject (via ensureGaLinkForProject)", () => {
  it("selects isSecondary in the one existing read, without extra queries", async () => {
    db.gaPropertyLink.findMany.mockResolvedValue([]);
    await ensureGaLinkForProject("p1");
    expect(db.gaPropertyLink.findMany).toHaveBeenCalledTimes(1);
    expect(db.gaPropertyLink.findMany).toHaveBeenCalledWith({
      where: { projectId: "p1" },
      select: {
        id: true,
        propertyId: true,
        isPrimary: true,
        isSecondary: true,
        credentialId: true,
      },
    });
    expect(db.gaPropertyLink.updateMany).not.toHaveBeenCalled();
  });

  it("keeps today's payloads for a plain primary swap", async () => {
    db.gaPropertyLink.findMany.mockResolvedValue([
      link({ id: "old", propertyId: "100", isPrimary: true }),
      link({ id: "new", propertyId: "200", isPrimary: false }),
    ]);
    await ensureGaLinkForProject("p1");
    // Eski birincil düşer; yeni bağ birincil olur; isSecondary alanı yok.
    expect(db.gaPropertyLink.updateMany).toHaveBeenCalledTimes(1);
    expect(db.gaPropertyLink.updateMany).toHaveBeenCalledWith({
      where: { id: { in: ["old"] } },
      data: { isPrimary: false, syncLeaseUntil: null, syncLeaseOwner: null },
    });
    expect(db.gaPropertyLink.update).toHaveBeenCalledWith({
      where: { id: "new" },
      data: { isPrimary: true, credentialId: "cred-1" },
    });
  });

  it("clears isSecondary when a secondary becomes the primary", async () => {
    db.gaPropertyLink.findMany.mockResolvedValue([
      link({ id: "old", propertyId: "100", isPrimary: true }),
      link({ id: "extra", propertyId: "200", isSecondary: true }),
    ]);
    await ensureGaLinkForProject("p1");
    expect(db.gaPropertyLink.update).toHaveBeenCalledWith({
      where: { id: "extra" },
      data: { isPrimary: true, credentialId: "cred-1", isSecondary: false },
    });
  });

  it("does not drop a secondary that is not the selected property", async () => {
    db.integrationCredential.findFirst.mockResolvedValue({
      ...CREDENTIAL,
      metadata: { ...CREDENTIAL.metadata, selectedGa4PropertyId: "100" },
    });
    db.gaPropertyLink.findMany.mockResolvedValue([
      link({ id: "main", propertyId: "100", isPrimary: true, credentialId: "cred-1" }),
      link({ id: "extra", propertyId: "200", isSecondary: true }),
    ]);
    await ensureGaLinkForProject("p1");
    expect(db.gaPropertyLink.updateMany).not.toHaveBeenCalled();
    expect(db.gaPropertyLink.update).not.toHaveBeenCalled();
  });
});
