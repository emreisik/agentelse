import { describe, expect, it, vi } from "vitest";

import { isSerializationFailure, withSerializableRetry } from "./serializable";

const conflict = () => Object.assign(new Error("conflict"), { code: "P2034" });

describe("withSerializableRetry", () => {
  it("passes a successful result through without a retry", async () => {
    const run = vi.fn().mockResolvedValue("ok");
    await expect(withSerializableRetry(run)).resolves.toBe("ok");
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("retries once on P2034 and returns the second result", async () => {
    const run = vi
      .fn()
      .mockRejectedValueOnce(conflict())
      .mockResolvedValueOnce("second");
    await expect(withSerializableRetry(run)).resolves.toBe("second");
    expect(run).toHaveBeenCalledTimes(2);
  });

  it("retries on a raw 40001 code too", async () => {
    const run = vi
      .fn()
      .mockRejectedValueOnce(Object.assign(new Error("x"), { code: "40001" }))
      .mockResolvedValueOnce(1);
    await expect(withSerializableRetry(run)).resolves.toBe(1);
  });

  it("does not retry other errors", async () => {
    const boom = Object.assign(new Error("unique"), { code: "P2002" });
    const run = vi.fn().mockRejectedValue(boom);
    await expect(withSerializableRetry(run)).rejects.toBe(boom);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("rethrows after the second failure", async () => {
    const first = conflict();
    const second = conflict();
    const run = vi
      .fn()
      .mockRejectedValueOnce(first)
      .mockRejectedValueOnce(second);
    await expect(withSerializableRetry(run)).rejects.toBe(second);
    expect(run).toHaveBeenCalledTimes(2);
  });

  it("honours a custom retry count", async () => {
    const run = vi
      .fn()
      .mockRejectedValueOnce(conflict())
      .mockRejectedValueOnce(conflict())
      .mockResolvedValueOnce("third");
    await expect(withSerializableRetry(run, 2)).resolves.toBe("third");
    expect(run).toHaveBeenCalledTimes(3);
  });

  it("recognises only serialization failures", () => {
    expect(isSerializationFailure(conflict())).toBe(true);
    expect(isSerializationFailure(new Error("plain"))).toBe(false);
    expect(isSerializationFailure(null)).toBe(false);
  });
});
