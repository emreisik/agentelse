import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The address bar loses its one-shot parameters (checkout, purchase, session_id, notice)
// only AFTER Next's router has installed its history patch, and again after every in-app
// navigation. Effect ORDER cannot be seen without a browser (no DOM test dependency here),
// so this pins the two decisions that make it right: the strip is deferred out of the
// effect, and the effect depends on the search string.

const effects = vi.hoisted(() => ({
  runs: [] as { effect: () => void | (() => void); deps: unknown[] }[],
  search: "tab=subscription&checkout=success&session_id=cs_test_abc12345",
}));
vi.mock("react", async (importOriginal) => ({
  ...(await importOriginal<typeof import("react")>()),
  useEffect: (effect: () => void | (() => void), deps: unknown[]) => {
    effects.runs.push({ effect, deps });
  },
}));
vi.mock("next/navigation", () => ({
  useSearchParams: () => new URLSearchParams(effects.search),
}));

const { ClearOneShotParams } = await import("./clear-one-shot-params");

const replaceState = vi.fn();
const href = (search: string) => `https://app.test/billing?${search}`;

beforeEach(() => {
  vi.useFakeTimers();
  effects.runs.length = 0;
  replaceState.mockClear();
  vi.stubGlobal("window", {
    location: { href: href(effects.search) },
    history: { replaceState },
    setTimeout: globalThis.setTimeout.bind(globalThis),
    clearTimeout: globalThis.clearTimeout.bind(globalThis),
  });
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

function mount() {
  ClearOneShotParams();
  const run = effects.runs.at(-1)!;
  return { deps: run.deps, cleanup: run.effect() };
}

describe("ClearOneShotParams", () => {
  it("does not touch the address inside the effect (Next's history patch is not installed yet at that point); it does so on the next turn", () => {
    mount();

    expect(replaceState).not.toHaveBeenCalled();
    vi.advanceTimersByTime(0);
    expect(replaceState).toHaveBeenCalledTimes(1);
    expect(replaceState).toHaveBeenCalledWith(
      null,
      "",
      "/billing?tab=subscription",
    );
  });

  it("runs again for every new search string, so a notice that arrives by in-app navigation is cleared too", () => {
    const first = mount();
    effects.search = "tab=subscription&notice=canceled";
    const second = mount();

    expect(first.deps).toEqual([
      "tab=subscription&checkout=success&session_id=cs_test_abc12345",
    ]);
    expect(second.deps).toEqual(["tab=subscription&notice=canceled"]);
    expect(first.deps).not.toEqual(second.deps);
  });

  it("a cleaned address is left alone, and leaving the page cancels a pending strip", () => {
    effects.search = "tab=plans";
    (window as unknown as { location: { href: string } }).location.href = href(
      "tab=plans",
    );
    mount();
    vi.advanceTimersByTime(0);
    expect(replaceState).not.toHaveBeenCalled();

    effects.search = "tab=subscription&notice=resumed";
    (window as unknown as { location: { href: string } }).location.href = href(
      "tab=subscription&notice=resumed",
    );
    const { cleanup } = mount();
    (cleanup as () => void)();
    vi.advanceTimersByTime(0);
    expect(replaceState).not.toHaveBeenCalled();
  });
});
