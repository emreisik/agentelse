import { describe, expect, it } from "vitest";

import { Lru, createLimiter } from "./lru";

describe("Lru", () => {
  it("drops the least recently used entry past its limit", () => {
    const cache = new Lru<string, number>(2);
    cache.set("a", 1);
    cache.set("b", 2);
    cache.get("a"); // a is now newer than b
    cache.set("c", 3);
    expect(cache.get("b")).toBeUndefined();
    expect(cache.get("a")).toBe(1);
    expect(cache.get("c")).toBe(3);
    expect(cache.size).toBe(2);
  });

  it("replaces a value without growing", () => {
    const cache = new Lru<string, number>(2);
    cache.set("a", 1);
    cache.set("a", 2);
    expect(cache.size).toBe(1);
    expect(cache.get("a")).toBe(2);
  });
});

describe("createLimiter", () => {
  it("never runs more than the limit at once, and runs everything", async () => {
    const run = createLimiter(2);
    let active = 0;
    let peak = 0;
    const job = async (n: number) => {
      active += 1;
      peak = Math.max(peak, active);
      await new Promise((resolve) => setTimeout(resolve, 5));
      active -= 1;
      return n;
    };
    const results = await Promise.all([1, 2, 3, 4, 5].map((n) => run(() => job(n))));
    expect(results).toEqual([1, 2, 3, 4, 5]);
    expect(peak).toBe(2);
  });

  it("keeps going after a job fails", async () => {
    const run = createLimiter(1);
    await expect(run(async () => Promise.reject(new Error("x")))).rejects.toThrow("x");
    expect(await run(async () => 7)).toBe(7);
  });
});
