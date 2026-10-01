import { describe, expect, it, vi } from "vitest";

import type { CardButton } from "@/lib/works/card-action";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }),
}));
vi.mock("sonner", () => ({ toast: { error: vi.fn() } }));

const { runCardAction } = await import("./use-card-action");
const { disabledReasonOf } = await import("./work-card-host");
type Deps = Parameters<typeof runCardAction>[1];
type Host = NonNullable<Parameters<typeof disabledReasonOf>[0]>;

function deps(over: Partial<Deps> = {}): Deps {
  return {
    send: vi.fn(async () => undefined),
    navigate: vi.fn(),
    openTab: vi.fn(),
    server: vi.fn(async () => ({ ok: true as const })),
    refresh: vi.fn(),
    announce: vi.fn(),
    toastError: vi.fn(),
    ...over,
  };
}

const button = (action: CardButton["action"]): CardButton => ({
  id: "b1",
  label: "Go",
  emphasis: "primary",
  action,
});

describe("runCardAction (W74 kit-hook)", () => {
  it("ignores a second call while one is in flight", async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const d = deps({ send: vi.fn(() => gate) });
    const guard = { current: false };
    const first = runCardAction(button({ kind: "send", text: "hi" }), d, guard);
    expect(guard.current).toBe(true);
    const second = await runCardAction(button({ kind: "send", text: "hi" }), d, guard);
    expect(second).toEqual({ error: null });
    expect(d.send).toHaveBeenCalledTimes(1);
    release();
    await first;
    expect(guard.current).toBe(false);
  });

  it("maps a thrown error to the kit failure text and frees the guard", async () => {
    const d = deps({ send: vi.fn(async () => { throw new Error("boom"); }) });
    const guard = { current: false };
    const out = await runCardAction(button({ kind: "send", text: "hi" }), d, guard);
    expect(out).toEqual({ error: "That didn't work. Try again." });
    expect(guard.current).toBe(false);
  });

  it("routes send, link, tab and server", async () => {
    const d = deps();
    const g = { current: false };
    await runCardAction(button({ kind: "send", text: "plan it" }), d, g);
    expect(d.send).toHaveBeenCalledWith("plan it");
    await runCardAction(button({ kind: "link", href: "/projects/p1/x" }), d, g);
    expect(d.navigate).toHaveBeenCalledWith("/projects/p1/x");
    await runCardAction(button({ kind: "tab", tab: "calendar" }), d, g);
    expect(d.openTab).toHaveBeenCalledWith("calendar");
    await runCardAction(button({ kind: "server", id: "pick" }), d, g);
    expect(d.server).toHaveBeenCalledWith("pick");
  });

  it("fails cleanly with no send, no handler or an external link", async () => {
    const g = { current: false };
    const failed = { error: "That didn't work. Try again." };
    expect(await runCardAction(button({ kind: "send", text: "x" }), deps({ send: null }), g)).toEqual(failed);
    expect(await runCardAction(button({ kind: "server", id: "x" }), deps({ server: () => undefined }), g)).toEqual(failed);
    const d = deps();
    expect(await runCardAction(button({ kind: "link", href: "https://evil.example" }), d, g)).toEqual(failed);
    expect(d.navigate).not.toHaveBeenCalled();
  });

  it("reports STALE and CONFLICT as a refresh", async () => {
    for (const code of ["STALE", "CONFLICT"]) {
      const d = deps({ server: async () => ({ ok: false as const, message: "x", code }) });
      const out = await runCardAction(button({ kind: "server", id: "s" }), d, { current: false });
      expect(out).toEqual({ error: null });
      expect(d.toastError).toHaveBeenCalledWith("This card is out of date. Refreshing.");
      expect(d.refresh).toHaveBeenCalledTimes(1);
    }
  });

  it("returns another failure message as the error without refreshing", async () => {
    const d = deps({ server: async () => ({ ok: false as const, message: "Already picked." }) });
    const out = await runCardAction(button({ kind: "server", id: "s" }), d, { current: false });
    expect(out).toEqual({ error: "Already picked." });
    expect(d.refresh).not.toHaveBeenCalled();
  });

  it("does NOT refresh after a plain ok, only with result.refresh", async () => {
    const plain = deps();
    await runCardAction(button({ kind: "server", id: "s" }), plain, { current: false });
    expect(plain.refresh).not.toHaveBeenCalled();
    const asked = deps({ server: async () => ({ ok: true as const, refresh: true }) });
    await runCardAction(button({ kind: "server", id: "s" }), asked, { current: false });
    expect(asked.refresh).toHaveBeenCalledTimes(1);
  });

  it("announces the result message once", async () => {
    const d = deps({ server: async () => ({ ok: true as const, message: "Plan ready." }) });
    await runCardAction(button({ kind: "server", id: "s" }), d, { current: false });
    expect(d.announce).toHaveBeenCalledWith("Plan ready.");
    const quiet = deps();
    await runCardAction(button({ kind: "server", id: "s" }), quiet, { current: false });
    expect(quiet.announce).not.toHaveBeenCalled();
  });
});

function host(over: Partial<Host> = {}): Host {
  return {
    projectId: "p1",
    workId: "w1",
    workTitle: "Week",
    active: true,
    busy: false,
    producing: new Set<string>(),
    channels: [],
    openTab: () => undefined,
    runNextStep: () => undefined,
    announce: () => undefined,
    requestFocus: () => undefined,
    cancelFocus: () => undefined,
    consumeFocus: () => false,
    ...over,
  };
}

describe("disabledReasonOf (W74 kit-hook)", () => {
  const done = "This Work is completed. Reopen it to continue.";

  it("is null outside a Work", () => {
    expect(disabledReasonOf(null, { kind: "send" })).toBeNull();
  });

  it("blocks send and server in a Completed Work, never link or tab", () => {
    const h = host({ active: false });
    expect(disabledReasonOf(h, { kind: "send" })).toBe(done);
    expect(disabledReasonOf(h, { kind: "server" })).toBe(done);
    expect(disabledReasonOf(h, { kind: "link" })).toBeNull();
    expect(disabledReasonOf(h, { kind: "tab" })).toBeNull();
  });

  it("blocks send only while a chat turn streams", () => {
    const h = host({ busy: true });
    expect(disabledReasonOf(h, { kind: "send" })).toBe("Wait for the reply to finish.");
    expect(disabledReasonOf(h, { kind: "server" })).toBeNull();
    expect(disabledReasonOf(h, { kind: "link" })).toBeNull();
    expect(disabledReasonOf(h, { kind: "tab" })).toBeNull();
  });

  it("blocks a server step of a plan being produced, only that plan", () => {
    const h = host({ producing: new Set(["plan1"]) });
    expect(disabledReasonOf(h, { kind: "server", planId: "plan1" })).toBe("Making your pieces…");
    expect(disabledReasonOf(h, { kind: "server", planId: "plan2" })).toBeNull();
    expect(disabledReasonOf(h, { kind: "server" })).toBeNull();
    expect(disabledReasonOf(h, { kind: "send", planId: "plan1" })).toBeNull();
  });

  it("an idle active Work blocks nothing", () => {
    for (const kind of ["send", "server", "link", "tab"] as const) {
      expect(disabledReasonOf(host(), { kind })).toBeNull();
    }
  });
});
