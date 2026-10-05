import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const panel = vi.hoisted(() => ({
  value: {} as Record<string, unknown>,
  sheet: [] as Record<string, unknown>[],
  content: [] as Record<string, unknown>[],
}));
vi.mock("@/components/workspace/workspace-panel-toggle", () => ({
  useWorkspacePanelToggle: () => panel.value,
}));
// The drawer is portaled: render it inline and keep the props that matter.
vi.mock("@/components/ui/sheet", () => {
  type Props = Record<string, unknown> & { children?: ReactNode };
  return {
    Sheet: (props: Props) => {
      panel.sheet.push(props);
      return props.children;
    },
    SheetContent: (props: Props) => {
      panel.content.push(props);
      return createElement("div", { "data-drawer": true }, props.children);
    },
    SheetTitle: ({ children }: Props) => createElement("h1", null, children),
  };
});
const { WorkspaceRightPanel, closeOnEscape, dockPanelAction } =
  await import("./workspace-right-panel");

const base = {
  collapsed: false,
  toggle: vi.fn(),
  isDesktop: true,
  openTab: vi.fn(),
  requestedTab: null,
  consumeRequestedTab: vi.fn(),
  detail: null,
  closeDetail: vi.fn(),
  setDetailContainer: vi.fn(),
  detailPresent: new Set<string>(),
};

const render = (over: Record<string, unknown> = {}) => {
  panel.value = { ...base, ...over };
  panel.sheet = [];
  panel.content = [];
  return renderToStaticMarkup(
    createElement(WorkspaceRightPanel, {
      brand: "BRAND-TAB",
      files: "FILES-TAB",
      outputs: "OUTPUTS-TAB",
      calendar: "CALENDAR-TAB",
    }),
  );
};

const OPEN = { id: "c1", title: "BidUniq farkındalık haftası" };

beforeEach(() => {
  vi.clearAllMocks();
});

describe("WorkspaceRightPanel on a desktop", () => {
  it("open: only the panel on show, under its name, no tab row; the dock beside it", () => {
    const html = render();
    expect(html).toContain("BRAND-TAB");
    expect(html).not.toContain("FILES-TAB");
    expect(html).toContain("w-[320px]");
    expect(html).toMatch(/<h2[^>]*>Brand<\/h2>/);
    expect(html).toContain('aria-label="Workspace dock"');
    expect(html.indexOf("BRAND-TAB")).toBeLessThan(
      html.indexOf('aria-label="Workspace dock"'),
    );
    expect(html).not.toContain("workspace-detail");
  });

  it("collapsed: only the dock is left, with the panel's toggle and its four panels, nothing else", () => {
    const html = render({ collapsed: true });
    expect(html).not.toContain("BRAND-TAB");
    expect(html).not.toContain("w-[320px]");
    expect(html).toContain('aria-label="Open panel"');
    expect(html).toContain('aria-expanded="false"');
    for (const label of ["Brand", "Files", "Outputs", "Calendar"]) {
      expect(html).toContain(`aria-label="${label}" aria-pressed="false"`);
    }
    expect(html.match(/<button/g)).toHaveLength(5);
    expect(html).not.toContain('aria-haspopup="menu"');
    expect(html).toContain("w-12");
  });

  it("open: the dock's toggle closes it, and the panel on show is the pressed icon", () => {
    const html = render();
    expect(html).toContain('aria-label="Close panel"');
    expect(html).toContain('aria-label="Brand" aria-pressed="true"');
    expect(html).toContain('aria-label="Files" aria-pressed="false"');
  });

  it("a panel asked for (the Work Summary Strip's openTab) is the one on show", () => {
    const html = render({ requestedTab: "outputs" });
    expect(html).toContain("OUTPUTS-TAB");
    expect(html).not.toContain("BRAND-TAB");
    expect(html).toContain('aria-label="Outputs" aria-pressed="true"');
  });

  it("an open card takes the panel's place: wider, with its own scrolling body, the tabs gone", () => {
    const html = render({ detail: OPEN, detailPresent: new Set(["c1"]) });
    expect(html).toContain("BidUniq farkındalık haftası");
    expect(html).toContain("w-[min(560px,46vw)]");
    expect(html).toContain('id="workspace-detail"');
    expect(html).toContain('data-slot="detail-pane-body"');
    expect(html).toMatch(
      /data-slot="detail-pane-body"[^>]*class="[^"]*overflow-y-auto/,
    );
    expect(html).not.toContain("BRAND-TAB");
    expect(html).not.toContain("w-[320px]");
  });

  it("also when the panel was collapsed (it is shown while a card is open, then hidden again)", () => {
    const html = render({
      collapsed: true,
      detail: OPEN,
      detailPresent: new Set(["c1"]),
    });
    expect(html).toContain('id="workspace-detail"');
  });

  it("has a close button and a titled region", () => {
    const html = render({ detail: OPEN, detailPresent: new Set(["c1"]) });
    expect(html).toContain('aria-label="Close"');
    expect(html).toContain('role="region"');
    expect(html).toContain('aria-labelledby="workspace-detail-title"');
    expect(html).toContain('id="workspace-detail-title"');
  });

  it("says so when the open card is no longer in the chat", () => {
    const gone = render({ detail: OPEN, detailPresent: new Set() });
    expect(gone).toContain("This item is no longer in the chat.");
    const here = render({ detail: OPEN, detailPresent: new Set(["c1"]) });
    expect(here).not.toContain("no longer in the chat");
  });
});

