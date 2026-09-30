import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  buildGuidedSetupApi,
  GuidedSetupProvider,
} from "@/components/guide/guided-setup-context";
import type { GuidedSetupSummary } from "@/lib/guided-setup/contract";

// The "+" menu's Setup group (spec 4, E3). The popover and cmdk are stubbed so
// the menu body renders on the server and every item's onSelect is reachable.

const items = vi.hoisted(() => [] as { value: string; onSelect: () => void }[]);

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }) }));
vi.mock("@assistant-ui/react", () => ({
  ComposerPrimitive: { AddAttachment: () => null },
}));
vi.mock("@/components/assistant-ui/tooltip-icon-button", () => ({
  TooltipIconButton: () => null,
}));
vi.mock("@/components/ui/popover", () => ({
  Popover: ({ children }: { children: ReactNode }) => children,
  PopoverTrigger: () => null,
  PopoverContent: ({ children }: { children: ReactNode }) => children,
}));
vi.mock("@/components/ui/command", () => {
  const pass = ({ children }: { children?: ReactNode }) => children ?? null;
  return {
    Command: pass,
    CommandInput: () => null,
    CommandList: pass,
    CommandEmpty: () => null,
    CommandSeparator: () => null,
    CommandGroup: ({
      heading,
      children,
    }: {
      heading: string;
      children: ReactNode;
    }) => createElement("section", { "data-heading": heading }, children),
    CommandItem: ({
      value,
      onSelect,
      children,
    }: {
      value: string;
      onSelect: () => void;
      children: ReactNode;
    }) => {
      items.push({ value, onSelect });
      return createElement("b", null, children);
    },
  };
});

const { ComposerPlusMenu } = await import("./composer-plus-menu");

const summary = (
  over: Partial<GuidedSetupSummary> = {},
): GuidedSetupSummary => ({
  status: "NONE",
  answered: 0,
  total: 5,
  position: 1,
  started: false,
  hasProfile: false,
  ...over,
});

const render = (api: ReturnType<typeof buildGuidedSetupApi> | null) => {
  items.length = 0;
  return renderToStaticMarkup(
    createElement(
      GuidedSetupProvider,
      { value: api },
      createElement(ComposerPlusMenu, {
        projectId: "p1",
        publishTargets: [],
        onShortcut: vi.fn(),
      }),
    ),
  );
};
const apiOf = (s: GuidedSetupSummary, open = vi.fn()) =>
  buildGuidedSetupApi({
    isOpen: false,
    open,
    close: vi.fn(),
    summary: s,
    canDraftPlan: true,
  });

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("ComposerPlusMenu Setup group", () => {
  it("no context (flag off, idea thread): no Setup group", () => {
    const html = render(null);
    expect(html).not.toContain('data-heading="Setup"');
    expect(html).toContain('data-heading="Add"');
  });

  it("context: Setup is the FIRST group and carries the entry label", () => {
    const html = render(apiOf(summary()));
    const setup = html.indexOf('data-heading="Setup"');
    expect(setup).toBeGreaterThan(-1);
    expect(setup).toBeLessThan(html.indexOf('data-heading="Add"'));
    expect(html).toContain("Set up your brand");
  });

  it("the label follows the session (continue by position, update)", () => {
    expect(
      render(apiOf(summary({ status: "OPEN", answered: 2, position: 3 }))),
    ).toContain("Continue setup · question 3 of 5");
    expect(render(apiOf(summary({ hasProfile: true })))).toContain(
      "Update your setup",
    );
  });

  it("selecting it opens the sheet a frame later, not synchronously", () => {
    const frames: FrameRequestCallback[] = [];
    vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => {
      frames.push(cb);
      return frames.length;
    });
    const open = vi.fn();
    render(apiOf(summary(), open));
    const setup = items.find((i) => i.value === "Set up your brand");
    expect(setup).toBeDefined();
    setup?.onSelect();
    expect(open).not.toHaveBeenCalled();
    expect(frames).toHaveLength(1);
    frames[0]?.(0);
    expect(open).toHaveBeenCalledTimes(1);
    expect(open).toHaveBeenCalledWith("menu");
  });
});
