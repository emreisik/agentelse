import { describe, expect, it } from "vitest";

import {
  shouldRevokeAtGoogle,
  type GoogleConnectionRef,
} from "./revoke-policy";

// Bu dosyanın kanıtladığı: Google'da iptal, aynı Google hesabını kullanan
// başka canlı bağlantı varken asla yapılmaz (Google iptali Cloud projesi
// düzeyinde uyguladığı için diğerini de koparırdı); şüphede iptal edilmez.

const target: GoogleConnectionRef = {
  id: "cred-ga",
  encryptedSecret: "enc-1",
  googleSub: "sub-1",
  email: "owner@example.com",
};

describe("shouldRevokeAtGoogle", () => {
  it("revokes when no other connection uses the account", () => {
    expect(shouldRevokeAtGoogle(target, [])).toBe(true);
    expect(
      shouldRevokeAtGoogle(target, [
        {
          id: "other",
          encryptedSecret: "enc-2",
          googleSub: "sub-2",
          email: "x@example.com",
        },
      ]),
    ).toBe(true);
  });

  it("keeps Google access while the same account runs Search Console", () => {
    expect(
      shouldRevokeAtGoogle(target, [
        {
          id: "cred-gsc",
          encryptedSecret: "enc-2",
          googleSub: "sub-1",
          email: "owner@example.com",
        },
      ]),
    ).toBe(false);
  });

  it("keeps it for a legacy pair that shares one token", () => {
    expect(
      shouldRevokeAtGoogle(target, [
        {
          id: "cred_gsc",
          encryptedSecret: "enc-1",
          googleSub: null,
          email: null,
        },
      ]),
    ).toBe(false);
  });

  it("falls back to the email for rows without an account id", () => {
    expect(
      shouldRevokeAtGoogle(target, [
        {
          id: "old",
          encryptedSecret: "enc-3",
          googleSub: null,
          email: "Owner@Example.com",
        },
      ]),
    ).toBe(false);
  });

  it("does not touch Google when the account is unknown or the token is gone", () => {
    expect(
      shouldRevokeAtGoogle({ ...target, googleSub: null, email: null }, []),
    ).toBe(false);
    expect(shouldRevokeAtGoogle({ ...target, encryptedSecret: "" }, [])).toBe(
      false,
    );
  });

  it("ignores the target itself in the list", () => {
    expect(shouldRevokeAtGoogle(target, [target])).toBe(true);
  });
});
