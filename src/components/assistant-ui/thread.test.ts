import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

// thread.tsx pulls in the whole assistant-ui runtime; only its pure helpers
// are under test, so the neighbours are stubbed.
vi.mock("next/navigation", () => ({ useParams: () => ({}) }));
vi.mock("@assistant-ui/react", () => ({}));
vi.mock("@/components/assistant-ui/follow-up-suggestions", () => ({}));
vi.mock("@/components/assistant-ui/image-generation-preview", () => ({}));
vi.mock("@/components/assistant-ui/markdown-text", () => ({}));
vi.mock("@/components/commands/idea-event-card", () => ({}));
vi.mock("@/components/assistant-ui/tool-fallback", () => ({}));
vi.mock("@/components/assistant-ui/tooltip-icon-button", () => ({}));

const { pendingHintOf, showsActionBar, showsPendingCard } = await import(
  "./thread"
);
const { PendingCard } = await import("@/components/works/pending-card");

describe("showsActionBar", () => {
  it("hides the bar only for a card-only message", () => {
    expect(showsActionBar({ cardOnly: true })).toBe(false);
    expect(showsActionBar({ cardOnly: false })).toBe(true);
    expect(showsActionBar({})).toBe(true);
    expect(showsActionBar({ cardOnly: "yes" })).toBe(true);
  });
});

describe("showsPendingCard", () => {
  it("shows the skeleton only with a hint and neither card nor text", () => {
    expect(showsPendingCard({ pendingHint: "plan" }, false, false)).toBe(true);
    expect(showsPendingCard({ pendingHint: "plan" }, true, false)).toBe(false);
    expect(showsPendingCard({ pendingHint: "plan" }, false, true)).toBe(false);
    expect(showsPendingCard({}, false, false)).toBe(false);
    expect(showsPendingCard({ pendingHint: "other" }, false, false)).toBe(
      false,
    );
  });

  it("reads only the three known hints", () => {
    expect(pendingHintOf({ pendingHint: "ideas" })).toBe("ideas");
    expect(pendingHintOf({ pendingHint: "generic" })).toBe("generic");
    expect(pendingHintOf({ pendingHint: 3 })).toBeNull();
    expect(pendingHintOf({})).toBeNull();
  });

  it("the skeleton renders busy", () => {
    const html = renderToStaticMarkup(
      createElement(PendingCard, { hint: "plan" }),
    );
    expect(html).toContain('aria-busy="true"');
  });
});
