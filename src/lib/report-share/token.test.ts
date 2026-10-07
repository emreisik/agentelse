import { describe, expect, it } from "vitest";

import {
  formatShareToken,
  generateShareSecret,
  hashShareSecret,
  parseShareToken,
  verifyShareSecret,
} from "./token";

// Gizli parça 32 bayt (43 karakter base64url); özet sha256 hex; ayrıştırma
// katı; karşılaştırma farklı uzunlukta fırlatmadan false verir.

const ID = "clxyz0123456789abcdefghij";

describe("share token", () => {
  it("generates 43-char url-safe secrets that differ each time", () => {
    const first = generateShareSecret();
    const second = generateShareSecret();
    expect(first).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(first).not.toBe(second);
  });

  it("hashes to a 64-char sha256 hex digest", () => {
    const hash = hashShareSecret("abc");
    expect(hash).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
  });

  it("round-trips format and parse", () => {
    const secret = generateShareSecret();
    const token = formatShareToken(ID, secret);
    expect(token).toBe(`${ID}.${secret}`);
    expect(parseShareToken(token)).toEqual({ id: ID, secret });
  });

  it("rejects malformed ids, secrets and extra dots", () => {
    const secret = generateShareSecret();
    expect(parseShareToken("")).toBeNull();
    expect(parseShareToken(ID)).toBeNull();
    expect(parseShareToken(`${ID}.${secret}.x`)).toBeNull();
    expect(parseShareToken(`.${secret}`)).toBeNull();
    expect(parseShareToken(`${ID}.`)).toBeNull();
    expect(parseShareToken(`short.${secret}`)).toBeNull();
    expect(parseShareToken(`${ID.toUpperCase()}.${secret}`)).toBeNull();
    expect(parseShareToken(`${ID}.${secret.slice(1)}`)).toBeNull();
    expect(parseShareToken(`${ID}.${secret}A`)).toBeNull();
    expect(parseShareToken(`${ID}.${secret.slice(0, 42)}+`)).toBeNull();
    expect(parseShareToken(`${"a".repeat(41)}.${secret}`)).toBeNull();
    expect(parseShareToken(`${ID}.${secret}\n`)).toBeNull();
    expect(parseShareToken("x".repeat(500))).toBeNull();
  });

  it("verifies the secret against the stored hash", () => {
    const secret = generateShareSecret();
    const hash = hashShareSecret(secret);
    expect(verifyShareSecret(secret, hash)).toBe(true);
    expect(verifyShareSecret(generateShareSecret(), hash)).toBe(false);
  });

  it("returns false (no throw) for hashes of a different length", () => {
    const secret = generateShareSecret();
    expect(verifyShareSecret(secret, "")).toBe(false);
    expect(verifyShareSecret(secret, "abc")).toBe(false);
    expect(verifyShareSecret(secret, "a".repeat(200))).toBe(false);
  });
});