describe("WorkspaceRightPanel below the desktop breakpoint", () => {
  it("is the same drawer as before, with its own icon row (it covers the dock)", () => {
    const html = render({ isDesktop: false, collapsed: false });
    expect(panel.sheet[0]?.open).toBe(true);
    expect(panel.content[0]?.showCloseButton).toBe(true);
    expect(String(panel.content[0]?.className)).toContain("w-[390px]");
    const drawer = html.slice(html.indexOf("data-drawer"));
    expect(drawer).toContain('aria-label="Brand" aria-pressed="true"');
    expect(drawer).toContain('aria-label="Calendar" aria-pressed="false"');
    expect(drawer).toContain("BRAND-TAB");
  });

  it("keeps the dock from md up, hidden on a phone (the slim bar opens the drawer there)", () => {
    const html = render({ isDesktop: false, collapsed: true });
    expect(html).toMatch(
      /<nav aria-label="Workspace dock" class="[^"]*hidden md:flex/,
    );
  });

  it("a card opens the drawer even when the panel was collapsed, wide, with one close button of its own", () => {
    const html = render({
      isDesktop: false,
      collapsed: true,
      detail: OPEN,
      detailPresent: new Set(["c1"]),
    });
    expect(panel.sheet[0]?.open).toBe(true);
    expect(panel.content[0]?.showCloseButton).toBe(false);
    expect(String(panel.content[0]?.className)).toContain(
      "data-[side=right]:w-full",
    );
    expect(html).toContain("BidUniq farkındalık haftası");
    expect(html).toContain('id="workspace-detail"');
    expect(html).not.toContain("BRAND-TAB");
  });

  it("closing the drawer while a card is open closes the card, not the panel", () => {
    const closeDetail = vi.fn();
    const toggle = vi.fn();
    render({
      isDesktop: false,
      collapsed: false,
      detail: OPEN,
      closeDetail,
      toggle,
      detailPresent: new Set(["c1"]),
    });
    (panel.sheet[0]?.onOpenChange as (open: boolean) => void)(false);
    expect(closeDetail).toHaveBeenCalledTimes(1);
    expect(toggle).not.toHaveBeenCalled();
  });

  it("closing the drawer with no card open toggles the panel, as before", () => {
    const toggle = vi.fn();
    render({ isDesktop: false, collapsed: false, toggle });
    (panel.sheet[0]?.onOpenChange as (open: boolean) => void)(false);
    expect(toggle).toHaveBeenCalledTimes(1);
  });
});

describe("dockPanelAction (Photoshop's dock)", () => {
  it("opens the panel on the icon picked while it is closed or a card has its place", () => {
    for (const state of [
      { collapsed: true, detailOpen: false },
      { collapsed: false, detailOpen: true },
      { collapsed: true, detailOpen: true },
    ]) {
      expect(
        dockPanelAction({ ...state, current: "brand", picked: "brand" }),
      ).toBe("open");
    }
  });

  it("closes it when the icon is the panel on show, else switches", () => {
    const open = { collapsed: false, detailOpen: false };
    expect(
      dockPanelAction({ ...open, current: "brand", picked: "brand" }),
    ).toBe("close");
    expect(
      dockPanelAction({ ...open, current: "brand", picked: "files" }),
    ).toBe("switch");
  });
});

describe("DetailPane", () => {
  const keyEvent = (key: string, inside = true) => {
    const stop = vi.fn();
    const target = {};
    return {
      event: {
        key,
        stopPropagation: stop,
        target,
        currentTarget: { contains: () => inside },
      },
      stop,
    };
  };

  it("closes on Escape, and only on Escape", () => {
    const onClose = vi.fn();
    const handler = closeOnEscape(onClose);
    for (const key of ["Enter", "a", "Tab"]) handler(keyEvent(key).event);
    expect(onClose).not.toHaveBeenCalled();
    const escape = keyEvent("Escape");
    handler(escape.event);
    expect(onClose).toHaveBeenCalledTimes(1);
    // Nothing behind the pane (the composer, a page-level shortcut) sees it too.
    expect(escape.stop).toHaveBeenCalledTimes(1);
  });

  it("ignores the Escape of a dialog opened from a card (it is outside the pane's DOM)", () => {
    const onClose = vi.fn();
    const outside = keyEvent("Escape", false);
    closeOnEscape(onClose)(outside.event);
    expect(onClose).not.toHaveBeenCalled();
    expect(outside.stop).not.toHaveBeenCalled();
  });
});
