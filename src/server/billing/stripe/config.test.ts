import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const env = vi.hoisted(() => ({
  current: {} as Record<string, string | undefined>,
}));
vi.mock("@/lib/env", () => ({ getEnv: () => env.current }));

const {
  getStripeConfig,
  isPaymentsConfigured,
  resetStripeConfigWarnings,
  stripeModeOfKey,
} = await import("./config");

const TEST_KEY = "sk_test_abcdefgh12345678";
const LIVE_KEY = "sk_live_abcdefgh12345678";
const SECRET = "whsec_abcdefghijklmnop";

const original = process.env.NODE_ENV;
beforeEach(() => {
  resetStripeConfigWarnings();
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  env.current = {};
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  if (original !== undefined) vi.stubEnv("NODE_ENV", original);
});

describe("stripeModeOfKey", () => {
  it("reads the mode from the key and rejects anything else", () => {
    expect(stripeModeOfKey(TEST_KEY)).toBe("test");
    expect(stripeModeOfKey(LIVE_KEY)).toBe("live");
    expect(stripeModeOfKey("rk_test_abcdefgh12345678")).toBe("test");
    expect(stripeModeOfKey("pk_test_abcdefgh12345678")).toBeNull();
    expect(stripeModeOfKey("sk_test_")).toBeNull();
    expect(stripeModeOfKey("")).toBeNull();
    expect(stripeModeOfKey("sk_prod_abcdefgh12345678")).toBeNull();
  });
});

describe("getStripeConfig", () => {
  it("is closed unless BOTH the secret key and the webhook secret are set", () => {
    expect(getStripeConfig()).toBeNull();
    env.current = { STRIPE_SECRET_KEY: TEST_KEY };
    expect(getStripeConfig()).toBeNull();
    env.current = { STRIPE_WEBHOOK_SECRET: SECRET };
    expect(getStripeConfig()).toBeNull();
    expect(isPaymentsConfigured()).toBe(false);
  });

  it("opens with a test key and a webhook secret", () => {
    env.current = {
      STRIPE_SECRET_KEY: TEST_KEY,
      STRIPE_WEBHOOK_SECRET: SECRET,
    };
    expect(getStripeConfig()).toEqual({
      secretKey: TEST_KEY,
      webhookSecrets: [SECRET],
      mode: "test",
    });
    expect(isPaymentsConfigured()).toBe(true);
  });

  it("trims whitespace pasted around the values", () => {
    env.current = {
      STRIPE_SECRET_KEY: `  ${TEST_KEY}\n`,
      STRIPE_WEBHOOK_SECRET: ` ${SECRET} `,
    };
    expect(getStripeConfig()?.secretKey).toBe(TEST_KEY);
  });

  it("stays closed (and says so once) for a key that is not a Stripe secret key", () => {
    env.current = {
      STRIPE_SECRET_KEY: "pk_test_abcdefgh12345678",
      STRIPE_WEBHOOK_SECRET: SECRET,
    };
    expect(getStripeConfig()).toBeNull();
    expect(getStripeConfig()).toBeNull();
    expect(console.error).toHaveBeenCalledTimes(1);
  });

  it("stays closed for a webhook secret that is not a whsec_ value", () => {
    env.current = { STRIPE_SECRET_KEY: TEST_KEY, STRIPE_WEBHOOK_SECRET: "abc" };
    expect(getStripeConfig()).toBeNull();
  });

  it("includes the previous webhook secret while one is being rolled, ignoring a bad one", () => {
    env.current = {
      STRIPE_SECRET_KEY: TEST_KEY,
      STRIPE_WEBHOOK_SECRET: SECRET,
      STRIPE_WEBHOOK_SECRET_PREVIOUS: "whsec_old_value_here",
    };
    expect(getStripeConfig()?.webhookSecrets).toEqual([
      SECRET,
      "whsec_old_value_here",
    ]);
    env.current.STRIPE_WEBHOOK_SECRET_PREVIOUS = "garbage";
    expect(getStripeConfig()?.webhookSecrets).toEqual([SECRET]);
  });

  it("refuses a LIVE key outside production (a dev process shares the live database)", () => {
    env.current = {
      STRIPE_SECRET_KEY: LIVE_KEY,
      STRIPE_WEBHOOK_SECRET: SECRET,
    };
    vi.stubEnv("NODE_ENV", "development");
    expect(getStripeConfig()).toBeNull();
    vi.stubEnv("NODE_ENV", "production");
    expect(getStripeConfig()?.mode).toBe("live");
  });
});
