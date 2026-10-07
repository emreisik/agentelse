import { randomBytes } from "node:crypto";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const crypto = vi.hoisted(() => ({
  encryptSecret: vi.fn((value: string) => `legacy(${value})`),
  decryptSecret: vi.fn((value: string) =>
    value.replace(/^legacy\((.*)\)$/, "$1"),
  ),
}));
vi.mock("../../security/crypto", () => crypto);

import {
  decryptGoogleSecret,
  encryptGoogleSecret,
  GoogleSecretKeyError,
  googleKeyRingConfigured,
  googleSecretKeyId,
  googleSecretNeedsRotation,
  googleSecretPrefixFor,
  parseGoogleKeyRing,
} from "./secret";

const K1 = randomBytes(32).toString("hex");
const K2 = randomBytes(32).toString("hex");

describe("Google secret key versioning", () => {
  beforeEach(() => {
    vi.stubEnv("GOOGLE_TOKEN_KEYS", "");
    crypto.encryptSecret.mockClear();
    crypto.decryptSecret.mockClear();
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it("without a ring the legacy format is returned unchanged", () => {
    const sealed = encryptGoogleSecret("refresh-token");
    expect(sealed).toBe("legacy(refresh-token)");
    expect(crypto.encryptSecret).toHaveBeenCalledTimes(1);
    expect(decryptGoogleSecret(sealed)).toBe("refresh-token");
    expect(googleSecretKeyId(sealed)).toBe("legacy");
    expect(googleSecretNeedsRotation(sealed)).toBe(false);
    expect(googleKeyRingConfigured()).toBe(false);
  });

  it("round-trips with a ring and writes the current key id as a prefix", () => {
    vi.stubEnv("GOOGLE_TOKEN_KEYS", `k2:${K2},k1:${K1}`);
    const sealed = encryptGoogleSecret("refresh-token");
    expect(sealed.startsWith(googleSecretPrefixFor("k2"))).toBe(true);
    expect(sealed).not.toContain("refresh-token");
    expect(crypto.encryptSecret).not.toHaveBeenCalled();
    expect(decryptGoogleSecret(sealed)).toBe("refresh-token");
    expect(googleSecretKeyId(sealed)).toBe("k2");
    expect(googleKeyRingConfigured()).toBe(true);
  });

  it("uses a fresh IV per call", () => {
    vi.stubEnv("GOOGLE_TOKEN_KEYS", `k1:${K1}`);
    expect(encryptGoogleSecret("a")).not.toBe(encryptGoogleSecret("a"));
  });

  it("still reads an old-key payload while the ring holds [k2, k1]", () => {
    vi.stubEnv("GOOGLE_TOKEN_KEYS", `k1:${K1}`);
    const old = encryptGoogleSecret("token");
    vi.stubEnv("GOOGLE_TOKEN_KEYS", `k2:${K2},k1:${K1}`);
    expect(decryptGoogleSecret(old)).toBe("token");
    expect(googleSecretNeedsRotation(old)).toBe(true);
    expect(googleSecretNeedsRotation(encryptGoogleSecret("token"))).toBe(false);
  });

  it("legacy payloads need rotation once a ring exists", () => {
    vi.stubEnv("GOOGLE_TOKEN_KEYS", `k1:${K1}`);
    expect(googleSecretNeedsRotation("legacy(x)")).toBe(true);
    expect(googleSecretNeedsRotation("")).toBe(false);
  });

  it("a payload whose key left the ring throws GoogleSecretKeyError", () => {
    vi.stubEnv("GOOGLE_TOKEN_KEYS", `k1:${K1}`);
    const old = encryptGoogleSecret("token");
    vi.stubEnv("GOOGLE_TOKEN_KEYS", `k2:${K2}`);
    expect(() => decryptGoogleSecret(old)).toThrow(GoogleSecretKeyError);
    vi.stubEnv("GOOGLE_TOKEN_KEYS", "");
    expect(() => decryptGoogleSecret(old)).toThrow(GoogleSecretKeyError);
    expect(() => decryptGoogleSecret("gk1:broken")).toThrow(
      GoogleSecretKeyError,
    );
  });

  it("a tampered ciphertext does not decrypt", () => {
    vi.stubEnv("GOOGLE_TOKEN_KEYS", `k1:${K1}`);
    const sealed = encryptGoogleSecret("token");
    const prefix = googleSecretPrefixFor("k1");
    const [iv, tag] = sealed.slice(prefix.length).split(".");
    const forged = `${prefix}${iv}.${tag}.${Buffer.from("tampered").toString("base64")}`;
    expect(() => decryptGoogleSecret(forged)).toThrow();
  });

  it("the reserved 'legacy' id and malformed rings are rejected by the parser", () => {
    expect(() => parseGoogleKeyRing(`legacy:${K1}`)).toThrow();
    expect(() => parseGoogleKeyRing("k1:abc")).toThrow();
    expect(() => parseGoogleKeyRing(`k1:${K1},k1:${K2}`)).toThrow();
    expect(() => parseGoogleKeyRing(`bad id:${K1}`)).toThrow();
    expect(parseGoogleKeyRing("  ")).toBeNull();
    expect(parseGoogleKeyRing(undefined)).toBeNull();
    const ring = parseGoogleKeyRing(`k2:${K2},k1:${K1}`);
    expect(ring?.current).toBe("k2");
    expect([...(ring?.keys.keys() ?? [])]).toEqual(["k2", "k1"]);
  });

  it("a malformed ring on encrypt falls back to the legacy format and never logs the key", () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.stubEnv("GOOGLE_TOKEN_KEYS", "k1:not-hex");
    expect(encryptGoogleSecret("token")).toBe("legacy(token)");
    expect(encryptGoogleSecret("token")).toBe("legacy(token)");
    expect(googleKeyRingConfigured()).toBe(false);
    expect(googleSecretNeedsRotation("legacy(x)")).toBe(false);
    expect(error.mock.calls.length).toBeLessThanOrEqual(1);
    for (const call of error.mock.calls) {
      expect(JSON.stringify(call)).not.toContain("not-hex");
    }
  });
});
