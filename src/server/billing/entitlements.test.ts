import { beforeEach, describe, expect, it, vi } from "vitest";

const config = vi.hoisted(() => ({
  current: { mode: "enforce", legacyBefore: null, legacyUntil: null } as {
    mode: "off" | "shadow" | "enforce";
    legacyBefore: Date | null;
    legacyUntil: Date | null;
  },
}));
vi.mock("./config", () => ({ getBillingConfig: () => config.current }));

const findSubscription = vi.fn();
const findWorkspace = vi.fn();
vi.mock("@/lib/prisma", () => ({
  prisma: {
    subscription: { findUnique: findSubscription },
    workspace: { findUnique: findWorkspace },
  },
}));

const { getEntitlements } = await import("./entitlements");

beforeEach(() => {
  vi.clearAllMocks();
  config.current = { mode: "enforce", legacyBefore: null, legacyUntil: null };
});

describe("getEntitlements", () => {
  it("off: veritabanına HİÇ dokunmaz, tam erişim", async () => {
    config.current = { ...config.current, mode: "off" };
    const result = await getEntitlements("ws-1");
    expect(result).toMatchObject({ access: "FULL", reason: "OFF", unlimited: true });
    expect(findSubscription).not.toHaveBeenCalled();
    expect(findWorkspace).not.toHaveBeenCalled();
  });

  it("okuma hatası: enforce'ta KAPALI (fail-closed), shadow'da AÇIK (fail-open); asla fırlatmaz", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    findSubscription.mockRejectedValue(new Error("db down"));

    expect(await getEntitlements("ws-1")).toMatchObject({
      access: "READ_ONLY",
      reason: "DEGRADED",
      enforced: true,
    });

    config.current = { ...config.current, mode: "shadow" };
    expect(await getEntitlements("ws-1")).toMatchObject({
      access: "FULL",
      reason: "DEGRADED",
      enforced: false,
      unlimited: true,
    });
    spy.mockRestore();
  });

  it("satırsız workspace: açılış tarihi yalnız LEGACY eşiği tanımlıysa okunur", async () => {
    findSubscription.mockResolvedValue(null);
    await getEntitlements("ws-1");
    expect(findWorkspace).not.toHaveBeenCalled();

    config.current = {
      ...config.current,
      legacyBefore: new Date("2026-10-01T00:00:00.000Z"),
    };
    findWorkspace.mockResolvedValue({ createdAt: new Date("2026-09-01T00:00:00.000Z") });
    expect(await getEntitlements("ws-1")).toMatchObject({
      access: "FULL",
      reason: "LEGACY",
    });
    expect(findWorkspace).toHaveBeenCalledTimes(1);
  });

  it("tutarsız abonelik satırı yüksek sesle loglanır ve salt-okunur kalır", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    findSubscription.mockResolvedValue({
      planKey: null,
      interval: "MONTH",
      status: "ACTIVE",
      quotaAnchor: null,
      paidThrough: null,
      trialEndsAt: null,
      graceUntil: null,
      legacyUntil: null,
      cancelAtPeriodEnd: false,
      periodIndex: 1,
      introOffer: false,
      pendingPlanKey: null,
      pendingInterval: null,
      pendingEffectiveAt: null,
      exempt: false,
    });
    expect(await getEntitlements("ws-9")).toMatchObject({
      access: "READ_ONLY",
      reason: "INCOMPLETE_SUBSCRIPTION",
    });
    expect(spy).toHaveBeenCalledWith(expect.stringContaining("ws-9"));
    spy.mockRestore();
  });
});
