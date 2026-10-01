import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

// Guard W86 (composer-works): the "+" menu inside a Work hides the Reel and
// ad-creative items and never navigates away for an unconnected platform.

const items = vi.hoisted(() => [] as { value: string; onSelect: () => void }[]);
const push = vi.hoisted(() => vi.fn());

vi.mock("next/navigation", () => ({ useRouter: () => ({ push }) }));
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
    CommandGroup: pass,
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
const { CAPABILITY_SHORTCUTS } = await import("@/lib/composer-shortcuts");
const labelOf = (id: string) =>
  CAPABILITY_SHORTCUTS.find((s) => s.id === id)?.label ?? "";
const AD = labelOf("capability-CREATE_AD_CREATIVE");
const CAMPAIGN = labelOf("capability-META_CAMPAIGN_CREATE");

const onShortcut = vi.fn();
const render = (works?: boolean) => {
  items.length = 0;
  renderToStaticMarkup(
    createElement(ComposerPlusMenu, {
      projectId: "p1",
      publishTargets: [],
      onShortcut,
      ...(works === undefined ? {} : { works }),
    }),
  );
};
const pick = (value: string) => items.find((i) => i.value === value)?.onSelect();

beforeEach(() => {
  push.mockClear();
  onShortcut.mockClear();
});

describe("ComposerPlusMenu in a Work", () => {
  it("labels resolve", () => {
    expect(AD).not.toBe("");
    expect(CAMPAIGN).not.toBe("");
  });

  it("hides the Reel and ad-creative items", () => {
    render(true);
    const values = items.map((i) => i.value);
    expect(values).not.toContain("Create Instagram Reel");
    expect(values).not.toContain(AD);
    expect(values).toContain("Create Instagram post");
  });

  it("an unconnected platform calls onShortcut, not router.push", () => {
    render(true);
    pick("Create Instagram post");
    expect(onShortcut).toHaveBeenCalledTimes(1);
    expect(push).not.toHaveBeenCalled();
  });

  it("navigate items still navigate", () => {
    render(true);
    const navigate = items.find((i) => i.value === CAMPAIGN);
    expect(navigate).toBeDefined();
    navigate?.onSelect();
    expect(push).toHaveBeenCalledTimes(1);
  });
});

describe("ComposerPlusMenu outside a Work", () => {
  it("keeps every item and the integrations redirect", () => {
    render();
    const values = items.map((i) => i.value);
    expect(values).toContain("Create Instagram Reel");
    expect(values).toContain(AD);
    pick("Create Instagram post");
    expect(push).toHaveBeenCalledWith("/projects/p1/integrations");
    expect(onShortcut).not.toHaveBeenCalled();
  });
});
