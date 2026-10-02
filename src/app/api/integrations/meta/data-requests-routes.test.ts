import { createHmac } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";

// What this suite proves: Meta's two server-to-server callbacks answer what Meta
// expects (200 {} for deauthorize, { url, confirmation_code } for deletion), do
// the work only for a signed request, and the code in the answer opens the status
// page's reading of it.

const mocks = vi.hoisted(() => ({
  deauthorize: vi.fn(),
  erase: vi.fn(),
}));
vi.mock("@/lib/env", () => ({
  getEnv: () => ({
    INSTAGRAM_APP_SECRET: "ig-secret",
    META_APP_SECRET: "meta-secret",
    AUTH_SECRET: "auth-secret",
    NEXT_PUBLIC_APP_URL: "https://app.example.com",
  }),
}));
vi.mock("@/server/integrations/meta-data-requests", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/server/integrations/meta-data-requests")>();
  return {
    ...actual,
    deauthorizeInstagramUser: mocks.deauthorize,
    deleteInstagramUserData: mocks.erase,
  };
});
vi.mock("@/lib/prisma", () => ({ prisma: {} }));
vi.mock("@/server/repositories/audit-log.repository", () => ({
  AuditLogRepository: { record: vi.fn() },
}));

const { POST: deauthorize } = await import("./deauthorize/route");
const { POST: dataDeletion } = await import("./data-deletion/route");
const { readDeletionCode } = await import("@/lib/meta-signed-request");

const signed = (secret: string) => {
  const body = Buffer.from(
    JSON.stringify({ algorithm: "HMAC-SHA256", user_id: "1784" }),
  ).toString("base64url");
  return `${createHmac("sha256", secret).update(body).digest("base64url")}.${body}`;
};
const post = (signedRequest?: string) =>
  new Request("https://app.example.com/api/integrations/meta/x", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(signedRequest ? { signed_request: signedRequest } : {}).toString(),
  });

beforeEach(() => {
  vi.clearAllMocks();
  mocks.deauthorize.mockResolvedValue(1);
  mocks.erase.mockResolvedValue(1);
});

describe("deauthorize callback", () => {
  it("answers 200 {} and revokes for a signed request", async () => {
    const response = await deauthorize(post(signed("ig-secret")));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({});
    expect(mocks.deauthorize).toHaveBeenCalledWith("1784");
  });

  it("logs every verified request with its match count (never the id) and every rejection", async () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    mocks.deauthorize.mockResolvedValue(0);
    await deauthorize(post(signed("ig-secret")));
    expect(info).toHaveBeenCalledOnce();
    const line = String(info.mock.calls[0]![0]);
    expect(line).toContain("0 connection(s) revoked");
    expect(line).toContain("id length 4");
    expect(line).not.toContain("1784");

    await deauthorize(post(signed("attacker")));
    expect(warn).toHaveBeenCalledOnce();
    expect(String(warn.mock.calls[0]![0])).toContain("rejected");
    info.mockRestore();
    warn.mockRestore();
  });

  it("answers 400 at once, doing no work, for an oversized hostile body", async () => {
    const started = performance.now();
    const response = await deauthorize(post("=".repeat(100_000) + "x.y"));
    expect(response.status).toBe(400);
    expect(performance.now() - started).toBeLessThan(500);
    expect(mocks.deauthorize).not.toHaveBeenCalled();
  });

  it("answers 400 and does nothing for an unsigned or wrongly signed request", async () => {
    expect((await deauthorize(post())).status).toBe(400);
    expect((await deauthorize(post(signed("attacker")))).status).toBe(400);
    expect(mocks.deauthorize).not.toHaveBeenCalled();
  });

  it("answers 5xx when the work fails, so Meta retries", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    mocks.deauthorize.mockRejectedValue(new Error("db down"));
    expect((await deauthorize(post(signed("ig-secret")))).status).toBe(500);
    log.mockRestore();
  });
});

describe("data deletion callback", () => {
  it("logs the verified request with its erase count, never the id", async () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    mocks.erase.mockResolvedValue(3);
    await dataDeletion(post(signed("meta-secret")));
    const line = String(info.mock.calls[0]![0]);
    expect(line).toContain("3 connection(s) erased");
    expect(line).not.toContain("1784");
    info.mockRestore();
  });

  it("answers 400 at once, erasing nothing, for an oversized hostile body", async () => {
    const started = performance.now();
    const response = await dataDeletion(post("=".repeat(100_000) + "x.y"));
    expect(response.status).toBe(400);
    expect(performance.now() - started).toBeLessThan(500);
    expect(mocks.erase).not.toHaveBeenCalled();
  });

  it("erases, then answers { url, confirmation_code } whose code the status page can read", async () => {
    mocks.erase.mockResolvedValue(2);
    const response = await dataDeletion(post(signed("ig-secret")));
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(mocks.erase).toHaveBeenCalledWith("1784");
    expect(body.confirmation_code).toMatch(/^[0-9a-z]{35}$/);
    expect(body.url).toBe(`https://app.example.com/data-deletion?code=${body.confirmation_code}`);
    expect(readDeletionCode(body.confirmation_code, "auth-secret")?.removed).toBe(2);
  });

  it("still answers (with a count of 0) for a person we hold nothing for", async () => {
    mocks.erase.mockResolvedValue(0);
    const body = await (await dataDeletion(post(signed("meta-secret")))).json();
    expect(readDeletionCode(body.confirmation_code, "auth-secret")?.removed).toBe(0);
  });

  it("erases nothing for an unsigned request", async () => {
    expect((await dataDeletion(post())).status).toBe(400);
    expect(mocks.erase).not.toHaveBeenCalled();
  });

  it("answers 5xx, without a code, when erasing fails", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    mocks.erase.mockRejectedValue(new Error("db down"));
    const response = await dataDeletion(post(signed("ig-secret")));
    expect(response.status).toBe(500);
    expect((await response.json()).confirmation_code).toBeUndefined();
    log.mockRestore();
  });
});
