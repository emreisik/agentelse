import { describe, expect, it } from "vitest";

import {
  createTestRiscKey,
  signTestRiscToken,
} from "@/server/integrations/google/risc/test-support";

import { decodeJwt, verifyRs256 } from "./jwt";

const key = createTestRiscKey("kid-a");

function parts(token: string) {
  const decoded = decodeJwt(token);
  if (!decoded) throw new Error("token should decode");
  return decoded;
}

describe("decodeJwt", () => {
  it("rejects malformed tokens", () => {
    expect(decodeJwt("")).toBeNull();
    expect(decodeJwt("a.b")).toBeNull();
    expect(decodeJwt("a.b.c.d")).toBeNull();
    expect(decodeJwt("not base64!.x.y")).toBeNull();
    expect(decodeJwt(`${Buffer.from("[]").toString("base64url")}.e30.c2ln`)).toBeNull();
    expect(decodeJwt(`${"a".repeat(20_000)}.b.c`)).toBeNull();
  });

  it("decodes header, payload and signing input", () => {
    const decoded = parts(signTestRiscToken(key, { jti: "j1" }));
    expect(decoded.header.kid).toBe("kid-a");
    expect((decoded.payload as { jti: string }).jti).toBe("j1");
    expect(decoded.signingInput.split(".")).toHaveLength(2);
  });
});

describe("verifyRs256", () => {
  it("accepts a valid RS256 token", () => {
    expect(verifyRs256(parts(signTestRiscToken(key)), key.jwk)).toBe(true);
  });

  it("rejects alg none and HS256", () => {
    expect(verifyRs256(parts(signTestRiscToken(key, {}, { alg: "none" })), key.jwk)).toBe(false);
    expect(verifyRs256(parts(signTestRiscToken(key, {}, { alg: "HS256" })), key.jwk)).toBe(false);
  });

  it("rejects a tampered payload", () => {
    const token = signTestRiscToken(key);
    const [header, , signature] = token.split(".");
    const forged = `${header}.${Buffer.from(JSON.stringify({ jti: "evil" })).toString("base64url")}.${signature}`;
    expect(verifyRs256(parts(forged), key.jwk)).toBe(false);
  });

  it("rejects a token signed by another key and a kid mismatch", () => {
    const other = createTestRiscKey("kid-a");
    expect(verifyRs256(parts(signTestRiscToken(other)), key.jwk)).toBe(false);
    expect(verifyRs256(parts(signTestRiscToken(key)), { ...key.jwk, kid: "kid-b" })).toBe(false);
  });

  it("rejects a 1024-bit key even with a valid signature", () => {
    const weak = createTestRiscKey("kid-w", 1024);
    expect(verifyRs256(parts(signTestRiscToken(weak)), weak.jwk)).toBe(false);
  });
});
