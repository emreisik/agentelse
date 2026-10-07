import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  create: vi.fn(),
  findUnique: vi.fn(),
  update: vi.fn(),
  apply: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    googleRiscEvent: {
      create: h.create,
      findUnique: h.findUnique,
      update: h.update,
    },
  },
}));
vi.mock("./apply", () => ({ applyRiscEvents: h.apply }));
vi.mock("./jwks", () => ({ getGoogleRiscKey: vi.fn() }));

import { RISC_EVENT_URIS } from "@/lib/google-risc/events";

import { processRiscToken } from "./handler";
import {
  createTestRiscKey,
  signTestRiscToken,
  TEST_RISC_AUDIENCE,
} from "./test-support";

const key = createTestRiscKey("kid-h");
const NOW = new Date("2026-10-07T10:00:00Z");
const nowSec = Math.floor(NOW.getTime() / 1000);

function deps(overrides: object = {}) {
  return {
    getKey: async (kid: string) => (kid === key.kid ? key.jwk : null),
    now: () => NOW,
    audiences: () => [TEST_RISC_AUDIENCE],
    ...overrides,
  };
}

const tokenWith = (claims: object = {}) =>
  signTestRiscToken(key, { iat: nowSec, jti: "jti-1", ...claims });

const uniqueError = Object.assign(new Error("unique"), { code: "P2002" });

describe("processRiscToken", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    h.create.mockResolvedValue({});
    h.update.mockResolvedValue({});
    h.apply.mockResolvedValue({ outcome: "APPLIED", matched: 2 });
  });

  it("applies a valid token and records the outcome", async () => {
    const outcome = await processRiscToken(tokenWith(), deps());
    expect(outcome).toEqual({ status: "applied", events: 1, matched: 2 });
    expect(h.create).toHaveBeenCalledWith({
      data: { jti: "jti-1", eventKeys: ["tokens-revoked"], outcome: "PENDING" },
    });
    expect(h.update).toHaveBeenCalledWith({
      where: { jti: "jti-1" },
      data: { outcome: "APPLIED", matched: 2 },
    });
    expect(h.create.mock.invocationCallOrder[0]).toBeLessThan(
      h.apply.mock.invocationCallOrder[0] ?? 0,
    );
  });

  it("answers ignored when nothing matched", async () => {
    h.apply.mockResolvedValue({ outcome: "NO_MATCH", matched: 0 });
    expect((await processRiscToken(tokenWith(), deps())).status).toBe("ignored");
  });

  it("rejects malformed tokens, unknown kids and bad signatures", async () => {
    expect((await processRiscToken("garbage", deps())).reason).toBe("malformed");
    expect(
      (
        await processRiscToken(
          signTestRiscToken(createTestRiscKey("other"), {}),
          deps(),
        )
      ).reason,
    ).toBe("unknown_key");
    const forged = signTestRiscToken(createTestRiscKey(key.kid), {});
    const outcome = await processRiscToken(forged, deps());
    expect(outcome).toMatchObject({ status: "invalid", reason: "bad_signature" });
    expect(h.create).not.toHaveBeenCalled();
  });

  it("rejects a foreign issuer and a foreign audience", async () => {
    expect(
      (await processRiscToken(tokenWith({ iss: "https://evil.example.com/" }), deps()))
        .reason,
    ).toBe("bad_issuer");
    expect(
      (await processRiscToken(tokenWith({ aud: "someone-else" }), deps())).reason,
    ).toBe("bad_audience");
    expect(
      (await processRiscToken(tokenWith(), deps({ audiences: () => [] }))).reason,
    ).toBe("bad_audience");
  });

  it("accepts both issuer spellings", async () => {
    for (const iss of ["https://accounts.google.com/", "https://accounts.google.com", "accounts.google.com"]) {
      expect(
        (await processRiscToken(tokenWith({ iss, jti: `j-${iss}` }), deps())).status,
      ).toBe("applied");
    }
  });

  it("accepts an aud array containing a configured audience", async () => {
    expect(
      (await processRiscToken(tokenWith({ aud: ["x", TEST_RISC_AUDIENCE] }), deps())).status,
    ).toBe("applied");
  });

  it("rejects an iat more than five minutes in the future but accepts old iat and past exp", async () => {
    expect(
      (await processRiscToken(tokenWith({ iat: nowSec + 6 * 60 }), deps())).reason,
    ).toBe("iat_in_future");
    expect(
      (await processRiscToken(tokenWith({ iat: nowSec + 4 * 60 }), deps())).status,
    ).toBe("applied");
    const old = await processRiscToken(
      tokenWith({ iat: nowSec - 40 * 24 * 3600, exp: nowSec - 30 * 24 * 3600 }),
      deps(),
    );
    expect(old.status).toBe("applied");
  });

  it("rejects a token without recognised events", async () => {
    const outcome = await processRiscToken(
      tokenWith({ events: { "https://example.com/unknown": {} } }),
      deps(),
    );
    expect(outcome).toMatchObject({ status: "invalid", reason: "bad_claims" });
  });

  it("returns duplicate when the jti already finished", async () => {
    h.create.mockRejectedValue(uniqueError);
    h.findUnique.mockResolvedValue({ outcome: "APPLIED", matched: 3 });
    const outcome = await processRiscToken(tokenWith(), deps());
    expect(outcome).toEqual({ status: "duplicate", events: 1, matched: 3 });
    expect(h.apply).not.toHaveBeenCalled();
  });

  it("re-processes an existing PENDING row", async () => {
    h.create.mockRejectedValue(uniqueError);
    h.findUnique.mockResolvedValue({ outcome: "PENDING", matched: 0 });
    const outcome = await processRiscToken(tokenWith(), deps());
    expect(outcome.status).toBe("applied");
    expect(h.apply).toHaveBeenCalledTimes(1);
    expect(h.update).toHaveBeenCalledTimes(1);
  });

  it("leaves the row PENDING and rethrows when apply fails", async () => {
    h.apply.mockRejectedValue(new Error("db down"));
    await expect(processRiscToken(tokenWith(), deps())).rejects.toThrow("db down");
    expect(h.update).not.toHaveBeenCalled();
  });

  it("throws when the store fails", async () => {
    h.create.mockRejectedValue(new Error("connection reset"));
    await expect(processRiscToken(tokenWith(), deps())).rejects.toThrow("connection reset");
    expect(h.apply).not.toHaveBeenCalled();
  });

  it("passes every parsed event to apply", async () => {
    await processRiscToken(
      tokenWith({
        events: {
          [RISC_EVENT_URIS["account-disabled"]]: {
            subject: { subject_type: "iss-sub", iss: "https://accounts.google.com/", sub: "s" },
          },
          [RISC_EVENT_URIS.verification]: { state: "x" },
        },
      }),
      deps(),
    );
    const events = h.apply.mock.calls[0]?.[0] as { key: string }[];
    expect(events.map((event) => event.key)).toEqual(["account-disabled", "verification"]);
  });
});
