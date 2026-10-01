import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  replace: vi.fn(),
  createWorkAction: vi.fn(),
  openTodayWorkAction: vi.fn(),
}));

// Static markup does not run effects: run them while rendering so the
// opener's mount behaviour can be observed once.
vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  return {
    ...actual,
    default: actual,
    useEffect: (effect: () => void) => {
      effect();
    },
  };
});
vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: mocks.replace }),
}));
vi.mock("@/server/actions/work-actions", () => ({
  createWorkAction: mocks.createWorkAction,
  openTodayWorkAction: mocks.openTodayWorkAction,
}));

const { NewWorkOpener, NewWorkOpenerView, OPENER_COPY, openerCopy } =
  await import("./new-work-opener");

const noop = () => {};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.createWorkAction.mockResolvedValue({ ok: true, workId: "w1" });
  mocks.openTodayWorkAction.mockResolvedValue({
    ok: true,
    workId: "today_p1_2026-10-01",
  });
});

describe("openerCopy", () => {
  it("says the first-Work line by default and the brief line in today mode", () => {
    expect(openerCopy()).toBe("Opening your first Work…");
    expect(openerCopy("first")).toBe(OPENER_COPY.opening);
    expect(openerCopy("today")).toBe("Opening today's brief…");
  });
});

describe("NewWorkOpenerView", () => {
  it("renders the mode's line in a live status", () => {
    const first = renderToStaticMarkup(
      createElement(NewWorkOpenerView, { error: null, onRetry: noop }),
    );
    expect(first).toContain("Opening your first Work…");
    const today = renderToStaticMarkup(
      createElement(NewWorkOpenerView, {
        error: null,
        onRetry: noop,
        mode: "today",
      }),
    );
    expect(today).toContain('role="status"');
    expect(today).toContain("Opening today&#x27;s brief…");
    expect(today).not.toContain("first Work");
  });
});

describe("NewWorkOpener", () => {
  it("a thrown action is caught (no unhandled rejection, no navigation)", async () => {
    const unhandled = vi.fn();
    process.on("unhandledRejection", unhandled);
    mocks.openTodayWorkAction.mockRejectedValue(new Error("offline"));
    renderToStaticMarkup(
      createElement(NewWorkOpener, { projectId: "p1", mode: "today" }),
    );
    await vi.waitFor(() =>
      expect(mocks.openTodayWorkAction).toHaveBeenCalledTimes(1),
    );
    await new Promise((resolve) => setTimeout(resolve, 20));
    process.off("unhandledRejection", unhandled);
    expect(unhandled).not.toHaveBeenCalled();
    expect(mocks.replace).not.toHaveBeenCalled();
  });

  it("today mode calls openTodayWorkAction once and moves into that Work", async () => {
    renderToStaticMarkup(
      createElement(NewWorkOpener, { projectId: "p1", mode: "today" }),
    );
    await vi.waitFor(() => expect(mocks.replace).toHaveBeenCalledTimes(1));
    expect(mocks.openTodayWorkAction).toHaveBeenCalledTimes(1);
    expect(mocks.openTodayWorkAction).toHaveBeenCalledWith("p1");
    expect(mocks.createWorkAction).not.toHaveBeenCalled();
    expect(mocks.replace).toHaveBeenCalledWith(
      "/projects/p1?work=today_p1_2026-10-01",
    );
  });

  it("default mode is unchanged: createWorkAction, never the Today action", async () => {
    renderToStaticMarkup(createElement(NewWorkOpener, { projectId: "p1" }));
    await vi.waitFor(() => expect(mocks.replace).toHaveBeenCalledTimes(1));
    expect(mocks.createWorkAction).toHaveBeenCalledWith("p1");
    expect(mocks.openTodayWorkAction).not.toHaveBeenCalled();
  });
});
