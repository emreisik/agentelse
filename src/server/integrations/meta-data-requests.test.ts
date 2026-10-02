import { beforeEach, describe, expect, it, vi } from "vitest";

// What this suite proves: a request is matched to the Instagram Login connection
// by either of the person's ids, a deauthorize only revokes (once) while a
// deletion erases the row, both leave an audit trail, and a request that is not
// signed by Meta is never acted on.

const mocks = vi.hoisted(() => ({
  findMany: vi.fn(),
  updateMany: vi.fn(),
  deleteMany: vi.fn(),
  auditCreate: vi.fn(),
  committed: [] as string[],
}));
// A transaction here is the callback run against the same mocks; when it throws,
// what it had written is reported as rolled back (the audit entries are the proof).
vi.mock("@/lib/prisma", () => {
  const tx = {
    integrationCredential: {
      updateMany: mocks.updateMany,
      deleteMany: mocks.deleteMany,
    },
    auditLog: { create: mocks.auditCreate },
  };
  return {
    prisma: {
      integrationCredential: { findMany: mocks.findMany },
      $transaction: async (fn: (client: typeof tx) => Promise<unknown>) => {
        const before = mocks.auditCreate.mock.calls.length;
        const result = await fn(tx); // a throw here is the rollback: nothing is recorded as committed
        mocks.committed.push(...mocks.auditCreate.mock.calls.slice(before).map((c) => c[0].data.entityId));
        return result;
      },
    },
  };
});
vi.mock("@/lib/env", () => ({
  getEnv: () => ({ INSTAGRAM_APP_SECRET: "ig-secret", META_APP_SECRET: "meta-secret" }),
}));

import { createHmac } from "node:crypto";

const { deauthorizeInstagramUser, deleteInstagramUserData, readSignedUserId } =
  await import("./meta-data-requests");

beforeEach(() => {
  vi.clearAllMocks();
  mocks.committed.length = 0;
  mocks.updateMany.mockResolvedValue({ count: 1 });
  mocks.deleteMany.mockResolvedValue({ count: 1 });
  mocks.auditCreate.mockResolvedValue({});
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
    expect(mocks.updateMany).toHaveBeenCalledWith({
      where: { id: "c1", NOT: { status: "REVOKED" } },
      data: { status: "REVOKED" },
    });
    expect(mocks.deleteMany).not.toHaveBeenCalled();
    expect(mocks.auditCreate).toHaveBeenCalledTimes(2);
    expect(mocks.auditCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        workspaceId: "ws-1",
        projectId: "p1",
        actorType: "SYSTEM",
        action: "integration_credential.deauthorized_by_instagram",
        entityId: "c1",
      }),
    });
  });

  it("skips connections that are already revoked (so a repeat call changes nothing)", async () => {
    mocks.findMany.mockResolvedValue([]);
    await deauthorizeInstagramUser("1784");
    expect(mocks.findMany.mock.calls[0]![0].where.NOT).toEqual({ status: "REVOKED" });
    expect(mocks.updateMany).not.toHaveBeenCalled();
  });

  it("does nothing, harmlessly, for a person with no connection", async () => {
    mocks.findMany.mockResolvedValue([]);
    expect(await deauthorizeInstagramUser("nobody")).toBe(0);
    expect(mocks.auditCreate).not.toHaveBeenCalled();
  });

  // The row was revoked by a concurrent callback between our read and our write.
  it("counts zero and writes no audit entry, without failing, for a row someone else just revoked", async () => {
    mocks.findMany.mockResolvedValue(rows);
    mocks.updateMany.mockResolvedValueOnce({ count: 0 }).mockResolvedValueOnce({ count: 1 });
    expect(await deauthorizeInstagramUser("1784")).toBe(1);
    expect(mocks.auditCreate).toHaveBeenCalledTimes(1);
    expect(mocks.auditCreate.mock.calls[0]![0].data.entityId).toBe("c2");
  });

  it("when the audit write fails the revoke is not committed either, so a retry still does both", async () => {
    mocks.findMany.mockResolvedValue([rows[0]]);
    mocks.auditCreate.mockRejectedValueOnce(new Error("db blip"));
    await expect(deauthorizeInstagramUser("1784")).rejects.toThrow("db blip");
    expect(mocks.committed).toEqual([]);
    // the retry: the row is still ACTIVE, so it is found and handled in full
    expect(await deauthorizeInstagramUser("1784")).toBe(1);
    expect(mocks.committed).toEqual(["c1"]);
  });
});

