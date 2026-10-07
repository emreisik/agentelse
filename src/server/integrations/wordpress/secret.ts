import "server-only";

import { decryptToken, encryptToken } from "@/server/security/key-ring";

// WordPress kimliği (kullanıcı adı + Application Password) IntegrationCredential
// .encryptedSecret içinde anahtar halkasıyla mühürlenir (META_TOKEN_KEYS yoksa
// "legacy" = ortak anahtar). Anahtar kimliği metadata.keyId'de durur. Şifre
// hiçbir yerde loglanmaz, metadata'ya yazılmaz, hiçbir görünümde dönmez.

export type WordPressSecret = { username: string; appPassword: string };

export function sealWordPressSecret(input: WordPressSecret): {
  encryptedSecret: string;
  keyId: string;
} {
  return encryptToken(
    JSON.stringify({ username: input.username, appPassword: input.appPassword }),
  );
}

export function openWordPressSecret(
  encryptedSecret: string,
  keyId: string,
): WordPressSecret {
  const plain = decryptToken(encryptedSecret, keyId);
  let parsed: unknown;
  try {
    parsed = JSON.parse(plain);
  } catch {
    // Hata mesajı çözülmüş metni içermesin.
    throw new Error("The stored WordPress credential is malformed");
  }
  if (typeof parsed === "object" && parsed !== null) {
    const record = parsed as Record<string, unknown>;
    if (
      typeof record.username === "string" &&
      record.username &&
      typeof record.appPassword === "string" &&
      record.appPassword
    ) {
      return { username: record.username, appPassword: record.appPassword };
    }
  }
  throw new Error("The stored WordPress credential is malformed");
}
