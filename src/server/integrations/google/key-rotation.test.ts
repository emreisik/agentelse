import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  findMany: vi.fn(),
  updateMany: vi.fn(),
  count: vi.fn(),
  claimPeriodic: vi.fn(),
  decrypt: vi.fn(),
  encrypt: vi.fn(),
  ringConfigured: vi.fn(),
  globalAllowed: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    integrationCredential: {
      findMany: h.findMany,
      updateMany: h.updateMany,
      count: h.count,
    },
  },
}));
vi.mock("@/server/observability/periodic", () => ({
  claimPeriodic: h.claimPeriodic,
}));
vi.mock("@/lib/website-analytics/flags", () => ({
  gaGlobalWorkAllowedHere: h.globalAllowed,
}));
vi.mock("./secret", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./secret")>();
  return {
    ...actual,
    googleKeyRingConfigured: h.ringConfigured,
    decryptGoogleSecret: h.decrypt,
    encryptGoogleSecret: h.encrypt,
  };
});

import { GoogleKeyRotation } from "./key-rotation";

const K = "a".repeat(64);

describe("GoogleKeyRotation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv("GOOGLE_TOKEN_KEYS", `k2:${K}`);
    h.ringConfigured.mockReturnValue(true);
    h.globalAllowed.mockReturnValue(true);
    h.claimPeriodic.mockResolvedValue(true);
    h.decrypt.mockImplementation((value: string) => `plain(${value})`);
    h.encrypt.mockImplementation((value: string) => `gk1:k2:${value}`);
    h.updateMany.mockResolvedValue({ count: 2 });
  });

  it("returns 0 without any query when no ring is configured", async () => {
    h.ringConfigured.mockReturnValue(false);
    expect(await GoogleKeyRotation.runDue()).toBe(0);
    expect(h.claimPeriodic).not.toHaveBeenCalled();
    expect(h.findMany).not.toHaveBeenCalled();
  });

  it("returns 0 without any query in a dev process sharing the live database", async () => {
    h.globalAllowed.mockReturnValue(false);
    expect(await GoogleKeyRotation.runDue()).toBe(0);
    expect(h.claimPeriodic).not.toHaveBeenCalled();
    expect(h.findMany).not.toHaveBeenCalled();
  });

  it("skips the tick when the periodic claim is not won", async () => {
    h.claimPeriodic.mockResolvedValue(false);
    expect(await GoogleKeyRotation.runDue()).toBe(0);
    expect(h.findMany).not.toHaveBeenCalled();
  });

  it("re-encrypts each distinct ciphertext once and updates by the old ciphertext", async () => {
    h.findMany.mockResolvedValue([
      { encryptedSecret: "old-a" },
      { encryptedSecret: "old-b" },
    ]);
    expect(await GoogleKeyRotation.runDue(25, new Date())).toBe(4);
    expect(h.decrypt).toHaveBeenCalledTimes(2);
    expect(h.encrypt).toHaveBeenCalledTimes(2);
    expect(h.updateMany).toHaveBeenCalledTimes(2);
    expect(h.updateMany.mock.calls[0]?.[0]).toEqual({
      where: {
        provider: { in: ["google_analytics", "google_search_console"] },
        encryptedSecret: "old-a",
      },
      data: { encryptedSecret: "gk1:k2:plain(old-a)" },
    });
    const query = h.findMany.mock.calls[0]?.[0];
    expect(query.distinct).toEqual(["encryptedSecret"]);
    expect(query.take).toBe(25);
  });

  it("counts an undecryptable group as failed and keeps going", async () => {
    h.findMany.mockResolvedValue([
      { encryptedSecret: "broken" },
      { encryptedSecret: "ok" },
    ]);
    h.decrypt.mockImplementation((value: string) => {
      if (value === "broken") throw new Error("boom");
      return value;
    });
    const result = await GoogleKeyRotation.rotateOnce(10);
    expect(result).toEqual({ groups: 1, rows: 2, failed: 1 });
    expect(h.updateMany).toHaveBeenCalledTimes(1);
  });

  it("skips past undecryptable groups so healthy rows still rotate", async () => {
    h.decrypt.mockImplementation((value: string) => {
      if (value.startsWith("broken")) throw new Error("boom");
      return value;
    });
    h.findMany
      .mockResolvedValueOnce([
        { encryptedSecret: "broken-1" },
        { encryptedSecret: "broken-2" },
      ])
      .mockResolvedValueOnce([{ encryptedSecret: "ok-1" }]);
    const result = await GoogleKeyRotation.rotateOnce(2);
    expect(result).toEqual({ groups: 1, rows: 2, failed: 2 });
    expect(JSON.stringify(h.findMany.mock.calls[1]?.[0].where)).toContain(
      '"encryptedSecret":{"gt":"broken-2"}',
    );
  });

  it("never selects empty-secret rows", async () => {
    h.findMany.mockResolvedValue([]);
    await GoogleKeyRotation.rotateOnce(5);
    expect(JSON.stringify(h.findMany.mock.calls[0]?.[0].where)).toContain(
      '"encryptedSecret":{"not":""}',
    );
  });

  it("status is null without a ring and counts by prefix with one", async () => {
    vi.stubEnv("GOOGLE_TOKEN_KEYS", "");
    expect(await GoogleKeyRotation.status()).toBeNull();
    vi.stubEnv("GOOGLE_TOKEN_KEYS", `k2:${K}`);
    h.count.mockResolvedValueOnce(10).mockResolvedValueOnce(6).mockResolvedValueOnce(8);
    expect(await GoogleKeyRotation.status()).toEqual({
      currentKeyId: "k2",
      legacyRows: 2,
      currentRows: 6,
      otherRows: 2,
      totalRows: 10,
    });
  });
});
