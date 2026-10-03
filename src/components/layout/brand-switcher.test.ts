import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const nav = vi.hoisted(() => ({
  push: vi.fn(),
  // The onClick of every menu item, in render order.
  clicks: [] as (() => void)[],
}));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: nav.push }) }));

// The menu is portaled and unmounted while closed: render it inline and keep
// each item's click handler.
vi.mock("@/components/ui/dropdown-menu", () => {
  type Props = Record<string, unknown> & { children?: ReactNode };
  return {
    DropdownMenu: ({ children }: Props) => children,
    DropdownMenuTrigger: () => null,
    DropdownMenuContent: ({ children }: Props) => children,
    DropdownMenuItem: ({ children, onClick }: Props) => {
      if (typeof onClick === "function") nav.clicks.push(onClick as () => void);
      return createElement("div", { role: "menuitem" }, children);
    },
    DropdownMenuSeparator: () => null,
  };
});

const { BrandSwitcher } = await import("./brand-switcher");

const projects = [
  { id: "a", name: "Alpha", status: "ACTIVE" },
  { id: "b", name: "Beta", status: "ACTIVE" },
];

beforeEach(() => {
  nav.push.mockClear();
  nav.clicks = [];
});

// Opening a project starts a new chat: picking the brand that is already open
// must not replace the conversation on screen with one.
describe("BrandSwitcher", () => {
  it("picking another brand opens it", () => {
    renderToStaticMarkup(
      createElement(BrandSwitcher, { projects, activeProjectId: "a" }),
    );
    nav.clicks[1]?.();
    expect(nav.push).toHaveBeenCalledWith("/projects/b");
  });

  it("picking the brand that is already open does nothing", () => {
    renderToStaticMarkup(
      createElement(BrandSwitcher, { projects, activeProjectId: "a" }),
    );
    nav.clicks[0]?.();
    expect(nav.push).not.toHaveBeenCalled();
  });

  it("on a page with no open brand every pick jumps in", () => {
    renderToStaticMarkup(createElement(BrandSwitcher, { projects }));
    nav.clicks[0]?.();
    nav.clicks[1]?.();
    expect(nav.push).toHaveBeenNthCalledWith(1, "/projects/a");
    expect(nav.push).toHaveBeenNthCalledWith(2, "/projects/b");
  });
});
