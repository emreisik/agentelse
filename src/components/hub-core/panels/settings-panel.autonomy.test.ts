import { createElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

// The Autonomy settings screen (billing, Faz 3C): the approval size only shows
// where it does something, a saved value outside today's range is shown inside it
// (the browser would otherwise refuse the whole form over a field the person did
// not touch), and the Unlimited Mode text says what it really lifts.

const mocks = vi.hoisted(() => ({
  policy: vi.fn(),
  entitlements: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    autonomyPolicy: { findUnique: mocks.policy },
    agencyDailyStat: {
      aggregate: vi.fn().mockResolvedValue({ _sum: { reasoningCostUsd: 1.5 } }),
    },
  },
}));
vi.mock("@/server/billing/entitlements", () => ({
  getEntitlements: mocks.entitlements,
}));
vi.mock("@/components/shared/action-form", () => ({
  ActionForm: ({ children }: { children: React.ReactNode }) =>
    createElement("form", null, children),
}));
// Everything else the file imports is for other tabs: never rendered here.
vi.mock("@/server/actions/agency-config-actions", () => ({
  updateAutonomyPolicyAction: vi.fn(),
}));
vi.mock("@/server/actions/ads-autopilot-actions", () => ({
  updateAdsAutopilotAction: vi.fn(),
  updateSpendApproversAction: vi.fn(),
}));
vi.mock("@/server/actions/publish-schedule-actions", () => ({
  updateInstagramPublishScheduleAction: vi.fn(),
}));
vi.mock("@/server/ads/autopilot", () => ({ AdsAutopilot: {} }));
vi.mock("@/server/projects/project-deletion.service", () => ({
  ProjectDeletionService: {},
}));
vi.mock("@/components/website-analytics/reports/report-settings-card", () => ({
  WebsiteReportSettingsCard: () => null,
}));
vi.mock("@/components/projects/delete-project-card", () => ({
  DeleteProjectCard: () => null,
}));
vi.mock("@/components/projects/link-tracking-card", () => ({
  LinkTrackingCard: () => null,
}));

const { SettingsPanel } = await import("./settings-panel");

type El = { type?: unknown; props?: Record<string, unknown> };

// The panel returns the tab as a (server) component element: find it and run it.
function findTab(node: unknown): El | undefined {
  if (!node || typeof node !== "object") return undefined;
  if (Array.isArray(node)) {
    for (const child of node) {
      const found = findTab(child);
      if (found) return found;
    }
    return undefined;
  }
  const el = node as El;
  if (typeof el.type === "function" && el.type.name === "AutonomyTab") {
    return el;
  }
  return findTab(el.props?.children);
}

async function render(): Promise<string> {
  const panel = await SettingsPanel({
    projectId: "p1",
    sub: "autonomy",
    entity: null,
  });
  const tab = findTab(panel);
  if (!tab) throw new Error("the Autonomy tab is not in the panel");
  const run = tab.type as (props: unknown) => Promise<ReactElement>;
  return renderToStaticMarkup(await run(tab.props));
}

const policy = (overrides: Record<string, unknown> = {}) => ({
  workspaceId: "w1",
  maxReasoningCallsPerDay: 200,
  maxActiveIdeas: 20,
  dailyBudgetUsd: null,
  approveAboveUsd: null,
  unlimitedMode: false,
  weeklyAutoProduce: false,
  autopilotMode: "SUGGEST",
  adsAutonomy: "SUGGEST",
  adsMonthlyCapMinor: null,
  adsSpendApproverIds: [],
  ...overrides,
});

const plan = (
  mode: "off" | "shadow" | "enforce",
  planKey: "starter" | "growth" | null = "starter",
) => ({ mode, unlimited: planKey === null, planKey });

// The attribute of the input with this name, from the markup.
function inputOf(markup: string, name: string): string | undefined {
  return markup.match(new RegExp(`<input[^>]*name="${name}"[^>]*>`))?.[0];
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.policy.mockResolvedValue(policy());
  mocks.entitlements.mockResolvedValue(plan("enforce"));
});

describe("the approval size field", () => {
  it("shows while billing enforces a plan", async () => {
    const markup = await render();
    expect(inputOf(markup, "approveAboveUsd")).toBeDefined();
    expect(markup).toContain("Ask me before an automatic task costs more than");
  });

  it.each([
    ["billing in shadow", plan("shadow")],
    ["billing off", plan("off", null)],
    ["no plan", plan("enforce", null)],
  ])(
    "is not shown with %s: it would do nothing",
    async (_label, entitlements) => {
      mocks.entitlements.mockResolvedValue(entitlements);

      const markup = await render();

      expect(inputOf(markup, "approveAboveUsd")).toBeUndefined();
      expect(markup).not.toContain("Ask me before an automatic task");
    },
  );
});

describe("a saved value outside today's range", () => {
  it("is shown inside it, so the browser never refuses the form over a field the person did not touch", async () => {
    // Agency's size ($12.50) left on a Starter plan (range $0.10 - $2.50), and a daily
    // budget saved before the plan's cap existed ($10 on a $3 plan).
    mocks.policy.mockResolvedValue(
      policy({ approveAboveUsd: 12.5, dailyBudgetUsd: 10 }),
    );

    const markup = await render();

    const approve = inputOf(markup, "approveAboveUsd")!;
    expect(approve).toContain('max="2.5"');
    expect(approve).toContain('value="2.5"');
    const budget = inputOf(markup, "dailyBudgetUsd")!;
    expect(budget).toContain('max="3"');
    expect(budget).toContain('value="3"');
    // The person is told, so the change is not a surprise.
    expect(markup).toContain("Your saved size was outside that range");
    expect(markup).toContain("Your saved budget was above that");
  });

  it("is left alone when it is inside the range", async () => {
    mocks.policy.mockResolvedValue(
      policy({ approveAboveUsd: 1.25, dailyBudgetUsd: 2 }),
    );

    const markup = await render();

    expect(inputOf(markup, "approveAboveUsd")).toContain('value="1.25"');
    expect(inputOf(markup, "dailyBudgetUsd")).toContain('value="2"');
    expect(markup).not.toContain("Your saved size was outside");
    expect(markup).not.toContain("Your saved budget was above");
  });

  it("keeps the step fine enough for any value the server stores (it rounds to cents)", async () => {
    const markup = await render();
    expect(inputOf(markup, "approveAboveUsd")).toContain('step="0.01"');
  });
});

describe("the Unlimited Mode text", () => {
  it("names what it lifts, and says the approval size still applies where there is one", async () => {
    const markup = await render();

    expect(markup).toContain(
      "The daily AI call limit, the idea pool size and the daily budget above are ignored",
    );
    expect(markup).toContain(
      "the size above which automatic tasks wait for your OK",
    );
    expect(markup).not.toContain("All the caps above");
  });

  it("does not talk about the approval size where the field is not shown", async () => {
    mocks.entitlements.mockResolvedValue(plan("shadow"));

    const markup = await render();

    expect(markup).toContain("daily budget above are ignored");
    expect(markup).not.toContain("the size above which");
    expect(markup).toContain("usage allowance still applies");
  });
});
