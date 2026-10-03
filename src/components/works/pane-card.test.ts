import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import type { CompactCardSpec } from "@/lib/works/compact-card";

// The workspace panel's context, and a portal that works on the server: a
// marker element around what would be rendered into the pane.
const ctx = vi.hoisted(() => ({
  value: null as unknown,
  registered: [] as string[],
  opened: [] as [string, string][],
}));
vi.mock("@/components/workspace/workspace-panel-toggle", () => ({
  useWorkspaceDetail: () => ctx.value,
}));
vi.mock("react-dom", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react-dom")>();
  const { createElement: h } = await import("react");
  return {
    ...actual,
    default: actual,
    createPortal: (children: ReactNode, container: { id: string }) =>
      h("div", { "data-portal": container.id }, children),
  };
});
// Run effects while rendering so what they tell the pane can be observed.
vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  return {
    ...actual,
    default: actual,
    useEffect: (effect: () => unknown) => {
      effect();
    },
  };
});

const { CompactCardView, PaneCard, PaneCardView } = await import("./pane-card");

const SPEC: CompactCardSpec = {
  icon: "directions",
  title: "BidUniq farkındalık haftası",
  subtitle: "3 directions · 3 posts",
  channels: ["instagram", "tiktok"],
  status: { label: "Pick a direction", tone: "waiting" },
};

type El = { type?: unknown; props?: Record<string, unknown> };
function find(node: unknown, predicate: (el: El) => boolean, out: El[] = []) {
  if (!node || typeof node !== "object") return out;
  if (Array.isArray(node)) {
    for (const child of node) find(child, predicate, out);
    return out;
  }
  const el = node as El;
  if (el.props) {
    if (predicate(el)) out.push(el);
    find(el.props.children, predicate, out);
  }
  return out;
}

const pane = (over: Record<string, unknown> = {}) => ({
  detail: null,
  detailContainer: null,
  openDetail: vi.fn(),
  closeDetail: vi.fn(),
  registerCard: (id: string) => {
    ctx.registered.push(id);
    return () => undefined;
  },
  ...over,
});

describe("CompactCardView", () => {
  const render = (open = false) =>
    renderToStaticMarkup(
      createElement(CompactCardView, {
        spec: SPEC,
        open,
        onOpen: () => undefined,
      }),
    );

  it("is one card: title, what is inside, where it stands", () => {
    const html = render();
    expect(html).toContain("BidUniq farkındalık haftası");
    expect(html).toContain("3 directions · 3 posts");
    expect(html).toContain("Pick a direction");
    expect(html.match(/<button/g)).toHaveLength(1);
  });

  it("shows each channel it is for as that platform's brand mark", () => {
    const html = render();
    expect(html).toContain("data-card-channels");
    expect(html).toContain('aria-label="Instagram"');
    expect(html).toContain('aria-label="TikTok"');
    const without = renderToStaticMarkup(
      createElement(CompactCardView, {
        spec: { ...SPEC, channels: undefined },
        open: false,
        onOpen: () => undefined,
      }),
    );
    expect(without).not.toContain("data-card-channels");
  });

  it("is a button that says whether its card is open, and which region it opens", () => {
    expect(render(false)).toContain('aria-expanded="false"');
    expect(render(true)).toContain('aria-expanded="true"');
    // The region it controls exists only while a card is open.
    expect(render(true)).toContain('aria-controls="workspace-detail"');
    expect(render(false)).not.toContain("aria-controls");
  });

  it("without a status it shows none, and a tap opens", () => {
    const onOpen = vi.fn();
    const noStatus = { ...SPEC, status: undefined };
    const html = renderToStaticMarkup(
      createElement(CompactCardView, { spec: noStatus, open: false, onOpen }),
    );
    expect(html).not.toContain("Pick a direction");
    const tree = CompactCardView({ spec: SPEC, open: false, onOpen });
    (tree as { props: { onClick: () => void } }).props.onClick();
    expect(onOpen).toHaveBeenCalledTimes(1);
  });
});

describe("PaneCardView", () => {
  const FULL = createElement("section", { id: "full-card" }, "the whole card");
  const view = (p: unknown) =>
    renderToStaticMarkup(
      createElement(
        PaneCardView,
        { pane: p as never, cardId: "c1", spec: SPEC },
        FULL,
      ),
    );

  it("without a pane (any page but the project's chat) shows the whole card in the chat", () => {
    const html = view(null);
    expect(html).toContain("the whole card");
    expect(html).not.toContain("data-card-compact");
  });

  it("with a pane shows the compact card and keeps the whole card out of the chat", () => {
    const html = view(pane());
    expect(html).toContain("data-card-compact");
    expect(html).not.toContain("the whole card");
  });

  it("another card being open changes nothing here", () => {
    const html = view(
      pane({
        detail: { id: "c2", title: "Other" },
        detailContainer: { id: "pane" },
      }),
    );
    expect(html).toContain("data-card-compact");
    expect(html).not.toContain("the whole card");
    expect(html).toContain('aria-expanded="false"');
  });

  it("when it is the open one, its whole card is rendered into the pane", () => {
    const html = view(
      pane({
        detail: { id: "c1", title: SPEC.title },
        detailContainer: { id: "pane" },
      }),
    );
    expect(html).toContain('aria-expanded="true"');
    expect(html).toContain(
      '<div data-portal="pane"><section id="full-card">the whole card</section></div>',
    );
  });

  it("open but the pane's element is not there yet (first render, mobile drawer opening): nothing is rendered into it", () => {
    const html = view(
      pane({ detail: { id: "c1", title: SPEC.title }, detailContainer: null }),
    );
    expect(html).not.toContain("the whole card");
    expect(html).not.toContain("data-portal");
  });

  it("a tap opens this card in the pane with its title", () => {
    const p = pane();
    const tree = PaneCardView({
      pane: p,
      cardId: "c1",
      spec: SPEC,
      children: FULL,
    });
    const compact = find(tree, (el) => el.type === CompactCardView);
    expect(compact).toHaveLength(1);
    (compact[0]?.props?.onOpen as () => void)();
    expect(p.openDetail).toHaveBeenCalledWith("c1", SPEC.title);
  });
});

describe("PaneCard (the hooks around it)", () => {
  const render = (p: unknown) => {
    ctx.value = p;
    ctx.registered = [];
    return renderToStaticMarkup(
      createElement(
        PaneCard,
        { cardId: "c1", spec: SPEC },
        createElement("section", null, "the whole card"),
      ),
    );
  };

  it("announces itself to the pane while it is in the chat", () => {
    render(pane());
    expect(ctx.registered).toEqual(["c1"]);
  });

  it("tells the pane its current title while it is the open one (it changes in place)", () => {
    const p = pane({ detail: { id: "c1", title: "Old title" } });
    render(p);
    expect(p.openDetail).toHaveBeenCalledWith("c1", SPEC.title);
  });

  it("does not touch the pane's title while it is not the open one", () => {
    const p = pane({ detail: { id: "c2", title: "Other" } });
    render(p);
    expect(p.openDetail).not.toHaveBeenCalled();
  });

  it("without a pane shows the whole card and registers nothing", () => {
    const html = render(null);
    expect(html).toContain("the whole card");
    expect(ctx.registered).toEqual([]);
  });
});
