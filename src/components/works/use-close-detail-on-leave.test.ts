import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  pane: null as unknown,
  cleanups: [] as (() => void)[],
}));
vi.mock("@/components/workspace/workspace-panel-toggle", () => ({
  useWorkspaceDetail: () => state.pane,
}));
// Keep what an effect returns, so the unmount can be run by hand.
vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  return {
    ...actual,
    default: actual,
    useEffect: (effect: () => unknown) => {
      const cleanup = effect();
      if (typeof cleanup === "function") state.cleanups.push(cleanup as () => void);
    },
  };
});

const { useCloseDetailOnLeave } = await import("./use-close-detail-on-leave");

const Probe = () => {
  useCloseDetailOnLeave();
  return null;
};

beforeEach(() => {
  state.cleanups = [];
});

describe("useCloseDetailOnLeave", () => {
  it("closes the pane when the chat goes, and not before", () => {
    const closeDetail = vi.fn();
    state.pane = { closeDetail };
    renderToStaticMarkup(createElement(Probe));
    expect(closeDetail).not.toHaveBeenCalled();
    for (const cleanup of state.cleanups) cleanup();
    expect(closeDetail).toHaveBeenCalledTimes(1);
  });

  it("does nothing where there is no pane", () => {
    state.pane = null;
    renderToStaticMarkup(createElement(Probe));
    expect(() => state.cleanups.forEach((cleanup) => cleanup())).not.toThrow();
  });
});
