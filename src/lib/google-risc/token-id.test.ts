import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import { matchRiscTokenIdentifier } from "./token-id";

const TOKEN = "1//0gExampleRefreshTokenValue-abcdefghijklmnopqrstuvwxyz";

function double(token: string, chain: "raw" | "hex"): Buffer {
  const first = createHash("sha512").update(token).digest();
  return createHash("sha512")
    .update(chain === "raw" ? first : first.toString("hex"))
    .digest();
}

describe("matchRiscTokenIdentifier", () => {
  it("matches a prefix", () => {
    const value = TOKEN.slice(0, 16);
    expect(matchRiscTokenIdentifier({ type: null, alg: "prefix", value }, TOKEN)).toBe("match");
    expect(
      matchRiscTokenIdentifier({ type: null, alg: "prefix", value }, "1//0gOtherToken-abcdefghijkl"),
    ).toBe("no_match");
  });

  it("rejects a prefix that is too short", () => {
    expect(
      matchRiscTokenIdentifier({ type: null, alg: "prefix", value: TOKEN.slice(0, 4) }, TOKEN),
    ).toBe("no_match");
  });

  it.each([
    ["raw", "base64"],
    ["raw", "base64url"],
    ["hex", "base64"],
    ["hex", "base64url"],
  ] as const)("matches the double SHA-512 hash (%s chaining, %s)", (chain, encoding) => {
    const digest = double(TOKEN, chain);
    const value =
      encoding === "base64" ? digest.toString("base64") : digest.toString("base64url");
    const identifier = { type: "refresh_token", alg: "hash_base64_sha512_sha512", value };
    expect(matchRiscTokenIdentifier(identifier, TOKEN)).toBe("match");
    expect(matchRiscTokenIdentifier(identifier, `${TOKEN}x`)).toBe("no_match");
    expect(
      matchRiscTokenIdentifier({ ...identifier, value: value.replace(/=+$/, "") }, TOKEN),
    ).toBe("match");
  });

  it("reports an unknown algorithm", () => {
    expect(matchRiscTokenIdentifier({ type: null, alg: "md5", value: "x".repeat(20) }, TOKEN)).toBe(
      "unknown_alg",
    );
  });
});
