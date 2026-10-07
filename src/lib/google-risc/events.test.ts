import { describe, expect, it } from "vitest";

import {
  parseRiscClaims,
  RISC_ACCEPTED_ISSUERS,
  RISC_EVENT_URIS,
  riscActionFor,
  type RiscEventKey,
} from "./events";

const base = {
  iss: "https://accounts.google.com/",
  aud: "client-1",
  iat: 1_700_000_000,
  jti: "jti-1",
};

function withEvent(uri: string, body: unknown, extra: object = {}) {
  return { ...base, ...extra, events: { [uri]: body } };
}

const issSub = (sub: string, iss = "https://accounts.google.com/") => ({
  subject_type: "iss-sub",
  iss,
  sub,
});

describe("RISC event URIs and actions", () => {
  it("maps the documented URIs", () => {
    expect(RISC_EVENT_URIS["tokens-revoked"]).toBe(
      "https://schemas.openid.net/secevent/oauth/event-type/tokens-revoked",
    );
    expect(RISC_EVENT_URIS["token-revoked"]).toBe(
      "https://schemas.openid.net/secevent/oauth/event-type/token-revoked",
    );
    expect(RISC_EVENT_URIS["credential-change-required"]).toBe(
      "https://schemas.openid.net/secevent/risc/event-type/account-credential-change-required",
    );
    expect(RISC_EVENT_URIS["account-purged"]).toBe(
      "https://schemas.openid.net/secevent/risc/event-type/account-purged",
    );
  });

  it("classifies the events", () => {
    const expected: Record<RiscEventKey, string> = {
      "tokens-revoked": "REVOKE",
      "account-disabled": "REVOKE",
      "account-purged": "REVOKE",
      "token-revoked": "RECHECK",
      "account-enabled": "NOOP",
      "sessions-revoked": "NOOP",
      "credential-change-required": "NOOP",
      verification: "NOOP",
    };
    for (const [key, action] of Object.entries(expected)) {
      expect(riscActionFor(key as RiscEventKey)).toBe(action);
    }
  });

  it("accepts the issuer with and without the trailing slash", () => {
    expect(RISC_ACCEPTED_ISSUERS).toContain("https://accounts.google.com/");
    expect(RISC_ACCEPTED_ISSUERS).toContain("https://accounts.google.com");
  });
});

describe("parseRiscClaims", () => {
  it("reads an iss-sub subject", () => {
    const claims = parseRiscClaims(
      withEvent(RISC_EVENT_URIS["account-disabled"], {
        subject: issSub("sub-1"),
        reason: "hijacking",
      }),
    );
    expect(claims?.jti).toBe("jti-1");
    expect(claims?.events).toEqual([
      { key: "account-disabled", sub: "sub-1", reason: "hijacking", token: null, state: null },
    ]);
  });

  it("accepts the id_token_claims subject type and an issuer without a slash", () => {
    const claims = parseRiscClaims(
      withEvent(RISC_EVENT_URIS["tokens-revoked"], {
        subject: { subject_type: "id_token_claims", sub: "sub-2" },
      }),
    );
    expect(claims?.events[0]?.sub).toBe("sub-2");
    const noSlash = parseRiscClaims(
      withEvent(RISC_EVENT_URIS["tokens-revoked"], {
        subject: issSub("sub-3", "https://accounts.google.com"),
      }),
    );
    expect(noSlash?.events[0]?.sub).toBe("sub-3");
  });

  it("does not take a sub from a foreign issuer or an oauth_token subject", () => {
    const foreign = parseRiscClaims(
      withEvent(RISC_EVENT_URIS["tokens-revoked"], {
        subject: issSub("sub-4", "https://evil.example.com"),
      }),
    );
    expect(foreign?.events[0]?.sub).toBeNull();
    const oauth = parseRiscClaims(
      withEvent(RISC_EVENT_URIS["token-revoked"], {
        subject: { subject_type: "oauth_token", sub: "sub-5" },
      }),
    );
    expect(oauth?.events[0]?.sub).toBeNull();
  });

  it("reads the token identifier from the subject and from the event level", () => {
    const fromSubject = parseRiscClaims(
      withEvent(RISC_EVENT_URIS["token-revoked"], {
        subject: {
          subject_type: "oauth_token",
          token_type: "refresh_token",
          token_identifier_alg: "prefix",
          token: "1//0abcdefghijklmnop",
        },
      }),
    );
    expect(fromSubject?.events[0]?.token).toEqual({
      type: "refresh_token",
      alg: "prefix",
      value: "1//0abcdefghijklmnop",
    });
    const fromEvent = parseRiscClaims(
      withEvent(RISC_EVENT_URIS["token-revoked"], {
        token_identifier_alg: "hash_base64_sha512_sha512",
        token: "abc",
      }),
    );
    expect(fromEvent?.events[0]?.token).toEqual({
      type: null,
      alg: "hash_base64_sha512_sha512",
      value: "abc",
    });
  });

  it("keeps a verification state and tolerates a missing subject", () => {
    const claims = parseRiscClaims(
      withEvent(RISC_EVENT_URIS.verification, { state: "agentelse" }),
    );
    expect(claims?.events[0]).toMatchObject({ key: "verification", sub: null, state: "agentelse" });
    const bare = parseRiscClaims(withEvent(RISC_EVENT_URIS["account-enabled"], null));
    expect(bare?.events[0]).toMatchObject({ key: "account-enabled", sub: null });
  });

  it("drops unknown event URIs and returns null when nothing is left", () => {
    expect(parseRiscClaims(withEvent("https://example.com/unknown", {}))).toBeNull();
    const mixed = parseRiscClaims({
      ...base,
      events: {
        "https://example.com/unknown": {},
        [RISC_EVENT_URIS["account-enabled"]]: {},
      },
    });
    expect(mixed?.events.map((event) => event.key)).toEqual(["account-enabled"]);
  });

  it("reads aud as a string or an array and parses exp without enforcing it", () => {
    const events = { [RISC_EVENT_URIS["account-enabled"]]: {} };
    expect(parseRiscClaims({ ...base, aud: ["a", "b"], events })?.aud).toEqual(["a", "b"]);
    expect(parseRiscClaims({ ...base, aud: "a", events })?.aud).toEqual(["a"]);
    expect(parseRiscClaims({ ...base, events, exp: 5 })?.exp).toBe(5);
    expect(parseRiscClaims({ ...base, events })?.exp).toBeNull();
  });

  it("never throws on garbage", () => {
    for (const value of [null, undefined, 5, "x", [], {}, { jti: 1 }, { ...base, events: 4 }]) {
      expect(parseRiscClaims(value)).toBeNull();
    }
    expect(parseRiscClaims({ ...base, iat: "now", events: {} })).toBeNull();
  });
});