describe("deleteInstagramUserData", () => {
  it("erases every matching connection (revoked or not) and records each", async () => {
    mocks.findMany.mockResolvedValue(rows);
    expect(await deleteInstagramUserData("1784")).toBe(2);
    expect(mocks.deleteMany).toHaveBeenCalledWith({ where: { id: "c1" } });
    expect(mocks.deleteMany).toHaveBeenCalledWith({ where: { id: "c2" } });
    expect(mocks.findMany.mock.calls[0]![0].where.NOT).toBeUndefined();
    expect(mocks.auditCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({ action: "integration_credential.deleted_on_user_request" }),
    });
  });

  it("returns 0 and writes nothing when there is nothing to erase", async () => {
    mocks.findMany.mockResolvedValue([]);
    expect(await deleteInstagramUserData("nobody")).toBe(0);
    expect(mocks.deleteMany).not.toHaveBeenCalled();
  });

  // Meta resent the request (its first attempt timed out after a slow database wake-up)
  // and both ran at once: the second finds the row already erased by the first.
  it("treats a row that vanished between the read and the write as 'not ours to count', never as an error", async () => {
    mocks.findMany.mockResolvedValue(rows);
    mocks.deleteMany.mockResolvedValueOnce({ count: 0 }).mockResolvedValueOnce({ count: 1 });
    expect(await deleteInstagramUserData("1784")).toBe(1);
    expect(mocks.auditCreate).toHaveBeenCalledTimes(1);
    expect(mocks.auditCreate.mock.calls[0]![0].data.entityId).toBe("c2");
  });

  it("when the audit write fails nothing is erased, so the retry erases it and counts it", async () => {
    mocks.findMany.mockResolvedValue([rows[0]]);
    mocks.auditCreate.mockRejectedValueOnce(new Error("db blip"));
    await expect(deleteInstagramUserData("1784")).rejects.toThrow("db blip");
    expect(mocks.committed).toEqual([]);
    expect(await deleteInstagramUserData("1784")).toBe(1);
    expect(mocks.committed).toEqual(["c1"]);
  });

  it("counts only what this call really erased when a later row fails", async () => {
    mocks.findMany.mockResolvedValue(rows);
    mocks.auditCreate.mockResolvedValueOnce({}).mockRejectedValueOnce(new Error("db blip"));
    await expect(deleteInstagramUserData("1784")).rejects.toThrow("db blip");
    // c1 is committed with its audit entry; c2's work did not commit. The route
    // answers 5xx so Meta retries, and the retry sees only c2.
    expect(mocks.committed).toEqual(["c1"]);
  });
});

describe("readSignedUserId: bounded body", () => {
  const payload = { algorithm: "HMAC-SHA256", user_id: "1784" };
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const valid = `${createHmac("sha256", "ig-secret").update(body).digest("base64url")}.${body}`;

  const withBody = (init: RequestInit & { duplex?: "half" }) =>
    new Request("https://app.example.com/x", { method: "POST", ...init });

  it("refuses a body that declares itself larger than a real callback, without reading it", async () => {
    const request = withBody({
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        "Content-Length": String(10 * 1024 * 1024),
      },
      body: new URLSearchParams({ signed_request: valid }).toString(),
    });
    const getReader = vi.spyOn(request.body!, "getReader");
    expect(await readSignedUserId(request)).toBeNull();
    expect(getReader).not.toHaveBeenCalled();
  });

  it("stops reading a streamed body that never declared its size once it passes the cap", async () => {
    let pulled = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulled += 1;
        controller.enqueue(new TextEncoder().encode("x".repeat(8 * 1024)));
        if (pulled > 1000) controller.close();
      },
    });
    const request = withBody({
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: stream,
      duplex: "half",
    });
    expect(await readSignedUserId(request)).toBeNull();
    // It stopped long before the 1000 chunks (8 MB) the sender was ready to push.
    expect(pulled).toBeLessThan(10);
  });

  it("answers null at once for the long '=' run, whatever the size", async () => {
    const started = performance.now();
    const hostile = new Request("https://app.example.com/x", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ signed_request: "=".repeat(100_000) + "x.y" }).toString(),
    });
    expect(await readSignedUserId(hostile)).toBeNull();
    expect(performance.now() - started).toBeLessThan(500);
  });

  it("still reads a normal callback", async () => {
    const request = withBody({
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ signed_request: valid }).toString(),
    });
    expect(await readSignedUserId(request)).toBe("1784");
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
