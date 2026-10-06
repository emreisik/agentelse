import { describe, expect, it } from "vitest";

import { createHostPacer } from "./pacer";

// Sahte saat: sleep saati ilerletir, gerçek bekleme yok.
function fakeClock(start = 1_000_000) {
  let now = start;
  return {
    now: () => now,
    sleep: async (ms: number) => {
      now += ms;
    },
  };
}

describe("createHostPacer", () => {
  it("spaces two waits for one host by at least 1000 ms", async () => {
    const clock = fakeClock();
    const pacer = createHostPacer(clock);
    const times: number[] = [];
    await Promise.all([
      pacer.wait("example.com").then(() => times.push(clock.now())),
      pacer.wait("example.com").then(() => times.push(clock.now())),
      pacer.wait("EXAMPLE.com").then(() => times.push(clock.now())),
    ]);
    expect(times).toHaveLength(3);
    expect(times[1]! - times[0]!).toBeGreaterThanOrEqual(1_000);
    expect(times[2]! - times[1]!).toBeGreaterThanOrEqual(1_000);
  });

  it("does not wait for the first request to a host", async () => {
    const clock = fakeClock();
    const pacer = createHostPacer(clock);
    const before = clock.now();
    await pacer.wait("example.com");
    expect(clock.now()).toBe(before);
  });

  it("does not let different hosts block each other", async () => {
    const clock = fakeClock();
    const pacer = createHostPacer(clock);
    await pacer.wait("a.example.com");
    const before = clock.now();
    await pacer.wait("b.example.com");
    expect(clock.now()).toBe(before);
  });

  it("honours a longer crawl-delay interval", async () => {
    const clock = fakeClock();
    const pacer = createHostPacer(clock);
    await pacer.wait("example.com", 5_000);
    const first = clock.now();
    await pacer.wait("example.com", 5_000);
    expect(clock.now() - first).toBeGreaterThanOrEqual(5_000);
  });

  it("never goes below the minimum interval", async () => {
    const clock = fakeClock();
    const pacer = createHostPacer(clock);
    await pacer.wait("example.com", 10);
    const first = clock.now();
    await pacer.wait("example.com", 10);
    expect(clock.now() - first).toBeGreaterThanOrEqual(1_000);
  });

  it("does not wait again once the interval has passed on its own", async () => {
    const clock = fakeClock();
    const pacer = createHostPacer({ ...clock, minIntervalMs: 2_000 });
    await pacer.wait("example.com");
    await clock.sleep(3_000);
    const before = clock.now();
    await pacer.wait("example.com");
    expect(clock.now()).toBe(before);
  });
});
