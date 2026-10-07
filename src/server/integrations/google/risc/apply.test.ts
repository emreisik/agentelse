import { createHash } from "node:crypto";

import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  credFindMany: vi.fn(),
  credUpdateMany: vi.fn(),
  gaFindMany: vi.fn(),
  gaUpdateMany: vi.fn(),
  gscFindMany: vi.fn(),
  gscUpdateMany: vi.fn(),
  raise: vi.fn(),
  record: vi.fn(),
  forget: vi.fn(),
  decrypt: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    integrationCredential: {
      findMany: h.credFindMany,
      updateMany: h.credUpdateMany,
    },
    gaPropertyLink: { findMany: h.gaFindMany, updateMany: h.gaUpdateMany },
    gscSiteLink: { findMany: h.gscFindMany, updateMany: h.gscUpdateMany },
  },
}));
vi.mock("@/server/monitoring/site-alerts", () => ({
  SiteAlerts: { raise: h.raise },
}));
vi.mock("@/server/repositories/audit-log.repository", () => ({
  AuditLogRepository: { record: h.record },
}));
vi.mock("@/server/integrations/google/access-token", () => ({
  forgetGoogleAccessTokens: h.forget,
}));
vi.mock("@/server/integrations/google/secret", () => ({
  decryptGoogleSecret: h.decrypt,
}));

import type { RiscEvent } from "@/lib/google-risc/events";

import { applyRiscEvents } from "./apply";

const NOW = new Date("2026-10-07T10:00:00Z");

const event = (over: Partial<RiscEvent> = {}): RiscEvent => ({
  key: "tokens-revoked",
  sub: "sub-1",
  reason: null,
  token: null,
  state: null,
  ...over,
});

const gaRow = {
  id: "cred-ga",
  workspaceId: "ws",
  projectId: "p1",
  brandId: "b1",
  provider: "google_analytics",
  metadata: { googleSub: "sub-1", ga4Properties: [] },
};
const gscRow = {
  ...gaRow,
  id: "cred-gsc",
  projectId: "p2",
  provider: "google_search_console",
};

