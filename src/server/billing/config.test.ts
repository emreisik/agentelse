import { beforeEach, describe, expect, it, vi } from "vitest";

const getEnv = vi.fn();
vi.mock("@/lib/env", () => ({ getEnv }));

const { getBillingConfig, resetBillingConfigWarning } = await import("./config");

const env = (overrides: Record<string, unknown> = {}) => ({
  BILLING_MODE: "enforce",
  BILLING_LEGACY_BEFORE: "",
  BILLING_LEGACY_UNTIL: "",
  ...overrides,
});

beforeEach(() => {
  vi.clearAllMocks();
  resetBillingConfigWarning();
});

describe("getBillingConfig", () => {
  it("ISO tarihlerini okur (yalnız gün ve tam zaman damgası)", () => {
    getEnv.mockReturnValue(
      env({
        BILLING_LEGACY_BEFORE: "2026-11-15",
        BILLING_LEGACY_UNTIL: "2026-11-22T10:30:00+03:00",
      }),
    );
    const config = getBillingConfig();
    expect(config.mode).toBe("enforce");
    expect(config.legacyBefore).toEqual(new Date("2026-11-15T00:00:00.000Z"));
    expect(config.legacyUntil).toEqual(new Date("2026-11-22T07:30:00.000Z"));
  });

  it("boş ayar null; kısmi env taklidinde mod 'off'", () => {
    getEnv.mockReturnValue({});
    expect(getBillingConfig()).toEqual({
      mode: "off",
      legacyBefore: null,
      legacyUntil: null,
    });
  });

  it("yerel biçimli tarih (15.11.2026) enforce'u SHADOW'a düşürür: yazım hatası kimseyi engelleyemez", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    getEnv.mockReturnValue(env({ BILLING_LEGACY_BEFORE: "15.11.2026" }));
    const config = getBillingConfig();
    expect(config.mode).toBe("shadow");
    expect(config.legacyBefore).toBeNull();
    expect(spy).toHaveBeenCalledTimes(1);
    // Uyarı süreç başına bir kez.
    getBillingConfig();
    expect(spy).toHaveBeenCalledTimes(1);
    spy.mockRestore();
  });

  it("geçersiz LEGACY_UNTIL de enforce'u düşürür; shadow/off'ta mod değişmez", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    getEnv.mockReturnValue(env({ BILLING_LEGACY_UNTIL: "yarın" }));
    expect(getBillingConfig().mode).toBe("shadow");
    getEnv.mockReturnValue(env({ BILLING_MODE: "off", BILLING_LEGACY_UNTIL: "yarın" }));
    expect(getBillingConfig().mode).toBe("off");
    getEnv.mockReturnValue(env({ BILLING_MODE: "shadow", BILLING_LEGACY_UNTIL: "yarın" }));
    expect(getBillingConfig().mode).toBe("shadow");
    spy.mockRestore();
  });

  it("ISO görünümlü ama takvimde olmayan gün geçersiz sayılır", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    getEnv.mockReturnValue(env({ BILLING_LEGACY_BEFORE: "2026-13-45" }));
    expect(getBillingConfig().mode).toBe("shadow");
    spy.mockRestore();
  });
});
