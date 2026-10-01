import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import type { StarterCard } from "@/lib/works/starter-cards";

import { StarterCardsView, STARTER_COPY } from "./starter-cards";

const CARDS: StarterCard[] = [
  {
    id: "plan-week",
    title: "Plan the week",
    reason: "Pick one of three directions.",
    primary: {
      label: "Plan it",
      action: { kind: "send", text: "Plan the week." },
    },
    secondary: {
      label: "Customize",
      action: { kind: "send", text: "Customize." },
    },
  },
  {
    id: "connect",
    title: "Connect Instagram",
    reason: "So publishing can start.",
    primary: {
      label: "Connect",
      action: { kind: "link", href: "/projects/p1/integrations" },
    },
  },
];

const render = (cards: StarterCard[], disabled = false) =>
  renderToStaticMarkup(
    createElement(StarterCardsView, {
      cards,
      disabled,
      onAct: () => undefined,
    }),
  );

describe("StarterCardsView", () => {
  it("renders the heading, the cards and their data-card attributes", () => {
    const html = render(CARDS);
    expect(html).toContain(STARTER_COPY.heading);
    expect(html).toContain('data-card="plan-week"');
    expect(html).toContain('data-card="connect"');
    expect(html).toContain("sm:grid-cols-2");
    expect(html).toContain("Pick one of three directions.");
  });

  it("uses a primary and a quiet button with 44 px targets", () => {
    const html = render(CARDS);
    expect(html).toContain('data-emphasis="primary"');
    expect(html).toContain('data-emphasis="quiet"');
    expect(html).toContain("min-h-11");
    expect(html).not.toContain("min-h-9");
  });

  it("marks buttons aria-disabled (not native) when disabled", () => {
    const html = render(CARDS, true);
    expect(html).toContain('aria-disabled="true"');
    expect(html).not.toMatch(/<button[^>]*\sdisabled[=\s>]/);
  });

  it("renders nothing for no cards", () => {
    expect(render([])).toBe("");
  });
});
