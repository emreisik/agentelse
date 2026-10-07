import { createHmac } from "node:crypto";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/env", () => ({ getEnv: () => ({ AUTH_SECRET: "test-secret" }) }));

const { signOAuthState, verifyOAuthState } = await import("./oauth-state");

// Bu dosyanın kanıtladığı: imzalı state yükseltme alanını taşır; alansız eski
// token'lar hâlâ doğrulanır; bozulan imza, geçersiz tür ve 10 dk sonrası
// reddedilir.

function forge(payload: Record<string, unknown>, secret = "test-secret") {
  const b64 = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const sig = createHmac("sha256", secret).update(b64).digest("base64url");
  return `${b64}.${sig}`;
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-10-07T10:00:00Z"));
});
afterEach(() => {
  vi.useRealTimers();
});

describe("OAuth state", () => {
  it("round-trips the upgrade field", () => {
    const token = signOAuthState({
      projectId: "p1",
      userId: "u1",
      service: "analytics",
      codeVerifier: "v",
      upgrade: "edit",
    });
    expect(verifyOAuthState(token)).toEqual({
      projectId: "p1",
      userId: "u1",
      service: "analytics",
      codeVerifier: "v",
      login: undefined,
      upgrade: "edit",
    });
  });

  it("still verifies a token without the upgrade field", () => {
    const token = forge({
      projectId: "p1",
      userId: "u1",
      issuedAt: Date.now(),
      service: "analytics",
    });
    expect(verifyOAuthState(token)?.upgrade).toBeUndefined();
    expect(verifyOAuthState(token)?.service).toBe("analytics");
  });

  it("rejects a tampered signature", () => {
    const token = signOAuthState({
      projectId: "p1",
      userId: "u1",
      upgrade: "edit",
    });
    const [payload] = token.split(".");
    const other = Buffer.from(
      JSON.stringify({
        projectId: "p2",
        userId: "u1",
        issuedAt: Date.now(),
        upgrade: "edit",
      }),
    ).toString("base64url");
    expect(verifyOAuthState(`${other}.${token.split(".")[1]}`)).toBeNull();
    expect(verifyOAuthState(`${payload}.bad`)).toBeNull();
    expect(verifyOAuthState(forge({ projectId: "p1" }, "other-secret"))).toBeNull();
  });

  it("rejects a non-string upgrade", () => {
    const token = forge({
      projectId: "p1",
      userId: "u1",
      issuedAt: Date.now(),
      upgrade: true,
    });
    expect(verifyOAuthState(token)).toBeNull();
  });

  it("expires after ten minutes", () => {
    const token = signOAuthState({ projectId: "p1", userId: "u1" });
    vi.advanceTimersByTime(9 * 60_000);
    expect(verifyOAuthState(token)).not.toBeNull();
    vi.advanceTimersByTime(2 * 60_000);
    expect(verifyOAuthState(token)).toBeNull();
  });
});
