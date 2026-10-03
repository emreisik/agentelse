import { beforeEach, describe, expect, it, vi } from "vitest";

// What this suite proves: Disconnect sticks. A disconnected (REVOKED) Meta
// connection keeps its token, but the Test button cannot use it to set the row
// ACTIVE again; only a new OAuth connection can. A live connection still tests
// and stays ACTIVE.

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

const requireUser = vi.fn();
const requireProjectAccess = vi.fn();
vi.mock("@/server/security/tenant-context", () => ({
  requireUser,
  requireProjectAccess,
}));

const findUnique = vi.fn();
const update = vi.fn();
const updateMany = vi.fn();
vi.mock("@/lib/prisma", () => ({
  prisma: { integrationCredential: { findUnique, update, updateMany } },
}));
vi.mock("@/server/security/crypto", () => ({
  decryptSecret: () => "user-token",
}));
vi.mock("@/server/repositories/audit-log.repository", () => ({
  AuditLogRepository: { record: vi.fn() },
}));

const verifyFacebookPageAccess = vi.fn();
vi.mock("@/server/integrations/meta-client", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("@/server/integrations/meta-client")
  >()),
  verifyFacebookPageAccess,
}));

const { testMetaConnectionAction } = await import("./meta-actions");

const form = () => {
  const data = new FormData();
  data.set("projectId", "proj-1");
  data.set("service", "facebook");
  return data;
};
const row = (status: string) => ({
  id: "cred-fb",
  status,
  encryptedSecret: "encrypted",
  metadata: {
    selectedPageId: "page-1",
    pages: [{ pageId: "page-1", pageName: "Web Health" }],
  },
});

beforeEach(() => {
  vi.clearAllMocks();
  requireUser.mockResolvedValue({ userId: "user-1", email: null });
  requireProjectAccess.mockResolvedValue({
    workspaceId: "ws-1",
    projectId: "proj-1",
    defaultBrandId: "brand-1",
  });
  verifyFacebookPageAccess.mockResolvedValue("Web Health");
  update.mockResolvedValue({});
  updateMany.mockResolvedValue({ count: 1 });
});

describe("testMetaConnectionAction", () => {
  it("does not bring a disconnected connection back", async () => {
    findUnique.mockResolvedValue(row("REVOKED"));

    expect(await testMetaConnectionAction(form())).toEqual({
      ok: false,
      message: "Facebook connection not found",
    });
    expect(verifyFacebookPageAccess).not.toHaveBeenCalled();
    expect(update).not.toHaveBeenCalled();
    expect(updateMany).not.toHaveBeenCalled();
  });

  it("still tests a live connection with the selected Page and keeps it ACTIVE", async () => {
    findUnique.mockResolvedValue(row("ACTIVE"));

    expect(await testMetaConnectionAction(form())).toEqual({ ok: true });
    expect(verifyFacebookPageAccess).toHaveBeenCalledWith(
      "page-1",
      "user-token",
    );
    // Written only while not REVOKED: a Disconnect during the test wins.
    expect(updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "cred-fb", status: { not: "REVOKED" } },
        data: expect.objectContaining({ status: "ACTIVE" }),
      }),
    );
  });
});
