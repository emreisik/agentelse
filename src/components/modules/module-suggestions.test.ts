import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import type { ModuleKey } from "@/lib/modules/catalog";
import type { StarterCard } from "@/lib/works/starter-cards";

// The slot under a new chat's composer with modules on: tiles (plus the rows no
// module covers), nothing while a module starts, and one row for a Social Media
// Planner chat with nothing sent. Never a module's panel or Brief.

vi.mock("@assistant-ui/react", () => ({
  useAui: () => ({ composer: { setText: vi.fn() } }),
}));
vi.mock("@/server/actions/module-flow-actions", () => ({
  startModuleFlowAction: vi.fn(),
}));
vi.mock("@/server/actions/work-actions", () => ({
  setWorkModuleAction: vi.fn(),
}));

const { ModuleSuggestions, SOCIAL_START_ROW } =
  await import("./module-suggestions");
const { SOCIAL_START_MESSAGE } = await import("./use-module-choice");

const decisions: StarterCard = {
  id: "decisions",
  line: "2 decisions waiting for you",
  reason: "Approve or reject them.",
  action: { kind: "tab", tab: "outputs" },
};

const render = (module: ModuleKey | null, starting = false) =>
  renderToStaticMarkup(
    createElement(ModuleSuggestions, {
      projectId: "p1",
      module,
      starting,
      rows: [decisions],
      disabled: false,
      onChoose: vi.fn(async () => undefined),
      onAct: vi.fn(),
    }),
  );

describe("ModuleSuggestions", () => {
  it("a general new chat shows the tiles with the rows under them", () => {
    const html = render(null);
    expect(html).toContain('aria-label="Start with a module"');
    expect(html).toContain("2 decisions waiting for you");
  });

  it("nothing at all while a module starts: the chat goes on above", () => {
    for (const key of ["social", "ads", "analytics", "seo"] as const) {
      expect(render(key, true)).toBe("");
    }
  });

  it("a Social Media Planner chat with nothing sent offers its first message as one row", () => {
    const html = render("social");
    expect(html).toContain("Plan next week&#x27;s posts from my idea pool.");
    expect(html).toContain("2 decisions waiting for you");
    expect(html).not.toContain('aria-label="Start with a module"');
    expect(SOCIAL_START_ROW.action).toEqual({
      kind: "send",
      text: SOCIAL_START_MESSAGE,
    });
  });

  it("a flow module without its card shows the tiles, so a tap writes it again", () => {
    for (const key of ["ads", "analytics", "seo"] as const) {
      expect(render(key)).toContain('aria-label="Start with a module"');
    }
  });
});
