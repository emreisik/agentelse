import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const env = vi.hoisted(() => ({
  current: {} as Record<string, string | undefined>,
}));
vi.mock("@/lib/env", () => ({ getEnv: () => env.current }));
const billing = vi.hoisted(() => ({
  mode: "off" as "off" | "shadow" | "enforce",
}));
vi.mock("../config", () => ({
  getBillingConfig: () => ({
    mode: billing.mode,
    legacyBefore: null,
    legacyUntil: null,
  }),
}));

const {
  getStripeConfig,
  isPaymentsConfigured,
  resetStripeConfigWarnings,
  stripeModeOfKey,
} = await import("./config");

const TEST_KEY = "sk_test_abcdefgh12345678";
const LIVE_KEY = "sk_live_abcdefgh12345678";
const SECRET = "whsec_abcdefghijklmnopqrstuvwx";
const OLD_SECRET = "whsec_oldvalueabcdefghijklmnopqr";

const original = process.env.NODE_ENV;
beforeEach(() => {
  resetStripeConfigWarnings();
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  env.current = {};
  billing.mode = "off";
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

  it("says which variable is missing when only one of the two is set (once), and says nothing when neither is", () => {
    expect(getStripeConfig()).toBeNull();
    expect(console.error).not.toHaveBeenCalled();

    env.current = { STRIPE_SECRET_KEY: TEST_KEY };
    expect(getStripeConfig()).toBeNull();
    expect(getStripeConfig()).toBeNull();
    expect(console.error).toHaveBeenCalledTimes(1);
    expect(vi.mocked(console.error).mock.calls[0]![0]).toContain(
      "STRIPE_WEBHOOK_SECRET is not set",
    );

    env.current = { STRIPE_WEBHOOK_SECRET: SECRET };
    expect(getStripeConfig()).toBeNull();
    expect(vi.mocked(console.error).mock.calls[1]![0]).toContain(
      "STRIPE_SECRET_KEY is not set",
    );
  });

  it("warns once that a TEST key is running in production, but stays open", () => {
    env.current = {
      STRIPE_SECRET_KEY: TEST_KEY,
      STRIPE_WEBHOOK_SECRET: SECRET,
    };
    vi.stubEnv("NODE_ENV", "production");
    expect(getStripeConfig()?.mode).toBe("test");
    expect(getStripeConfig()?.mode).toBe("test");
    expect(console.error).toHaveBeenCalledTimes(1);
    expect(vi.mocked(console.error).mock.calls[0]![0]).toContain("TEST key");
    vi.stubEnv("NODE_ENV", "development");
    resetStripeConfigWarnings();
    vi.mocked(console.error).mockClear();
    expect(getStripeConfig()?.mode).toBe("test");
    expect(console.error).not.toHaveBeenCalled();
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

  it("stays closed for a placeholder or truncated signing secret (its HMAC key would be guessable)", () => {
    for (const secret of [
      "whsec_",
      "whsec_…",
      "whsec_...",
      "whsec_xxx",
      "whsec_short_value",
      "whsec_has spaces inside the value here",
    ]) {
      resetStripeConfigWarnings();
      env.current = {
        STRIPE_SECRET_KEY: TEST_KEY,
        STRIPE_WEBHOOK_SECRET: secret,
      };
      expect(getStripeConfig()).toBeNull();
    }
  });

  it("includes the previous webhook secret while one is being rolled, ignoring a bad one", () => {
    env.current = {
      STRIPE_SECRET_KEY: TEST_KEY,
      STRIPE_WEBHOOK_SECRET: SECRET,
      STRIPE_WEBHOOK_SECRET_PREVIOUS: OLD_SECRET,
    };
    expect(getStripeConfig()?.webhookSecrets).toEqual([SECRET, OLD_SECRET]);
    env.current.STRIPE_WEBHOOK_SECRET_PREVIOUS = "garbage";
    expect(getStripeConfig()?.webhookSecrets).toEqual([SECRET]);
    env.current.STRIPE_WEBHOOK_SECRET_PREVIOUS = "whsec_";
    expect(getStripeConfig()?.webhookSecrets).toEqual([SECRET]);
  });

  it("sells nothing for test cards in production while limits are enforced", () => {
    env.current = {
      STRIPE_SECRET_KEY: TEST_KEY,
      STRIPE_WEBHOOK_SECRET: SECRET,
    };
    vi.stubEnv("NODE_ENV", "production");
    billing.mode = "enforce";
    expect(getStripeConfig()).toBeNull();
    // Measuring only, or a development process: the test key is the intended setup.
    billing.mode = "shadow";
    expect(getStripeConfig()?.mode).toBe("test");
    billing.mode = "off";
    expect(getStripeConfig()?.mode).toBe("test");
    billing.mode = "enforce";
    vi.stubEnv("NODE_ENV", "development");
    expect(getStripeConfig()?.mode).toBe("test");
    // The live key is fine with enforce.
    env.current = {
      STRIPE_SECRET_KEY: LIVE_KEY,
      STRIPE_WEBHOOK_SECRET: SECRET,
    };
    vi.stubEnv("NODE_ENV", "production");
    expect(getStripeConfig()?.mode).toBe("live");
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
