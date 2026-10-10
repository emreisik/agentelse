import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// TRIAL_MAX_PER_DAY: the daily cap on signup trials. A blank or broken value must fall
// back to the safe default (never "unlimited"); 0 is the explicit "no signup trials" switch.

const saved: Record<string, string | undefined> = {};

async function capWith(value: string | undefined) {
  if (value === undefined) delete process.env.TRIAL_MAX_PER_DAY;
  else process.env.TRIAL_MAX_PER_DAY = value;
  // getEnv() caches for the life of the process: read it fresh each time.
  vi.resetModules();
  const { getEnv } = await import("./env");
  return getEnv().TRIAL_MAX_PER_DAY;
}

beforeEach(() => {
  for (const key of ["TRIAL_MAX_PER_DAY", "DATABASE_URL", "AUTH_SECRET"]) {
    saved[key] = process.env[key];
  }
  process.env.DATABASE_URL ??= "postgresql://user:pass@localhost:5432/db";
  process.env.AUTH_SECRET ??= "test-secret-test-secret-test-secret-1234";
});

afterEach(() => {
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  vi.resetModules();
});

describe("TRIAL_MAX_PER_DAY", () => {
  it("is 100 when unset, blank or not a non-negative whole number", async () => {
    for (const value of [undefined, "", "   ", "abc", "-3", "NaN", "1e3x"]) {
      expect(await capWith(value)).toBe(100);
    }
  });

  it("reads a number, and 0 means no signup trials at all", async () => {
    expect(await capWith("25")).toBe(25);
    expect(await capWith(" 7 ")).toBe(7);
    expect(await capWith("0")).toBe(0);
  });
});
