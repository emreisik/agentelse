import "server-only";

import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

// AES-256-GCM for at-rest encryption of TemporarySecret values (OTP/MFA
// codes). The key never lives in the database — only in
// TEMPORARY_SECRET_ENCRYPTION_KEY (32-byte hex).
function getKey(): Buffer {
  const hex = process.env.TEMPORARY_SECRET_ENCRYPTION_KEY;
  if (!hex || hex.length !== 64) {
    throw new Error(
      "TEMPORARY_SECRET_ENCRYPTION_KEY must be a 32-byte hex string (64 chars)",
    );
  }
  return Buffer.from(hex, "hex");
}

export function encryptSecret(plaintext: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", getKey(), iv);
  const encrypted = Buffer.concat([
    cipher.update(plaintext, "utf8"),
    cipher.final(),
  ]);
  const authTag = cipher.getAuthTag();
  return [
    iv.toString("base64"),
    authTag.toString("base64"),
    encrypted.toString("base64"),
  ].join(".");
}

export function decryptSecret(payload: string): string {
  const [ivB64, authTagB64, dataB64] = payload.split(".");
  if (!ivB64 || !authTagB64 || !dataB64)
    throw new Error("Malformed encrypted secret payload");

  const decipher = createDecipheriv(
    "aes-256-gcm",
    getKey(),
    Buffer.from(ivB64, "base64"),
  );
  decipher.setAuthTag(Buffer.from(authTagB64, "base64"));
  const decrypted = Buffer.concat([
    decipher.update(Buffer.from(dataB64, "base64")),
    decipher.final(),
  ]);
  return decrypted.toString("utf8");
}
