import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import type { StarterCard } from "@/lib/works/starter-cards";

import { StarterRowsView, STARTER_ROWS_COPY } from "./starter-rows";

const CARDS: StarterCard[] = [
  {
    id: "plan-week",
    line: "Plan the week for Instagram",
    reason: "A week of posts for Instagram.",
    action: { kind: "send", text: "Plan the week for Instagram." },
  },
  {
    id: "connect",
    line: "Connect Instagram to publish",
    reason: "Publishing starts once it is connected.",
    action: { kind: "link", href: "/projects/p1/integrations" },
  },
  {
    id: "something-new",
    line: "Something new",
    reason: "A card id the icon map does not know.",
    action: { kind: "tab", tab: "outputs" },
  },
];

const render = (cards: StarterCard[], disabled = false) =>
  renderToStaticMarkup(
    createElement(StarterRowsView, { cards, disabled, onAct: () => undefined }),
  );

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

describe("StarterRowsView", () => {
  it("is one muted line per card, with the reason as its tooltip", () => {
    const html = render(CARDS);
    expect(html.match(/<button/g)).toHaveLength(3);
    expect(html).toContain("Plan the week for Instagram");
    expect(html).toContain("Connect Instagram to publish");
    expect(html).toContain('title="A week of posts for Instagram."');
    expect(html).toContain(`aria-label="${STARTER_ROWS_COPY.groupAria}"`);
  });

  it("is not a card grid: no heading, no card buttons", () => {
    const html = render(CARDS);
    expect(html).not.toContain("What do you want to do?");
    expect(html).not.toContain("<h2");
    expect(html).not.toContain(">Plan the week<");
  });

  it("every row has an icon, also for a card the icon map does not know", () => {
    const html = render(CARDS);
    expect(html.match(/<svg/g)).toHaveLength(3);
  });

  it("a tap does what the card's main button does", () => {
    const onAct = vi.fn();
    const tree = StarterRowsView({ cards: CARDS, disabled: false, onAct });
    const buttons = find(tree, (el) => el.type === "button");
    expect(buttons).toHaveLength(3);
    buttons.forEach((button, index) => {
      (button.props?.onClick as () => void)();
      expect(onAct).toHaveBeenLastCalledWith(CARDS[index]?.action);
    });
    expect(onAct).toHaveBeenCalledTimes(3);
  });

  it("is disabled as a whole while a message is being sent", () => {
    expect(render(CARDS, true).match(/ disabled=""/g)).toHaveLength(3);
    expect(render(CARDS, false)).not.toContain(' disabled=""');
  });

  it("is a labelled list, not one more landmark region", () => {
    const html = render(CARDS);
    expect(html).not.toContain("<section");
    expect(html).toContain(
      `<ul aria-label="${STARTER_ROWS_COPY.groupAria}"`,
    );
  });

  it("a keyboard focus is as visible as a hover, and a dimmed row does not light up under the pointer", () => {
    const html = render(CARDS);
    expect(html).toContain("focus-visible:bg-[var(--ws-hover)]");
    expect(html).toContain("focus-visible:ring-ring");
    expect(html).not.toContain("ring-ring/50");
    expect(html).toContain("enabled:hover:bg-[var(--ws-hover)]");
    expect(html).not.toMatch(/(?<!enabled:)hover:bg-/);
    // A transparent outline stays where forced colours drop the ring.
    expect(html).toContain("outline-hidden");
    expect(html).not.toContain("outline-none");
  });

  it("a long sentence wraps to a second line instead of being cut off", () => {
    const html = render(CARDS);
    expect(html).toContain("line-clamp-2");
    expect(html).not.toContain("truncate");
  });

  it("renders nothing without cards", () => {
    expect(render([])).toBe("");
  });
});
