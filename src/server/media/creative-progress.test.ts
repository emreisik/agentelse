import { describe, expect, it, vi } from "vitest";

const {
  emitCreativeProgress,
  hasCreativeProgressListener,
  subscribeCreativeProgress,
} = await import("./creative-progress");

const event = { type: "partial", index: 0, dataUrl: "data:x" } as const;

describe("creative-progress", () => {
  it("delivers events only to listeners of that job and stops after unsubscribe", () => {
    const a = vi.fn();
    const b = vi.fn();
    const offA = subscribeCreativeProgress("job-a", a);
    subscribeCreativeProgress("job-b", b);

    expect(hasCreativeProgressListener("job-a")).toBe(true);
    emitCreativeProgress("job-a", event);
    expect(a).toHaveBeenCalledWith(event);
    expect(b).not.toHaveBeenCalled();

    offA();
    expect(hasCreativeProgressListener("job-a")).toBe(false);
    emitCreativeProgress("job-a", event);
    expect(a).toHaveBeenCalledTimes(1);
  });

  it("isolates a throwing listener from the publisher and other listeners", () => {
    const good = vi.fn();
    subscribeCreativeProgress("job-c", () => {
      throw new Error("closed stream");
    });
    subscribeCreativeProgress("job-c", good);
    expect(() => emitCreativeProgress("job-c", event)).not.toThrow();
    expect(good).toHaveBeenCalled();
  });
});
