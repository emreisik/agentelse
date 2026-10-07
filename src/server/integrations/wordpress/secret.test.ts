import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { encryptToken, LEGACY_KEY_ID } from "@/server/security/key-ring";

import { openWordPressSecret, sealWordPressSecret } from "./secret";

const LEGACY = "ab".repeat(32);
const K1 = "11".repeat(32);

const INPUT = { username: "editor", appPassword: "abcdefghijklmnopqrstuvwx" };

describe("WordPress secret", () => {
  const saved = {
    legacy: process.env.TEMPORARY_SECRET_ENCRYPTION_KEY,
    ring: process.env.META_TOKEN_KEYS,
  };

  beforeEach(() => {
    process.env.TEMPORARY_SECRET_ENCRYPTION_KEY = LEGACY;
    delete process.env.META_TOKEN_KEYS;
  });

  afterEach(() => {
    if (saved.legacy === undefined) delete process.env.TEMPORARY_SECRET_ENCRYPTION_KEY;
    else process.env.TEMPORARY_SECRET_ENCRYPTION_KEY = saved.legacy;
    if (saved.ring === undefined) delete process.env.META_TOKEN_KEYS;
    else process.env.META_TOKEN_KEYS = saved.ring;
  });

  it("anahtar halkası olmadan legacy anahtarla mühürler ve açar", () => {
    const sealed = sealWordPressSecret(INPUT);
    expect(sealed.keyId).toBe(LEGACY_KEY_ID);
    expect(sealed.encryptedSecret).not.toContain(INPUT.appPassword);
    expect(openWordPressSecret(sealed.encryptedSecret, sealed.keyId)).toEqual(INPUT);
  });

  it("META_TOKEN_KEYS varken ilk anahtarla mühürler, anahtar kimliğiyle açar", () => {
    process.env.META_TOKEN_KEYS = `k1:${K1}`;
    const sealed = sealWordPressSecret(INPUT);
    expect(sealed.keyId).toBe("k1");
    expect(openWordPressSecret(sealed.encryptedSecret, "k1")).toEqual(INPUT);
  });

  it("anahtar döndürülünce eski kayıt eski kimlikle hâlâ açılır", () => {
    const legacy = sealWordPressSecret(INPUT);
    process.env.META_TOKEN_KEYS = `k1:${K1}`;
    expect(openWordPressSecret(legacy.encryptedSecret, legacy.keyId)).toEqual(INPUT);
  });

  it("bozuk içerik fırlatır ve çözülmüş metni mesaja koymaz", () => {
    const notJson = encryptToken("plain-text-with-secret-xyz");
    const caught = (() => {
      try {
        openWordPressSecret(notJson.encryptedSecret, notJson.keyId);
        return null;
      } catch (error) {
        return error as Error;
      }
    })();
    expect(caught).toBeInstanceOf(Error);
    expect(caught!.message).not.toContain("secret-xyz");

    const missingField = encryptToken(JSON.stringify({ username: "u" }));
    expect(() => openWordPressSecret(missingField.encryptedSecret, missingField.keyId)).toThrow(
      "malformed",
    );
    const wrongType = encryptToken(JSON.stringify({ username: 1, appPassword: 2 }));
    expect(() => openWordPressSecret(wrongType.encryptedSecret, wrongType.keyId)).toThrow();
  });

  it("tanımsız anahtar kimliği fırlatır", () => {
    const sealed = sealWordPressSecret(INPUT);
    expect(() => openWordPressSecret(sealed.encryptedSecret, "k9")).toThrow();
  });
});
