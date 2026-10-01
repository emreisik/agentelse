import { beforeEach, describe, expect, it, vi } from "vitest";

// What this suite proves: a request is matched to the Instagram Login connection
// by either of the person's ids, a deauthorize only revokes (once) while a
// deletion erases the row, both leave an audit trail, and a request that is not
// signed by Meta is never acted on.

const mocks = vi.hoisted(() => ({
  findMany: vi.fn(),
  update: vi.fn(),
  del: vi.fn(),
  record: vi.fn(),
}));
vi.mock("@/lib/prisma", () => ({
  prisma: {
    integrationCredential: {
      findMany: mocks.findMany,
      update: mocks.update,
      delete: mocks.del,
    },
  },
}));
vi.mock("@/server/repositories/audit-log.repository", () => ({
  AuditLogRepository: { record: mocks.record },
}));
vi.mock("@/lib/env", () => ({
  getEnv: () => ({ INSTAGRAM_APP_SECRET: "ig-secret", META_APP_SECRET: "meta-secret" }),
}));

import { createHmac } from "node:crypto";

const { deauthorizeInstagramUser, deleteInstagramUserData, readSignedUserId } =
  await import("./meta-data-requests");

beforeEach(() => {
  vi.clearAllMocks();
  mocks.update.mockResolvedValue({});
  mocks.del.mockResolvedValue({});
});

const rows = [
  { id: "c1", workspaceId: "ws-1", projectId: "p1" },
  { id: "c2", workspaceId: "ws-2", projectId: "p2" },
];

describe("matching", () => {
  it("finds the Instagram connection by the professional account id OR the app-scoped id", async () => {
    mocks.findMany.mockResolvedValue([]);
    await deleteInstagramUserData("1784");
    const where = mocks.findMany.mock.calls[0]![0].where;
    expect(where.provider).toBe("instagram");
    expect(where.OR).toEqual([
      { metadata: { path: ["instagramAccount", "id"], equals: "1784" } },
      { metadata: { path: ["instagramAccount", "appScopedId"], equals: "1784" } },
    ]);
  });
});

describe("deauthorizeInstagramUser", () => {
  it("revokes each active connection and records it, leaving the row in place", async () => {
    mocks.findMany.mockResolvedValue(rows);
    expect(await deauthorizeInstagramUser("1784")).toBe(2);
    expect(mocks.update).toHaveBeenCalledWith({ where: { id: "c1" }, data: { status: "REVOKED" } });
    expect(mocks.del).not.toHaveBeenCalled();
    expect(mocks.record).toHaveBeenCalledTimes(2);
    expect(mocks.record).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: "ws-1",
        projectId: "p1",
        actorType: "SYSTEM",
        action: "integration_credential.deauthorized_by_instagram",
        entityId: "c1",
      }),
    );
  });

  it("skips connections that are already revoked (so a repeat call changes nothing)", async () => {
    mocks.findMany.mockResolvedValue([]);
    await deauthorizeInstagramUser("1784");
    expect(mocks.findMany.mock.calls[0]![0].where.NOT).toEqual({ status: "REVOKED" });
    expect(mocks.update).not.toHaveBeenCalled();
  });

  it("does nothing, harmlessly, for a person with no connection", async () => {
    mocks.findMany.mockResolvedValue([]);
    expect(await deauthorizeInstagramUser("nobody")).toBe(0);
    expect(mocks.record).not.toHaveBeenCalled();
  });
});

describe("deleteInstagramUserData", () => {
  it("erases every matching connection (revoked or not) and records each", async () => {
    mocks.findMany.mockResolvedValue(rows);
    expect(await deleteInstagramUserData("1784")).toBe(2);
    expect(mocks.del).toHaveBeenCalledWith({ where: { id: "c1" } });
    expect(mocks.del).toHaveBeenCalledWith({ where: { id: "c2" } });
    expect(mocks.findMany.mock.calls[0]![0].where.NOT).toBeUndefined();
    expect(mocks.record).toHaveBeenCalledWith(
      expect.objectContaining({ action: "integration_credential.deleted_on_user_request" }),
    );
  });

  it("returns 0 and writes nothing when there is nothing to erase", async () => {
    mocks.findMany.mockResolvedValue([]);
    expect(await deleteInstagramUserData("nobody")).toBe(0);
    expect(mocks.del).not.toHaveBeenCalled();
  });
});

describe("readSignedUserId", () => {
  const signed = (secret: string, payload: object) => {
    const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
    return `${createHmac("sha256", secret).update(body).digest("base64url")}.${body}`;
  };
  const post = (fields: Record<string, string>) =>
    new Request("https://app.example.com/x", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(fields).toString(),
    });

  it("reads the user id from a request signed with either app secret", async () => {
    const payload = { algorithm: "HMAC-SHA256", user_id: "1784" };
    expect(await readSignedUserId(post({ signed_request: signed("ig-secret", payload) }))).toBe("1784");
    expect(await readSignedUserId(post({ signed_request: signed("meta-secret", payload) }))).toBe("1784");
  });

  it("returns null for a bad signature, a missing field, or a non-form body", async () => {
    const payload = { algorithm: "HMAC-SHA256", user_id: "1784" };
    expect(await readSignedUserId(post({ signed_request: signed("wrong", payload) }))).toBeNull();
    expect(await readSignedUserId(post({}))).toBeNull();
    expect(
      await readSignedUserId(
        new Request("https://app.example.com/x", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: "{}",
        }),
      ),
    ).toBeNull();
  });
});
