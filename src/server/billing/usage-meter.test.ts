import { describe, expect, it } from "vitest";

import { UsageMeter } from "./usage-meter";

const meter = (ceilingMicros?: bigint) =>
  new UsageMeter({ workspaceId: "w1", operationId: "op", ceilingMicros });

describe("UsageMeter", () => {
  it("sums the cost of every call, successful or not", () => {
    const m = meter();
    m.add({ callId: "a", kind: "TEXT", costMicros: BigInt(1_000), success: true });
    m.add({ callId: "b", kind: "SEARCH", costMicros: BigInt(10_000), success: false });
    expect(m.costMicros).toBe(BigInt(11_000));
    expect(m.calls).toBe(2);
  });

  it("counts only successful pictures, by units", () => {
    const m = meter();
    m.add({ callId: "a", kind: "IMAGE", costMicros: BigInt(5), success: false });
    m.add({ callId: "b", kind: "IMAGE", costMicros: BigInt(5), success: true });
    m.add({ callId: "c", kind: "IMAGE", costMicros: BigInt(5), success: true, units: 3 });
    m.add({ callId: "d", kind: "TEXT", costMicros: BigInt(5), success: true, units: 9 });
    expect(m.images).toBe(4);
  });

  it("ignores a repeated callId", () => {
    const m = meter();
    const call = { callId: "a", kind: "IMAGE" as const, costMicros: BigInt(7), success: true };
    m.add(call);
    m.add(call);
    expect(m.costMicros).toBe(BigInt(7));
    expect(m.images).toBe(1);
    expect(m.calls).toBe(1);
  });

  it("never lets a negative or bogus entry reduce the total or add pictures", () => {
    const m = meter();
    m.add({ callId: "a", kind: "TEXT", costMicros: BigInt(100), success: true });
    m.add({ callId: "b", kind: "TEXT", costMicros: BigInt(-50), success: true });
    m.add({ callId: "c", kind: "IMAGE", costMicros: BigInt(0), success: true, units: -2 });
    m.add({ callId: "d", kind: "IMAGE", costMicros: BigInt(0), success: true, units: Number.NaN });
    expect(m.costMicros).toBe(BigInt(100));
    expect(m.images).toBe(0);
  });

  it("reports the ceiling as exceeded only once the spend is above it", () => {
    const m = meter(BigInt(1_000));
    m.add({ callId: "a", kind: "TEXT", costMicros: BigInt(1_000), success: true });
    expect(m.exceeded).toBe(false);
    m.add({ callId: "b", kind: "TEXT", costMicros: BigInt(1), success: true });
    expect(m.exceeded).toBe(true);
    expect(meter().exceeded).toBe(false);
  });
});
