import { describe, expect, it } from "vitest";

import {
  STRIPE_SIGNATURE_TOLERANCE_SEC,
  signStripePayload,
  verifyStripeSignature,
} from "./signature";

const SECRET = "whsec_test_secret_value";
const OTHER = "whsec_rolled_previous_secret";
const BODY = JSON.stringify({ id: "evt_123456", type: "invoice.paid" });
const NOW = new Date("2026-10-09T12:00:00.000Z");
const T = Math.floor(NOW.getTime() / 1000);

describe("verifyStripeSignature", () => {
  it("accepts a correctly signed body", () => {
    const header = signStripePayload(BODY, SECRET, T);
    expect(
      verifyStripeSignature({
        rawBody: BODY,
        header,
        secrets: [SECRET],
        now: NOW,
      }),
    ).toEqual({ ok: true, timestamp: T });
  });

  it("accepts the body as raw bytes too", () => {
    const header = signStripePayload(BODY, SECRET, T);
    expect(
      verifyStripeSignature({
        rawBody: Buffer.from(BODY, "utf8"),
        header,
        secrets: [SECRET],
        now: NOW,
      }).ok,
    ).toBe(true);
  });

  it("rejects a missing header", () => {
    expect(
      verifyStripeSignature({
        rawBody: BODY,
        header: null,
        secrets: [SECRET],
        now: NOW,
      }),
    ).toEqual({ ok: false, reason: "missing-header" });
  });

  it.each([
    "",
    "garbage",
    "t=abc,v1=" + "a".repeat(64),
    `t=${T}`,
    `t=${T},v1=not-hex`,
    `t=${T},v1=${"a".repeat(63)}`,
    `v1=${"a".repeat(64)}`,
  ])("rejects a malformed header %j", (header) => {
    const result = verifyStripeSignature({
      rawBody: BODY,
      header,
      secrets: [SECRET],
      now: NOW,
    });
    expect(result.ok).toBe(false);
  });

  it("rejects a body that was changed after signing", () => {
    const header = signStripePayload(BODY, SECRET, T);
    expect(
      verifyStripeSignature({
        rawBody: BODY.replace("paid", "void"),
        header,
        secrets: [SECRET],
        now: NOW,
      }),
    ).toEqual({ ok: false, reason: "mismatch" });
  });

  it("rejects a body that was re-serialised (the bytes must be exact)", () => {
    const header = signStripePayload(BODY, SECRET, T);
    const reserialised = JSON.stringify(JSON.parse(BODY), null, 2);
    expect(
      verifyStripeSignature({
        rawBody: reserialised,
        header,
        secrets: [SECRET],
        now: NOW,
      }).ok,
    ).toBe(false);
  });

  it("rejects a different secret", () => {
    const header = signStripePayload(BODY, OTHER, T);
    expect(
      verifyStripeSignature({
        rawBody: BODY,
        header,
        secrets: [SECRET],
        now: NOW,
      }),
    ).toEqual({ ok: false, reason: "mismatch" });
  });

  it("rejects when there is no usable secret", () => {
    const header = signStripePayload(BODY, SECRET, T);
    expect(
      verifyStripeSignature({ rawBody: BODY, header, secrets: [], now: NOW }),
    ).toEqual({ ok: false, reason: "no-secret" });
    expect(
      verifyStripeSignature({ rawBody: BODY, header, secrets: [""], now: NOW }),
    ).toEqual({ ok: false, reason: "no-secret" });
  });

  it("accepts the previous secret while a secret is being rolled", () => {
    const header = signStripePayload(BODY, OTHER, T);
    expect(
      verifyStripeSignature({
        rawBody: BODY,
        header,
        secrets: [SECRET, OTHER],
        now: NOW,
      }).ok,
    ).toBe(true);
  });

  it("accepts when ANY of several v1 signatures matches", () => {
    const good = signStripePayload(BODY, SECRET, T).split(",v1=")[1]!;
    const header = `t=${T},v1=${"0".repeat(64)},v1=${good},v0=${"1".repeat(64)}`;
    expect(
      verifyStripeSignature({
        rawBody: BODY,
        header,
        secrets: [SECRET],
        now: NOW,
      }).ok,
    ).toBe(true);
  });

  it("does not accept the legacy v0 scheme alone", () => {
    const good = signStripePayload(BODY, SECRET, T).split(",v1=")[1]!;
    expect(
      verifyStripeSignature({
        rawBody: BODY,
        header: `t=${T},v0=${good}`,
        secrets: [SECRET],
        now: NOW,
      }).ok,
    ).toBe(false);
  });

  it("enforces the timestamp tolerance in both directions, and only after the signature matched", () => {
    const stale = T - STRIPE_SIGNATURE_TOLERANCE_SEC - 1;
    const future = T + STRIPE_SIGNATURE_TOLERANCE_SEC + 1;
    expect(
      verifyStripeSignature({
        rawBody: BODY,
        header: signStripePayload(BODY, SECRET, stale),
        secrets: [SECRET],
        now: NOW,
      }),
    ).toEqual({ ok: false, reason: "timestamp-out-of-tolerance" });
    expect(
      verifyStripeSignature({
        rawBody: BODY,
        header: signStripePayload(BODY, SECRET, future),
        secrets: [SECRET],
        now: NOW,
      }),
    ).toEqual({ ok: false, reason: "timestamp-out-of-tolerance" });
    // Exactly at the edge is fine.
    expect(
      verifyStripeSignature({
        rawBody: BODY,
        header: signStripePayload(
          BODY,
          SECRET,
          T - STRIPE_SIGNATURE_TOLERANCE_SEC,
        ),
        secrets: [SECRET],
        now: NOW,
      }).ok,
    ).toBe(true);
    // A bad signature on a stale timestamp reports the mismatch, not the clock.
    expect(
      verifyStripeSignature({
        rawBody: BODY,
        header: `t=${stale},v1=${"0".repeat(64)}`,
        secrets: [SECRET],
        now: NOW,
      }),
    ).toEqual({ ok: false, reason: "mismatch" });
  });

  it("a signature for one timestamp cannot be replayed under another", () => {
    const sig = signStripePayload(BODY, SECRET, T).split(",v1=")[1]!;
    expect(
      verifyStripeSignature({
        rawBody: BODY,
        header: `t=${T + 5},v1=${sig}`,
        secrets: [SECRET],
        now: NOW,
      }).ok,
    ).toBe(false);
  });
});
