import { describe, expect, it } from "vitest";

import {
  DISCOVERY_CAPS,
  DiscoveryRequestSchema,
  discoveryRowId,
  emptyRecord,
  isCandidateId,
  parseDiscoveryRecord,
  viewOf,
  type DiscoveryRecord,
} from "./contract";

const STAGES = {
  site: "running",
  identity: "pending",
  research: "pending",
  profile: "pending",
} as const;

function record(over: Partial<DiscoveryRecord> = {}): DiscoveryRecord {
  return {
    ...emptyRecord({ rev: "a1b2c3d4e5f6", nowMs: 1_000, host: "x.com", stages: STAGES }),
    ...over,
  };
}

describe("row id and candidate ids", () => {
  it("builds the deterministic row id", () => {
    expect(discoveryRowId("p1")).toBe("gd_p1");
  });
  it("accepts only c_ + 10 lowercase hex", () => {
    expect(isCandidateId("c_0123456789")).toBe(true);
    expect(isCandidateId("c_012345678")).toBe(false);
    expect(isCandidateId("c_0123456789a")).toBe(false);
    expect(isCandidateId("c_012345678G")).toBe(false);
    expect(isCandidateId("C_0123456789")).toBe(false);
    expect(isCandidateId(42)).toBe(false);
  });
});

describe("parseDiscoveryRecord", () => {
  it("accepts a valid row and keeps unknown keys (loose)", () => {
    const raw = { guidedDiscovery: { ...record(), future: { a: 1 } } };
    const parsed = parseDiscoveryRecord(raw);
    expect(parsed?.rev).toBe("a1b2c3d4e5f6");
    expect((parsed as Record<string, unknown>).future).toEqual({ a: 1 });
  });
  it("reads absent and garbage as null", () => {
    expect(parseDiscoveryRecord(null)).toBeNull();
    expect(parseDiscoveryRecord({})).toBeNull();
    expect(parseDiscoveryRecord({ guidedDiscovery: "x" })).toBeNull();
  });
  it("refuses a malformed stage or status", () => {
    const badStage = record({ stages: { ...STAGES, site: "bogus" } as never });
    expect(parseDiscoveryRecord({ guidedDiscovery: badStage })).toBeNull();
    const badStatus = record({ status: "NOPE" as never });
    expect(parseDiscoveryRecord({ guidedDiscovery: badStatus })).toBeNull();
  });
  it("refuses a malformed row", () => {
    const bad = record({ rows: [{ field: "nope" }] as never });
    expect(parseDiscoveryRecord({ guidedDiscovery: bad })).toBeNull();
  });
});

describe("DiscoveryRequestSchema", () => {
  it("accepts the three actions", () => {
    expect(
      DiscoveryRequestSchema.safeParse({ action: "add", candidateId: "c_0123456789" }).success,
    ).toBe(true);
    expect(DiscoveryRequestSchema.safeParse({ action: "confirm" }).success).toBe(true);
    expect(DiscoveryRequestSchema.safeParse({ action: "retry" }).success).toBe(true);
  });
  it("refuses extra keys, bad ids and unknown actions", () => {
    expect(DiscoveryRequestSchema.safeParse({ action: "confirm", x: 1 }).success).toBe(false);
    expect(
      DiscoveryRequestSchema.safeParse({ action: "add", candidateId: "c_1", text: "t" }).success,
    ).toBe(false);
    expect(DiscoveryRequestSchema.safeParse({ action: "add", candidateId: "c_1" }).success).toBe(false);
    expect(DiscoveryRequestSchema.safeParse({ action: "add" }).success).toBe(false);
    expect(DiscoveryRequestSchema.safeParse({ action: "delete" }).success).toBe(false);
  });
});

describe("viewOf", () => {
  const fresh = 1_000 + DISCOVERY_CAPS.staleRunningMs;
  it("keeps a fresh RUNNING row running", () => {
    const v = viewOf(record(), fresh, "Acme");
    expect(v.status).toBe("RUNNING");
    expect(v.canRetry).toBe(false);
    expect(v.brandName).toBe("Acme");
  });
  it("derives FAILED/timeout for a stale RUNNING row without writing", () => {
    const r = record();
    const snapshot = JSON.stringify(r);
    const v = viewOf(r, fresh + 1, "Acme");
    expect(v.status).toBe("FAILED");
    expect(v.failure).toBe("timeout");
    expect(v.canRetry).toBe(true);
    expect(JSON.stringify(r)).toBe(snapshot);
    expect(r.status).toBe("RUNNING");
  });
  it("canRetry needs FAILED and attempts below the cap", () => {
    const failed = record({ status: "FAILED", failure: "error" });
    expect(viewOf({ ...failed, attempts: 2 }, 2_000, "A").canRetry).toBe(true);
    expect(viewOf({ ...failed, attempts: 3 }, 2_000, "A").canRetry).toBe(false);
    expect(viewOf(record({ status: "READY" }), 2_000, "A").canRetry).toBe(false);
  });
  it("a stale RUNNING row at the attempt cap cannot retry", () => {
    const v = viewOf(record({ attempts: 3 }), fresh + 1, "A");
    expect(v.status).toBe("FAILED");
    expect(v.canRetry).toBe(false);
  });
  it("does not leak unknown stored keys and copies rows", () => {
    const r = record({
      rows: [{ field: "about", tier: "accepted", score: 90, saved: ["x"], candidates: [] }],
    });
    (r as Record<string, unknown>).secret = "s";
    const v = viewOf(r, 2_000, "A");
    expect(v as Record<string, unknown>).not.toHaveProperty("secret");
    v.rows[0]!.saved.push("y");
    expect(r.rows[0]!.saved).toEqual(["x"]);
  });
});

describe("emptyRecord", () => {
  it("starts RUNNING with zero attempts", () => {
    const r = record();
    expect(r).toMatchObject({ v: 1, status: "RUNNING", attempts: 0, rows: [], confirmedAtMs: null });
    expect(r.startedAtMs).toBe(r.updatedAtMs);
  });
});
