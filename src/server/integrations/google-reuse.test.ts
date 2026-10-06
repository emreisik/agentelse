import { beforeEach, describe, expect, it, vi } from "vitest";

// Bu dosyanın kanıtladığı: "Use existing connection" yalnız aynı workspace'in,
// aynı servisin, başka projelerdeki canlı ve token'ı olan bağlantılarını
// önerir; her Google hesabı bir kez listelenir ve hangi projede bağlı olduğu
// söylenir.

const credentialFindMany = vi.fn();
const projectFindMany = vi.fn();
vi.mock("@/lib/prisma", () => ({
  prisma: {
    integrationCredential: { findMany: credentialFindMany },
    project: { findMany: projectFindMany },
  },
}));

const { listReusableGoogleConnections } = await import("./google-reuse");

const input = {
  workspaceId: "ws-1",
  projectId: "proj-1",
  service: "analytics" as const,
};

beforeEach(() => {
  vi.clearAllMocks();
  credentialFindMany.mockResolvedValue([]);
  projectFindMany.mockResolvedValue([]);
});

describe("listReusableGoogleConnections", () => {
  it("asks only for this workspace's live connections of the same service in other projects", async () => {
    await listReusableGoogleConnections(input);
    expect(credentialFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          workspaceId: "ws-1",
          provider: "google_analytics",
          status: "ACTIVE",
          projectId: { not: "proj-1" },
          NOT: { encryptedSecret: "" },
        },
      }),
    );
  });

  it("has nothing to offer without such a connection, and reads no projects", async () => {
    expect(await listReusableGoogleConnections(input)).toEqual([]);
    expect(projectFindMany).not.toHaveBeenCalled();
  });

  it("lists each Google account once, with the project it is connected in", async () => {
    credentialFindMany.mockResolvedValue([
      {
        id: "cred-a",
        projectId: "proj-2",
        accountLabel: "owner@example.com",
        metadata: { googleSub: "sub-1", connectedEmail: "owner@example.com" },
      },
      // Aynı hesap (aynı googleSub), başka proje: tekrar listelenmez.
      {
        id: "cred-b",
        projectId: "proj-3",
        accountLabel: "owner@example.com",
        metadata: { googleSub: "sub-1", connectedEmail: "owner@example.com" },
      },
      // Kimliği bilinmeyen eski satır: e-postayla (büyük/küçük harf
      // duyarsız) tanınır.
      {
        id: "cred-c",
        projectId: "proj-3",
        accountLabel: "Agency@Example.com",
        metadata: {},
      },
      {
        id: "cred-d",
        projectId: "proj-4",
        accountLabel: "agency@example.com",
        metadata: {},
      },
      // E-postası olmayan satır önerilemez.
      { id: "cred-e", projectId: "proj-4", accountLabel: null, metadata: {} },
    ]);
    projectFindMany.mockResolvedValue([
      { id: "proj-2", name: "Web Health" },
      { id: "proj-3", name: "Acme" },
    ]);

    expect(await listReusableGoogleConnections(input)).toEqual([
      {
        credentialId: "cred-a",
        email: "owner@example.com",
        projectName: "Web Health",
      },
      {
        credentialId: "cred-c",
        email: "Agency@Example.com",
        projectName: "Acme",
      },
    ]);
    expect(projectFindMany).toHaveBeenCalledWith({
      where: { id: { in: ["proj-2", "proj-3", "proj-4"] } },
      select: { id: true, name: true },
    });
  });

  it("names a project it cannot find generically", async () => {
    credentialFindMany.mockResolvedValue([
      {
        id: "cred-a",
        projectId: "proj-9",
        accountLabel: "owner@example.com",
        metadata: { connectedEmail: "owner@example.com" },
      },
    ]);
    expect(await listReusableGoogleConnections(input)).toEqual([
      {
        credentialId: "cred-a",
        email: "owner@example.com",
        projectName: "another project",
      },
    ]);
  });
});
