import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";

import {
  MAX_SIGNED_REQUEST_LENGTH,
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

// The text of a payload as Meta would send it, signed with `secret`.
function signText(payloadJson: string, secret: string) {
  const body = Buffer.from(payloadJson).toString("base64url");
  return `${createHmac("sha256", secret).update(body).digest("base64url")}.${body}`;
}

describe("parseSignedRequest: hostile input from an unauthenticated caller", () => {
  // The first version stripped padding with /=+$/, which backtracks quadratically:
  // 100,000 "=" followed by anything stalled the whole server for about 5 seconds.
  it("answers null at once for the long '=' run that used to stall the server", () => {
    for (const hostile of [
      "=".repeat(100_000) + "x.y",
      "=".repeat(MAX_SIGNED_REQUEST_LENGTH - 10) + "x.y",
      "=".repeat(4000) + "x" + "=".repeat(4000) + ".y",
    ]) {
      const started = performance.now();
      expect(parseSignedRequest(hostile, ["ig-secret", "meta-secret"])).toBeNull();
      expect(performance.now() - started).toBeLessThan(100);
    }
  });

  it("refuses anything longer than a real signed_request, even correctly signed", () => {
    const padding = "a".repeat(MAX_SIGNED_REQUEST_LENGTH);
    expect(
      parseSignedRequest(signText(JSON.stringify({ ...payload, pad: padding }), "s"), ["s"]),
    ).toBeNull();
  });

  it("refuses a signature part longer than any SHA-256 signature", () => {
    expect(parseSignedRequest(`${"A".repeat(200)}.${b64(payload)}`, ["s"])).toBeNull();
  });

  it("tolerates a padded signature but never needs the padding", () => {
    const [signature, body] = sign(payload, "s").split(".");
    expect(parseSignedRequest(`${signature}==.${body}`, ["s"])).toEqual({ userId: "1784" });
    expect(parseSignedRequest(`${signature}.${body}`, ["s"])).toEqual({ userId: "1784" });
  });

  it("refuses a correctly signed payload that is not an object instead of throwing", () => {
    for (const text of ["null", "5", '"text"', "[]", '[{"algorithm":"HMAC-SHA256","user_id":"1"}]', "true"]) {
      expect(() => parseSignedRequest(signText(text, "s"), ["s"])).not.toThrow();
      expect(parseSignedRequest(signText(text, "s"), ["s"])).toBeNull();
    }
  });
});

describe("parseSignedRequest: ids larger than 2^53", () => {
  // Instagram ids are 17 digits. JSON.parse rounds a 17-digit number, so a numeric
  // user_id must be read as the digits Meta sent or no connection would ever match.
  it("keeps a 17-digit numeric user_id exactly as sent", () => {
    // An odd 17-digit id: above 2^53 doubles are spaced 2 apart, so JSON.parse turns
    // it into its even neighbour (an even id happens to survive, which hides the bug).
    const raw = '{"algorithm":"HMAC-SHA256","issued_at":1790000000,"user_id":17841410649718709}';
    expect(String(JSON.parse(raw).user_id)).toBe("17841410649718708");
    expect(parseSignedRequest(signText(raw, "s"), ["s"])).toEqual({ userId: "17841410649718709" });
  });

  it("reads the id wherever it sits in the payload, and leaves strings and small numbers alone", () => {
    expect(
      parseSignedRequest(
        signText('{"user_id":17841410649718709,"algorithm":"HMAC-SHA256"}', "s"),
        ["s"],
      ),
    ).toEqual({ userId: "17841410649718709" });
    expect(
      parseSignedRequest(signText('{"algorithm":"HMAC-SHA256","user_id":"17841410649718708"}', "s"), ["s"]),
    ).toEqual({ userId: "17841410649718708" });
    expect(
      parseSignedRequest(signText('{"algorithm":"HMAC-SHA256","user_id":42}', "s"), ["s"]),
    ).toEqual({ userId: "42" });
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
