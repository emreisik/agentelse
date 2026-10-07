import { describe, expect, it } from "vitest";

import { buildGaEditGrant, parseGaEditGrant } from "./edit-grant";

// Bu dosyanın kanıtladığı: düzenleme izni kaydı gidiş-dönüşte aynı kalır,
// bozuk metadata izin sayılmaz.

describe("GA edit grant record", () => {
  it("round-trips through metadata", () => {
    const grant = buildGaEditGrant("user-1", new Date("2026-10-07T10:00:00Z"));
    expect(grant).toEqual({
      grantedAt: "2026-10-07T10:00:00.000Z",
      grantedByUserId: "user-1",
    });
    expect(parseGaEditGrant({ gaEdit: grant, other: 1 })).toEqual(grant);
  });

  it("keeps a missing user as null", () => {
    const grant = buildGaEditGrant(null);
    expect(grant.grantedByUserId).toBeNull();
    expect(parseGaEditGrant({ gaEdit: grant })?.grantedByUserId).toBeNull();
  });

  it("gives null for garbage", () => {
    expect(parseGaEditGrant(null)).toBeNull();
    expect(parseGaEditGrant(undefined)).toBeNull();
    expect(parseGaEditGrant("x")).toBeNull();
    expect(parseGaEditGrant({})).toBeNull();
    expect(parseGaEditGrant({ gaEdit: null })).toBeNull();
    expect(parseGaEditGrant({ gaEdit: "yes" })).toBeNull();
    expect(parseGaEditGrant({ gaEdit: {} })).toBeNull();
    expect(parseGaEditGrant({ gaEdit: { grantedAt: 5 } })).toBeNull();
    expect(parseGaEditGrant({ gaEdit: { grantedAt: "not a date" } })).toBeNull();
  });

  it("ignores a non-string granting user", () => {
    expect(
      parseGaEditGrant({
        gaEdit: { grantedAt: "2026-10-07T10:00:00.000Z", grantedByUserId: 7 },
      }),
    ).toEqual({
      grantedAt: "2026-10-07T10:00:00.000Z",
      grantedByUserId: null,
    });
  });
});
