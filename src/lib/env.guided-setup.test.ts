import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The two guided-setup switches as they are parsed from the process
// environment: off unless the literal "true", so a typo (or a missing variable)
// can never turn a new behaviour on by accident.

const KEYS = [
  "GUIDED_SETUP",
  "GUIDED_SETUP_DISCOVERY",
  "GUIDED_SETUP_DISCOVERY_CAPS",
] as const;
const saved: Record<string, string | undefined> = {};

async function flagsWith(values: Partial<Record<(typeof KEYS)[number], string>>) {
  for (const key of KEYS) delete process.env[key];
  Object.assign(process.env, values);
  // getEnv() caches for the life of the process: read it fresh each time.
  vi.resetModules();
  const { getEnv } = await import("./env");
  const env = getEnv();
  return {
    GUIDED_SETUP: env.GUIDED_SETUP,
    GUIDED_SETUP_DISCOVERY: env.GUIDED_SETUP_DISCOVERY,
    GUIDED_SETUP_DISCOVERY_CAPS: env.GUIDED_SETUP_DISCOVERY_CAPS,
  };
}

beforeEach(() => {
  for (const key of [...KEYS, "DATABASE_URL", "AUTH_SECRET"]) {
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

describe("guided-setup variables in the environment", () => {
  it("are off or empty when nothing is set", async () => {
    expect(await flagsWith({})).toEqual({
      GUIDED_SETUP: false,
      GUIDED_SETUP_DISCOVERY: "false",
      GUIDED_SETUP_DISCOVERY_CAPS: "",
    });
  });

  it("turn GUIDED_SETUP on only for the literal string true", async () => {
    expect((await flagsWith({ GUIDED_SETUP: "true" })).GUIDED_SETUP).toBe(true);
  });

  it.each(["TRUE", "True", "1", "yes", "on", " true", "false", ""])(
    "read GUIDED_SETUP=%j as off: a typo never enables the feature",
    async (value) => {
      expect((await flagsWith({ GUIDED_SETUP: value })).GUIDED_SETUP).toBe(false);
    },
  );

  it("keep GUIDED_SETUP_DISCOVERY as the raw string for the scope parser", async () => {
    expect(
      (await flagsWith({ GUIDED_SETUP_DISCOVERY: "true" })).GUIDED_SETUP_DISCOVERY,
    ).toBe("true");
    expect(
      (await flagsWith({ GUIDED_SETUP_DISCOVERY: "ws_1,ws_2" }))
        .GUIDED_SETUP_DISCOVERY,
    ).toBe("ws_1,ws_2");
  });

  it("keep GUIDED_SETUP_DISCOVERY_CAPS as the raw string", async () => {
    expect(
      (await flagsWith({ GUIDED_SETUP_DISCOVERY_CAPS: "1,2,3" }))
        .GUIDED_SETUP_DISCOVERY_CAPS,
    ).toBe("1,2,3");
  });

  it("are independent variables", async () => {
    expect(await flagsWith({ GUIDED_SETUP_DISCOVERY: "true" })).toMatchObject({
      GUIDED_SETUP: false,
      GUIDED_SETUP_DISCOVERY: "true",
    });
  });
});