describe("applyRiscEvents", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    h.credUpdateMany.mockResolvedValue({ count: 1 });
    h.gaUpdateMany.mockResolvedValue({ count: 1 });
    h.gscUpdateMany.mockResolvedValue({ count: 2 });
    h.gaFindMany.mockResolvedValue([
      { id: "link-1", projectId: "p1", workspaceId: "ws" },
    ]);
    h.gscFindMany.mockResolvedValue([
      { id: "l1", projectId: "p2", workspaceId: "ws" },
      { id: "l2", projectId: "p2", workspaceId: "ws" },
    ]);
    h.raise.mockResolvedValue(undefined);
    h.record.mockResolvedValue({});
  });

  it("expires only ACTIVE rows of that googleSub and forgets cached tokens", async () => {
    h.credFindMany.mockResolvedValue([gaRow]);
    const result = await applyRiscEvents([event()], NOW);
    expect(result).toEqual({ outcome: "APPLIED", matched: 1 });
    const query = h.credFindMany.mock.calls[0]?.[0];
    expect(query.where).toEqual({
      provider: { in: ["google_analytics", "google_search_console"] },
      status: "ACTIVE",
      metadata: { path: ["googleSub"], equals: "sub-1" },
    });
    const update = h.credUpdateMany.mock.calls[0]?.[0];
    expect(update.where).toEqual({ id: "cred-ga", status: "ACTIVE" });
    expect(update.data.status).toBe("EXPIRED");
    expect(update.data.metadata).toMatchObject({
      googleSub: "sub-1",
      googleHealth: {
        state: "NEEDS_RECONNECT",
        source: "risc",
        checkedAt: NOW.toISOString(),
      },
    });
    expect(h.forget).toHaveBeenCalledWith("cred-ga");
    expect(h.record).toHaveBeenCalledWith(
      expect.objectContaining({
        actorType: "SYSTEM",
        action: "google_risc.credential_expired",
        entityId: "cred-ga",
        metadata: { event: "tokens-revoked" },
      }),
    );
  });

  it("puts Analytics links on AUTH and raises GA_MH24 per link", async () => {
    h.credFindMany.mockResolvedValue([gaRow]);
    await applyRiscEvents([event()], NOW);
    expect(h.gaUpdateMany).toHaveBeenCalledWith({
      where: { credentialId: "cred-ga" },
      data: {
        health: "AUTH",
        healthReason: "Reconnect Google Analytics",
        syncLeaseUntil: null,
        syncLeaseOwner: null,
      },
    });
    expect(h.gscUpdateMany).not.toHaveBeenCalled();
    expect(h.raise).toHaveBeenCalledTimes(1);
    expect(h.raise.mock.calls[0]?.[0]).toMatchObject({
      source: "GA4",
      kind: "GA_MH24",
      severity: "CRITICAL",
      dedupeKey: "ga4:link-1:MH24",
      projectId: "p1",
    });
  });

  it("puts every Search Console link on AUTH and raises GSC_CONNECTION once per project", async () => {
    h.credFindMany.mockResolvedValue([gscRow]);
    await applyRiscEvents([event()], NOW);
    expect(h.gscUpdateMany).toHaveBeenCalledWith({
      where: { credentialId: "cred-gsc" },
      data: {
        health: "AUTH",
        healthReason: "Reconnect Search Console",
        syncLeaseUntil: null,
        syncLeaseOwner: null,
      },
    });
    expect(h.gaUpdateMany).not.toHaveBeenCalled();
    expect(h.raise).toHaveBeenCalledTimes(1);
    expect(h.raise.mock.calls[0]?.[0]).toMatchObject({
      source: "GSC",
      kind: "GSC_CONNECTION",
      severity: "CRITICAL",
      dedupeKey: "gsc:GSC_CONNECTION",
      projectId: "p2",
    });
  });

  it("writes the link health before expiring the credential", async () => {
    h.credFindMany.mockResolvedValue([gscRow]);
    await applyRiscEvents([event()], NOW);
    expect(h.gscUpdateMany.mock.invocationCallOrder[0]).toBeLessThan(
      h.credUpdateMany.mock.invocationCallOrder[0] ?? 0,
    );
  });

  it("never throws when alert raising or the audit log fails", async () => {
    h.credFindMany.mockResolvedValue([gaRow, gscRow]);
    h.raise.mockRejectedValue(new Error("alert store down"));
    h.record.mockRejectedValue(new Error("audit down"));
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    await expect(applyRiscEvents([event()], NOW)).resolves.toEqual({
      outcome: "APPLIED",
      matched: 2,
    });
    expect(JSON.stringify(error.mock.calls)).not.toContain("alert store down");
    error.mockRestore();
  });

  it("does not count a credential another delivery already expired", async () => {
    h.credFindMany.mockResolvedValue([gaRow]);
    h.credUpdateMany.mockResolvedValue({ count: 0 });
    const result = await applyRiscEvents([event()], NOW);
    expect(result).toEqual({ outcome: "NO_MATCH", matched: 0 });
    expect(h.forget).not.toHaveBeenCalled();
    expect(h.raise).not.toHaveBeenCalled();
    expect(h.record).not.toHaveBeenCalled();
  });

  it("reports NO_MATCH when no credential belongs to the sub, IGNORED without a sub", async () => {
    h.credFindMany.mockResolvedValue([]);
    expect(await applyRiscEvents([event()], NOW)).toEqual({ outcome: "NO_MATCH", matched: 0 });
    h.credFindMany.mockClear();
    expect(await applyRiscEvents([event({ sub: null })], NOW)).toEqual({
      outcome: "IGNORED",
      matched: 0,
    });
    expect(h.credFindMany).not.toHaveBeenCalled();
  });

  it("treats account-disabled and account-purged like tokens-revoked", async () => {
    h.credFindMany.mockResolvedValue([gaRow]);
    for (const key of ["account-disabled", "account-purged"] as const) {
      h.credFindMany.mockClear();
      const result = await applyRiscEvents([event({ key })], NOW);
      expect(result.outcome).toBe("APPLIED");
      expect(h.credFindMany).toHaveBeenCalledTimes(1);
    }
  });

  it("leaves NOOP events untouched", async () => {
    for (const key of ["account-enabled", "sessions-revoked", "credential-change-required", "verification"] as const) {
      expect(await applyRiscEvents([event({ key })], NOW)).toEqual({
        outcome: "IGNORED",
        matched: 0,
      });
    }
    expect(h.credFindMany).not.toHaveBeenCalled();
    expect(h.credUpdateMany).not.toHaveBeenCalled();
  });

  describe("token-revoked", () => {
    const TOKEN = "1//0gRefreshTokenValue-abcdefghijklmnop";
    const tokenEvent = (alg: string, value: string) =>
      event({
        key: "token-revoked",
        sub: null,
        token: { type: "refresh_token", alg, value },
      });

    beforeEach(() => {
      h.decrypt.mockImplementation((value: string) =>
        value === "cipher-hit" ? TOKEN : `other-${value}`,
      );
    });

    it("revokes every row sharing the matching ciphertext", async () => {
      h.credFindMany
        .mockResolvedValueOnce([
          { encryptedSecret: "cipher-miss" },
          { encryptedSecret: "cipher-hit" },
        ])
        .mockResolvedValueOnce([gaRow, gscRow]);
      const result = await applyRiscEvents(
        [tokenEvent("prefix", TOKEN.slice(0, 16))],
        NOW,
      );
      expect(result).toEqual({ outcome: "APPLIED", matched: 2 });
      expect(h.credFindMany.mock.calls[0]?.[0].take).toBe(500);
      expect(h.credFindMany.mock.calls[0]?.[0].distinct).toEqual(["encryptedSecret"]);
      expect(h.credFindMany.mock.calls[1]?.[0].where.encryptedSecret).toEqual({
        in: ["cipher-hit"],
      });
      expect(h.credUpdateMany).toHaveBeenCalledTimes(2);
    });

    it("pages through every ciphertext and finds a match past the first page", async () => {
      const full = Array.from({ length: 500 }, (_, i) => ({
        encryptedSecret: `c-${String(i).padStart(4, "0")}`,
      }));
      h.credFindMany
        .mockResolvedValueOnce(full)
        .mockResolvedValueOnce([{ encryptedSecret: "cipher-hit" }])
        .mockResolvedValueOnce([gaRow]);
      const result = await applyRiscEvents(
        [tokenEvent("prefix", TOKEN.slice(0, 16))],
        NOW,
      );
      expect(result).toEqual({ outcome: "APPLIED", matched: 1 });
      expect(h.credFindMany.mock.calls[1]?.[0].where.encryptedSecret).toEqual({
        gt: "c-0499",
      });
    });

    it("answers RECHECK, not NO_MATCH, when the scan stops before the end", async () => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
      let page = 0;
      h.credFindMany.mockImplementation(async () => {
        page += 1;
        return Array.from({ length: 500 }, (_, i) => ({
          encryptedSecret: `p${String(page).padStart(3, "0")}-${i}`,
        }));
      });
      const result = await applyRiscEvents(
        [tokenEvent("prefix", TOKEN.slice(0, 16))],
        NOW,
      );
      expect(result).toEqual({ outcome: "RECHECK", matched: 0 });
      expect(h.credUpdateMany).not.toHaveBeenCalled();
      warn.mockRestore();
    });

    it("matches the double SHA-512 identifier too", async () => {
      const first = createHash("sha512").update(TOKEN).digest();
      const value = createHash("sha512").update(first).digest("base64");
      h.credFindMany
        .mockResolvedValueOnce([{ encryptedSecret: "cipher-hit" }])
        .mockResolvedValueOnce([gaRow]);
      const result = await applyRiscEvents(
        [tokenEvent("hash_base64_sha512_sha512", value)],
        NOW,
      );
      expect(result.outcome).toBe("APPLIED");
    });

    it("reports NO_MATCH and writes nothing when no token matches", async () => {
      h.credFindMany.mockResolvedValueOnce([{ encryptedSecret: "cipher-miss" }]);
      const result = await applyRiscEvents(
        [tokenEvent("prefix", TOKEN.slice(0, 16))],
        NOW,
      );
      expect(result).toEqual({ outcome: "NO_MATCH", matched: 0 });
      expect(h.credUpdateMany).not.toHaveBeenCalled();
      expect(h.gaUpdateMany).not.toHaveBeenCalled();
    });

    it("skips undecryptable ciphertexts and keeps scanning", async () => {
      h.decrypt.mockImplementation((value: string) => {
        if (value === "broken") throw new Error("bad key");
        return TOKEN;
      });
      h.credFindMany
        .mockResolvedValueOnce([{ encryptedSecret: "broken" }, { encryptedSecret: "ok" }])
        .mockResolvedValueOnce([gaRow]);
      const result = await applyRiscEvents(
        [tokenEvent("prefix", TOKEN.slice(0, 16))],
        NOW,
      );
      expect(result.outcome).toBe("APPLIED");
    });

    it("answers RECHECK for an unknown algorithm without scanning or writing", async () => {
      const result = await applyRiscEvents([tokenEvent("md5", "x".repeat(24))], NOW);
      expect(result).toEqual({ outcome: "RECHECK", matched: 0 });
      expect(h.credFindMany).not.toHaveBeenCalled();
      expect(h.credUpdateMany).not.toHaveBeenCalled();
    });

    it("ignores a token-revoked event without an identifier", async () => {
      const result = await applyRiscEvents(
        [event({ key: "token-revoked", sub: null, token: null })],
        NOW,
      );
      expect(result.outcome).toBe("IGNORED");
    });
  });

  it("ranks APPLIED above RECHECK above NO_MATCH above IGNORED", async () => {
    h.credFindMany.mockResolvedValue([]);
    const result = await applyRiscEvents(
      [
        event({ key: "verification", sub: null }),
        event(),
        event({ key: "token-revoked", sub: null, token: { type: null, alg: "md5", value: "x".repeat(20) } }),
      ],
      NOW,
    );
    expect(result.outcome).toBe("RECHECK");
  });
});
