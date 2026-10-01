import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";

import {
  createDeletionCode,
  parseSignedRequest,
  readDeletionCode,
} from "@/lib/meta-signed-request";

// What this suite proves: only a request Meta really signed (with the Instagram
// or the Meta app secret) is trusted, and the deletion confirmation code can be
// read back by the status page but not forged.

const b64 = (value: unknown) =>
  Buffer.from(typeof value === "string" ? value : JSON.stringify(value)).toString("base64url");

function sign(payload: unknown, secret: string, algorithmOverride?: string) {
  const body = b64(payload);
  const signature = createHmac("sha256", secret).update(body).digest("base64url");
  return `${algorithmOverride ?? signature}.${body}`;
}

const payload = { algorithm: "HMAC-SHA256", user_id: "1784", issued_at: 1790000000 };

describe("parseSignedRequest", () => {
  it("accepts a request signed with the Instagram app secret", () => {
    expect(parseSignedRequest(sign(payload, "ig-secret"), ["ig-secret", "meta-secret"])).toEqual({
      userId: "1784",
    });
  });

  it("accepts one signed with the Meta app secret (the Facebook route)", () => {
    expect(parseSignedRequest(sign(payload, "meta-secret"), ["ig-secret", "meta-secret"])).toEqual({
      userId: "1784",
    });
  });

  it("reads a numeric user_id as text", () => {
    expect(
      parseSignedRequest(sign({ ...payload, user_id: 99 }, "s"), ["s"]),
    ).toEqual({ userId: "99" });
  });

  it("rejects a signature made with another secret, or with no secret configured", () => {
    expect(parseSignedRequest(sign(payload, "attacker"), ["ig-secret"])).toBeNull();
    expect(parseSignedRequest(sign(payload, "ig-secret"), [])).toBeNull();
    expect(parseSignedRequest(sign(payload, "ig-secret"), [""])).toBeNull();
  });

  it("rejects a payload changed after signing", () => {
    const [signature] = sign(payload, "s").split(".");
    const tampered = `${signature}.${b64({ ...payload, user_id: "someone-else" })}`;
    expect(parseSignedRequest(tampered, ["s"])).toBeNull();
  });

  it("rejects malformed input and the wrong algorithm", () => {
    for (const bad of ["", "nodot", "a.b.c", ".payload", "sig."]) {
      expect(parseSignedRequest(bad, ["s"])).toBeNull();
    }
    expect(parseSignedRequest(sign({ ...payload, algorithm: "HMAC-SHA1" }, "s"), ["s"])).toBeNull();
    expect(parseSignedRequest(sign({ algorithm: "HMAC-SHA256" }, "s"), ["s"])).toBeNull();
    expect(parseSignedRequest(sign("not json", "s"), ["s"])).toBeNull();
  });
});

describe("deletion confirmation code", () => {
  const now = Date.UTC(2026, 9, 1, 12, 0, 0);

  it("is 35 lowercase alphanumerics and reads back the time and count", () => {
    const code = createDeletionCode(3, "secret", now);
    expect(code).toMatch(/^[0-9a-z]{35}$/);
    expect(readDeletionCode(code, "secret")).toEqual({
      requestedAt: new Date(now),
      removed: 3,
    });
  });

  it("round-trips zero connections", () => {
    expect(readDeletionCode(createDeletionCode(0, "secret", now), "secret")?.removed).toBe(0);
  });

  it("cannot be forged or edited", () => {
    const code = createDeletionCode(2, "secret", now);
    expect(readDeletionCode(code, "another-secret")).toBeNull();
    // Edit the count: signature no longer matches.
    expect(readDeletionCode(code.slice(0, 9) + "zz" + code.slice(11), "secret")).toBeNull();
    for (const bad of ["", "short", "A".repeat(35), "../etc/passwd", code + "0"]) {
      expect(readDeletionCode(bad, "secret")).toBeNull();
    }
  });
});
