import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import {
  decryptToken,
  encryptToken,
  LEGACY_KEY_ID,
  needsRotation,
  parseKeyRing,
} from "./key-ring";

const K1 = "11".repeat(32);
const K2 = "22".repeat(32);

describe("Meta token key ring (F8)", () => {
  afterEach(() => {
    delete process.env.META_TOKEN_KEYS;
  });

  it("falls back to the shared key when no ring is configured", () => {
    const sealed = encryptToken("token-a");
    expect(sealed.keyId).toBe(LEGACY_KEY_ID);
    expect(decryptToken(sealed.encryptedSecret, sealed.keyId)).toBe("token-a");
  });

  it("writes with the first key and reads with any key in the ring", () => {
    process.env.META_TOKEN_KEYS = `k1:${K1}`;
    const old = encryptToken("token-b");
    expect(old.keyId).toBe("k1");
    process.env.META_TOKEN_KEYS = `k2:${K2},k1:${K1}`;
    expect(decryptToken(old.encryptedSecret, "k1")).toBe("token-b");
    expect(needsRotation("k1")).toBe(true);
    const fresh = encryptToken("token-b");
    expect(fresh.keyId).toBe("k2");
    expect(needsRotation("k2")).toBe(false);
    expect(fresh.encryptedSecret).not.toBe(old.encryptedSecret);
  });

  it("refuses a missing key and a malformed ring", () => {
    process.env.META_TOKEN_KEYS = `k2:${K2}`;
    expect(() => decryptToken("a.b.c", "k9")).toThrow(/not configured/);
    expect(() => parseKeyRing("k1:short")).toThrow();
    expect(() => parseKeyRing(`legacy:${K1}`)).toThrow(/reserved/);
    expect(parseKeyRing("")).toBeNull();
  });

  it("detects tampering", () => {
    process.env.META_TOKEN_KEYS = `k1:${K1}`;
    const sealed = encryptToken("token-c");
    const [iv, tag, data] = sealed.encryptedSecret.split(".");
    const flipped = Buffer.from(data!, "base64");
    flipped[0] = flipped[0]! ^ 1;
    expect(() =>
      decryptToken([iv, tag, flipped.toString("base64")].join("."), "k1"),
    ).toThrow();
  });
});
