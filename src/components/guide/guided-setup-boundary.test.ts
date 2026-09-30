import { createElement } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const toastError = vi.hoisted(() => vi.fn());
vi.mock("sonner", () => ({ toast: { error: toastError, success: vi.fn() } }));

import { BOUNDARY_TOAST, GuidedSetupBoundary } from "./guided-setup-boundary";

beforeEach(() => {
  toastError.mockReset();
});

function boundary(onError?: () => void) {
  return new GuidedSetupBoundary({
    children: createElement("div", null, "sheet"),
    onError,
  });
}

describe("GuidedSetupBoundary", () => {
  it("renders its children while nothing is wrong", () => {
    const b = boundary();
    expect(b.render()).toMatchObject({ type: "div" });
  });

  it("turns an error into a failed state instead of rethrowing", () => {
    expect(GuidedSetupBoundary.getDerivedStateFromError()).toEqual({
      failed: true,
    });
  });

  it("renders nothing once failed (the page must not blank)", () => {
    const b = boundary();
    b.state = GuidedSetupBoundary.getDerivedStateFromError();
    expect(b.render()).toBeNull();
  });

  it("toasts exactly once, with the copy text, and tells the host", () => {
    const onError = vi.fn();
    const b = boundary(onError);
    b.componentDidCatch();
    b.componentDidCatch();
    expect(toastError).toHaveBeenCalledTimes(1);
    expect(toastError).toHaveBeenCalledWith(
      "Setup couldn't open. Reload the page, or continue in chat.",
    );
    expect(BOUNDARY_TOAST).toBe(
      "Setup couldn't open. Reload the page, or continue in chat.",
    );
    expect(onError).toHaveBeenCalledTimes(1);
  });

  it("never throws from the error handler itself", () => {
    toastError.mockImplementation(() => {
      throw new Error("toaster missing");
    });
    const b = boundary();
    expect(() => b.componentDidCatch()).not.toThrow();
  });
});
