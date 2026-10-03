import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  replace: vi.fn(),
  createWorkAction: vi.fn(),
  openTodayWorkAction: vi.fn(),
  // The landing URL's query string.
  search: "",
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
  useSearchParams: () => new URLSearchParams(mocks.search),
}));
vi.mock("@/server/actions/work-actions", () => ({
  createWorkAction: mocks.createWorkAction,
  openTodayWorkAction: mocks.openTodayWorkAction,
}));

const {
  NewWorkOpener,
  NewWorkOpenerView,
  OPENER_COPY,
  openedWorkHref,
  openerCopy,
  runOpener,
} = await import("./new-work-opener");

const noop = () => {};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.search = "";
  mocks.createWorkAction.mockResolvedValue({ ok: true, workId: "w1" });
  mocks.openTodayWorkAction.mockResolvedValue({
    ok: true,
    workId: "today_p1_2026-10-01",
  });
});

describe("openerCopy", () => {
  it("says the new-chat line by default and the brief line in today mode", () => {
    expect(openerCopy()).toBe("Opening a new chat…");
    expect(openerCopy("new")).toBe(OPENER_COPY.opening);
    expect(openerCopy("today")).toBe("Opening today's brief…");
  });
});

describe("openedWorkHref", () => {
  it("is the Work's own address when the landing asked for nothing else", () => {
    expect(openedWorkHref("p1", "w1", "")).toBe("/projects/p1?work=w1");
  });

  it("keeps what the landing asked for (setup sheet, next step, calendar)", () => {
    expect(openedWorkHref("p1", "w1", "guide=setup")).toBe(
      "/projects/p1?work=w1&guide=setup",
    );
    expect(
      openedWorkHref("p1", "w1", "next=plan_next&calMonth=2026-10&calItem=c1"),
    ).toBe("/projects/p1?work=w1&next=plan_next&calMonth=2026-10&calItem=c1");
  });

  it("replaces the landing's own ?work= (today) with the opened Work", () => {
    expect(
      openedWorkHref("p1", "today_p1_2026-10-01", "work=today&next=plan_next"),
    ).toBe("/projects/p1?work=today_p1_2026-10-01&next=plan_next");
  });

  it("encodes the Work id like every other Work link", () => {
    expect(openedWorkHref("p1", "a b&c", "")).toBe("/projects/p1?work=a%20b%26c");
  });
});

// The action takes a moment (a cold database, the lock) while the sidebar and
// Back stay usable: a person who has already left must not be pulled into the
// new chat when it answers.
describe("runOpener", () => {
  const deferred = <T,>() => {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((r) => (resolve = r));
    return { promise, resolve };
  };
  const base = (over: Partial<Parameters<typeof runOpener>[0]> = {}) => ({
    projectId: "p1",
    mode: "new" as const,
    landing: "",
    create: async () => ({ ok: true as const, workId: "w1" }),
    stillHere: () => true,
    replace: vi.fn(),
    ...over,
  });

  it("moves into the new chat, keeping what the landing asked for", async () => {
    const input = base({ landing: "guide=setup" });
    await expect(runOpener(input)).resolves.toEqual({ kind: "moved" });
    expect(input.replace).toHaveBeenCalledWith("/projects/p1?work=w1&guide=setup");
  });

  it("does not move when the person left while the action was running", async () => {
    const gate = deferred<{ ok: true; workId: string }>();
    let here = true;
    const input = base({ create: () => gate.promise, stillHere: () => here });
    const running = runOpener(input);
    // They clicked a chat in the sidebar (or pressed Back) while it was running.
    here = false;
    gate.resolve({ ok: true, workId: "wBlank" });
    await expect(running).resolves.toEqual({ kind: "left" });
    expect(input.replace).not.toHaveBeenCalled();
  });

  it("shows no error to someone who has left, whether the action refused or threw", async () => {
    const refused = base({
      create: async () => ({ ok: false as const, message: "Slow down for a moment." }),
      stillHere: () => false,
    });
    await expect(runOpener(refused)).resolves.toEqual({ kind: "left" });
    const threw = base({
      create: async () => {
        throw new Error("offline");
      },
      stillHere: () => false,
    });
    await expect(runOpener(threw)).resolves.toEqual({ kind: "left" });
  });

  it("a refusal shows its message (or the standard one) and does not move", async () => {
    const withMessage = base({
      create: async () => ({ ok: false as const, message: "Slow down for a moment." }),
    });
    await expect(runOpener(withMessage)).resolves.toEqual({
      kind: "error",
      message: "Slow down for a moment.",
    });
    const bare = base({ create: async () => ({ ok: false as const, message: "" }) });
    await expect(runOpener(bare)).resolves.toEqual({
      kind: "error",
      message: OPENER_COPY.failed,
    });
    expect(withMessage.replace).not.toHaveBeenCalled();
    expect(bare.replace).not.toHaveBeenCalled();
  });

  it("a thrown action is an error with the retry button, not a spinner forever", async () => {
    const input = base({
      create: async () => {
        throw new Error("offline");
      },
    });
    await expect(runOpener(input)).resolves.toEqual({
      kind: "error",
      message: OPENER_COPY.failed,
    });
  });
});

describe("NewWorkOpenerView", () => {
  it("renders the mode's line in a live status", () => {
    const first = renderToStaticMarkup(
      createElement(NewWorkOpenerView, { error: null, onRetry: noop }),
    );
    expect(first).toContain("Opening a new chat…");
    const today = renderToStaticMarkup(
      createElement(NewWorkOpenerView, {
        error: null,
        onRetry: noop,
        mode: "today",
      }),
    );
    expect(today).toContain('role="status"');
    expect(today).toContain("Opening today&#x27;s brief…");
    expect(today).not.toContain("new chat");
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

  it("default mode opens a new chat with createWorkAction, never the Today action", async () => {
    renderToStaticMarkup(createElement(NewWorkOpener, { projectId: "p1" }));
    await vi.waitFor(() => expect(mocks.replace).toHaveBeenCalledTimes(1));
    expect(mocks.createWorkAction).toHaveBeenCalledWith("p1");
    expect(mocks.openTodayWorkAction).not.toHaveBeenCalled();
    expect(mocks.replace).toHaveBeenCalledWith("/projects/p1?work=w1");
  });

  it("a new project's ?guide=setup survives the move into the new chat", async () => {
    mocks.search = "guide=setup";
    renderToStaticMarkup(createElement(NewWorkOpener, { projectId: "p1" }));
    await vi.waitFor(() => expect(mocks.replace).toHaveBeenCalledTimes(1));
    expect(mocks.replace).toHaveBeenCalledWith("/projects/p1?work=w1&guide=setup");
  });

  it("a refusal does not move the page and is not retried on its own", async () => {
    mocks.createWorkAction.mockResolvedValue({
      ok: false,
      message: "Slow down for a moment.",
    });
    const html = renderToStaticMarkup(
      createElement(NewWorkOpener, { projectId: "p1" }),
    );
    expect(html).toContain("Opening a new chat…");
    await vi.waitFor(() =>
      expect(mocks.createWorkAction).toHaveBeenCalledTimes(1),
    );
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(mocks.replace).not.toHaveBeenCalled();
    expect(mocks.createWorkAction).toHaveBeenCalledTimes(1);
  });
});
