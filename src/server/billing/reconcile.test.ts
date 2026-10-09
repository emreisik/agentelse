import { beforeEach, describe, expect, it, vi } from "vitest";

// Veritabanı yok: BILLING_MODE=off iken uzlaştırma adımı veritabanına HİÇ dokunmaz
// ("canlı yola tek sorgu eklenmez", docs/billing-quota.md). Deftere yazan mahsup
// zaten kendi `off` korumasıyla bir şey yapmaz; bu yüzden korumanın asıl işi
// sorguları atlamaktır ve yalnız sorgu sayılarak görülebilir. Gerçek davranış
// reconcile.integration.test.ts'te.
const config = vi.hoisted(() => ({
  current: {
    mode: "off" as "off" | "shadow" | "enforce",
    legacyBefore: null as Date | null,
    legacyUntil: null as Date | null,
  },
}));
vi.mock("./config", () => ({ getBillingConfig: () => config.current }));

const db = vi.hoisted(() => ({
  reservations: vi.fn(),
  jobs: vi.fn(),
  usage: vi.fn(),
}));
vi.mock("@/lib/prisma", () => ({
  prisma: {
    usageReservation: { findMany: db.reservations },
    executionJob: { findMany: db.jobs },
    usageEntry: { aggregate: db.usage },
  },
}));
vi.mock("./ledger", () => ({ settleUsage: vi.fn() }));

import { settleUsage } from "./ledger";
import { settleDeliveredOrphans } from "./reconcile";

describe("settleDeliveredOrphans", () => {
  beforeEach(() => {
    db.reservations.mockReset();
    db.jobs.mockReset();
    db.usage.mockReset();
    vi.mocked(settleUsage).mockReset();
    db.reservations.mockResolvedValue([]);
  });

  it("asks the database nothing and settles nothing while billing is off", async () => {
    config.current = { ...config.current, mode: "off" };

    expect(await settleDeliveredOrphans({ now: new Date() })).toBe(0);

    expect(db.reservations).not.toHaveBeenCalled();
    expect(db.jobs).not.toHaveBeenCalled();
    expect(db.usage).not.toHaveBeenCalled();
    expect(settleUsage).not.toHaveBeenCalled();
  });

  it("does look at the expired holds as soon as billing is on", async () => {
    // Control for the test above: the mocks are wired, so silence there means
    // the step really stayed away from the database.
    for (const mode of ["shadow", "enforce"] as const) {
      db.reservations.mockClear();
      config.current = { ...config.current, mode };
      expect(await settleDeliveredOrphans({ now: new Date() })).toBe(0);
      expect(db.reservations).toHaveBeenCalledTimes(1);
    }
  });
});
