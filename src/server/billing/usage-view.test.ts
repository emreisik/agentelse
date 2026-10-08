import { describe, expect, it } from "vitest";

import { toUsageView } from "./ledger";

const NOW = new Date("2026-11-15T12:00:00.000Z");
const row = (overrides: Record<string, unknown> = {}) => ({
  unit: "IMAGE",
  periodEnd: new Date("2026-12-01T00:00:00.000Z") as Date | null,
  periodGranted: BigInt(50),
  periodUsed: BigInt(20),
  periodReserved: BigInt(5),
  extraGranted: BigInt(10),
  extraUsed: BigInt(2),
  extraReserved: BigInt(1),
  ...overrides,
});

describe("toUsageView", () => {
  it("BigInt'i sayıya çevirir ve JSON'a yazılabilir (Response.json patlamaz)", () => {
    const view = toUsageView(row() as never, NOW);
    expect(view).toEqual({
      unit: "IMAGE",
      period: {
        granted: 50,
        used: 20,
        reserved: 5,
        available: 25,
        endsAt: "2026-12-01T00:00:00.000Z",
      },
      extra: { granted: 10, used: 2, reserved: 1, available: 7 },
      available: 32,
    });
    expect(() => JSON.stringify(view)).not.toThrow();
  });

  it("sönmüş pencere harcanabilir sayılmaz; extra kalır", () => {
    const view = toUsageView(
      row({ periodEnd: new Date("2026-11-01T00:00:00.000Z") }) as never,
      NOW,
    );
    expect(view.period.available).toBe(0);
    expect(view.available).toBe(7);
  });

  it("borç (used > granted) görünümde 0'a kelepçelenir, negatif çıkmaz", () => {
    const view = toUsageView(
      row({ periodUsed: BigInt(60), extraUsed: BigInt(12) }) as never,
      NOW,
    );
    expect(view.period.available).toBe(0);
    expect(view.extra.available).toBe(0);
    expect(view.available).toBe(0);
  });

  it("pencere hiç açılmamışsa (yalnız extra) dönem 0", () => {
    const view = toUsageView(
      row({ periodEnd: null, periodGranted: BigInt(0), periodUsed: BigInt(0), periodReserved: BigInt(0) }) as never,
      NOW,
    );
    expect(view.period.endsAt).toBeNull();
    expect(view.available).toBe(7);
  });
});
