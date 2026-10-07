import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { funnelInsight } from "@/lib/website-analytics/funnel/insight";
import type { FunnelView } from "@/server/website-analytics/funnel/store";

// Bu dosyanın kanıtladığı (GA-F8 huni kartı): bayrak kapalıyken sorgusuz null;
// saklanan sonuçtan adım çubukları (genişlik ilk adıma göre, kullanıcı sayısı,
// "x% continue", ayrılan sayısı) ve özet cümle; sonuçsuz ve boş durumlar;
// readOnly iken form, Run ve Delete yok; oluşturma formu 6 satır çizer ve
// 5 huni dolunca gizlenir.

const mocks = vi.hoisted(() => ({ listFunnels: vi.fn() }));

vi.mock("@/server/website-analytics/funnel/store", () => ({
  GA_MAX_FUNNELS_PER_LINK: 5,
  listFunnels: mocks.listFunnels,
}));
vi.mock("@/server/actions/funnel-actions", () => ({
  saveFunnelAction: vi.fn(),
  deleteFunnelAction: vi.fn(),
  runFunnelAction: vi.fn(),
}));
vi.mock("@/components/shared/action-form", () => ({
  ActionForm: ({ children }: { children: ReactNode }) =>
    createElement("form", null, children),
}));
vi.mock("@/components/shared/submit-button", () => ({
  SubmitButton: ({ children }: { children: ReactNode }) =>
    createElement("button", { type: "submit" }, children),
}));

const { FunnelCard, FunnelCardView } = await import("./funnel-card");

const steps = [
  { name: "Visit", kind: "event" as const, value: "page_view" },
  { name: "Form", kind: "event" as const, value: "form_start" },
  { name: "Lead", kind: "page" as const, value: "/thanks" },
];

function view(overrides: Partial<FunnelView> = {}): FunnelView {
  const result = {
    through: "2026-10-06",
    steps: [
      { name: "Visit", users: 1200, completionRate: 0.25, abandonments: 900, abandonmentRate: 0.75 },
      { name: "Form", users: 300, completionRate: 0.4, abandonments: 180, abandonmentRate: 0.6 },
      { name: "Lead", users: 120, completionRate: null, abandonments: null, abandonmentRate: null },
    ],
  };
  return {
    id: "f1",
    name: "Lead funnel",
    isOpen: false,
    steps,
    periodDays: 28,
    lastRunAt: new Date("2026-10-06T10:00:00Z"),
    lastError: null,
    result,
    insight: funnelInsight(steps, result),
    ...overrides,
  };
}

const render = (funnels: FunnelView[], readOnly = false) =>
  renderToStaticMarkup(
    createElement(FunnelCardView, {
      funnels,
      projectId: "proj-1",
      linkId: "link-1",
      readOnly,
    }),
  );

beforeEach(() => {
  vi.unstubAllEnvs();
  mocks.listFunnels.mockReset();
});

describe("FunnelCard (server wrapper)", () => {
  it("returns null without any query when the flag is off", async () => {
    vi.stubEnv("GA_FUNNEL", "");
    expect(
      await FunnelCard({ projectId: "proj-1", linkId: "link-1", readOnly: false }),
    ).toBeNull();
    expect(mocks.listFunnels).not.toHaveBeenCalled();
  });

  it("loads the property's funnels when the flag is on", async () => {
    vi.stubEnv("GA_SYNC", "true");
    vi.stubEnv("GA_AGENCY", "true");
    vi.stubEnv("GA_FUNNEL", "true");
    vi.stubEnv("NODE_ENV", "test");
    mocks.listFunnels.mockResolvedValue([view()]);
    const element = await FunnelCard({
      projectId: "proj-1",
      linkId: "link-1",
      readOnly: false,
    });
    expect(mocks.listFunnels).toHaveBeenCalledWith("proj-1", "link-1");
    expect(renderToStaticMarkup(element as never)).toContain("Lead funnel");
  });
});

describe("FunnelCardView", () => {
  it("shows the header with the Beta chip", () => {
    const html = render([]);
    expect(html).toContain("Funnels");
    expect(html).toContain("Beta");
  });

  it("renders bars scaled to the first step, rates and the insight", () => {
    const html = render([view()]);
    expect(html).toContain("1,200 users");
    expect(html).toContain("300 users");
    expect(html).toContain("width:100%");
    expect(html).toContain("width:25%");
    expect(html).toContain("width:10%");
    expect(html).toContain("25% continue");
    expect(html).toContain("900 left");
    expect(html).toContain("40% continue");
    // Son adımda "continue" satırı yok.
    expect(html.match(/continue/g)).toHaveLength(2);
    expect(html).toContain("The biggest drop is between");
    expect(html).toContain("Last 28 days, through 2026-10-06.");
  });

  it("falls back to the step counts when Google gave no rates", () => {
    const plain = view();
    const result = {
      through: "2026-10-06",
      steps: plain.steps.map((step, index) => ({
        name: step.name,
        users: [200, 100, 50][index] ?? 0,
        completionRate: null,
        abandonments: null,
        abandonmentRate: null,
      })),
    };
    const html = render([{ ...plain, result, insight: funnelInsight(steps, result) }]);
    expect(html).toContain("50% continue");
    expect(html).toContain("100 left");
  });

  it("shows an empty state and a not-run-yet state", () => {
    expect(render([])).toContain("No funnels yet.");
    expect(render([view({ result: null, insight: null })])).toContain(
      "Not run yet.",
    );
    expect(
      render([view({ result: null, insight: null, lastError: "RATE_LIMIT" })]),
    ).toContain("didn&#x27;t finish");
  });

  it("offers Run, Edit, Delete and a 6-row create form to editors", () => {
    const html = render([view()]);
    expect(html).toContain("Run");
    expect(html).toContain("Edit");
    expect(html).toContain("Delete");
    expect(html).toContain("New funnel");
    expect(html).toContain("Lead");
    expect(html).toContain("Shop");
    expect(html.match(/name="step_name"/g)?.length).toBe(12);
    expect(html).toContain('name="projectId"');
  });

  it("hides every form, Run and Delete when read only", () => {
    const html = render([view()], true);
    expect(html).not.toContain("<form");
    expect(html).not.toContain("Run");
    expect(html).not.toContain("Delete");
    expect(html).not.toContain("New funnel");
    expect(html).toContain("1,200 users");
  });

  it("hides the create form at the 5-funnel limit", () => {
    const five = Array.from({ length: 5 }, (_, index) => view({ id: `f${index}` }));
    const html = render(five);
    expect(html).not.toContain("New funnel");
    expect(html).toContain("You have reached 5 funnels");
  });
});
