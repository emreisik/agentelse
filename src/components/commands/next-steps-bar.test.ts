import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
}));
vi.mock("sonner", () => ({
  toast: { message: vi.fn(), success: vi.fn(), error: vi.fn() },
}));
vi.mock("@/server/actions/plan-progress-actions", () => ({
  enablePlanPublishingAction: vi.fn(),
}));

const { NextStepsBar } = await import("./next-steps-bar");

import type { NextStep } from "@/lib/journey";

const step = (over: Partial<NextStep> = {}): NextStep => ({
  key: "produce",
  tone: "next",
  label: "Produce 3",
  title: "3 planned pieces have no content yet.",
  action: { kind: "produce_plan", planId: "plan-1", count: 3 },
  ...over,
});

const render = (props: Partial<Parameters<typeof NextStepsBar>[0]> = {}) =>
  renderToStaticMarkup(
    createElement(NextStepsBar, {
      steps: [step()],
      onAct: vi.fn(),
      ...props,
    }),
  );

describe("NextStepsBar", () => {
  it("renders nothing when there is nothing to advance", () => {
    expect(render({ steps: [] })).toBe("");
  });

  it("says what is next and offers it as the one big button", () => {
    const html = render();
    expect(html).toContain('aria-label="Next steps"');
    expect(html).toContain("3 planned pieces have no content yet.");
    expect(html).toContain("Produce 3");
  });

  it("shows the other steps as quick alternatives", () => {
    const html = render({
      steps: [
        step({ key: "review", label: "Review 2", title: "2 pieces are ready." }),
        step({ key: "produce" }),
        step({
          key: "connect-instagram",
          label: "Connect Instagram",
          action: { kind: "connect_channel", channel: "instagram" },
        }),
      ],
    });
    // The first step is the headline; the rest are chips.
    expect(html).toContain("2 pieces are ready.");
    expect(html).toContain("Review 2");
    expect(html).toContain(">Produce 3<");
    expect(html).toContain("Connect Instagram");
  });

  it("marks something stuck or due differently from the natural next move", () => {
    expect(render({ steps: [step({ tone: "blocker" })] })).toContain(
      "var(--destructive)",
    );
    expect(render({ steps: [step({ tone: "next" })] })).not.toContain(
      "var(--destructive)",
    );
  });

  it("waits while a run or a turn is in progress", () => {
    // The attribute, not the `disabled:` utility classes every button carries.
    const attribute = /<button[^>]*\sdisabled(=""|\s|>)/;
    expect(render({ disabled: true })).toMatch(attribute);
    expect(render({ disabled: false })).not.toMatch(attribute);
  });
});
