import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import type { ReportData } from "@/lib/module-flows/analytics/report";
import type { ModuleFlowCardData } from "@/lib/module-flows/card";

// What this suite proves: the Analytics card renders every step of its flow
// from the stored data (the stepper on the right step, the step's body, ONE
// primary button), says why a button can't be used, and shows a built report
// as tiles, lists, reasons and the summary.

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }),
}));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock("@/server/actions/analytics-flow-actions", () => ({
  analyticsSourcesAction: vi.fn(() => new Promise(() => undefined)),
  saveAnalyticsBriefAction: vi.fn(),
  openAnalyticsStepAction: vi.fn(),
  buildAnalyticsReportAction: vi.fn(),
  markAnalyticsSharedAction: vi.fn(),
}));

const { AnalyticsFlow } = await import("./analytics-flow");
const { WorkCardHostProvider } =
  await import("@/components/works/work-card-host");

import type { WorkCardHostInput } from "@/components/works/work-card-host";

const HOST: WorkCardHostInput = {
  projectId: "proj-1",
  projectName: "Biduniq",
  workId: "w1",
  workTitle: "Analytics",
  active: true,
  busy: false,
  producing: new Set<string>(),
  channels: [],
  timezone: "Europe/Istanbul",
  openTab: () => undefined,
  runNextStep: () => undefined,
};

function render(
  step: ModuleFlowCardData["step"],
  data: Record<string, unknown>,
  host: WorkCardHostInput = HOST,
): string {
  const card: ModuleFlowCardData = {
    kind: "module-flow",
    module: "analytics",
    title: "Analytics",
    step,
    data,
  };
  return renderToStaticMarkup(
    createElement(
      WorkCardHostProvider,
      { value: host },
      createElement(AnalyticsFlow, { card, commandId: "c1" }),
    ),
  );
}

// The step the stepper marks current, by its circle's number.
function currentStep(html: string): string | undefined {
  return /aria-current="step"[^>]*><span[^>]*>(\d)<\/span>/.exec(html)?.[1];
}

function stepRegion(html: string): string | undefined {
  return /role="group" aria-label="([^"]+)"/.exec(html)?.[1];
}

const report: ReportData = {
  period: 28,
  builtAt: "2026-10-05T11:32:00.000Z",
  sections: [
    {
      source: "instagram",
      ok: true,
      account: "@biduniq",
      days: 28,
      currency: null,
      metrics: [
        { key: "ig.reach", value: 12345 },
        { key: "ig.views", value: 2_500_000 },
        { key: "ig.followers", value: 980 },
      ],
      results: [],
      campaigns: [],
      queries: [],
    },
    {
      source: "metaAds",
      ok: true,
      account: "Biduniq Ads",
      days: 28,
      currency: "TRY",
      metrics: [{ key: "ads.spend", value: 1500.5 }],
      results: [{ label: "Leads", count: 30, costPerResult: 30 }],
      campaigns: [
        {
          name: "Spring leads",
          spend: 900,
          resultLabel: "Leads",
          results: 30,
          costPerResult: 30,
        },
      ],
      queries: [],
    },
    { source: "ga4", ok: false, reason: "expired" },
  ],
  summary: {
    headline: "Leads cost 30 TRY each.",
    highlights: ["Reach hit 12,345."],
    watchouts: ["Google Analytics needs a reconnect."],
    nextSteps: ["Keep the leads campaign running."],
  },
  summaryNote: null,
};

const flow = {
  period: 28,
  sources: ["instagram", "metaAds", "ga4"],
  sections: ["instagram", "metaAds", "ga4"],
};

describe("AnalyticsFlow", () => {
  it("Brief: the period and the sources, checked live, with Continue held until then", () => {
    const html = render("brief", {});
    expect(html).toContain('aria-label="Analytics steps"');
    expect(currentStep(html)).toBe("1");
    expect(stepRegion(html)).toBe("Brief");
    expect(html).toContain("Last 7 days");
    expect(html).toMatch(/aria-pressed="true"[^>]*>Last 28 days</);
    expect(html).toContain("Last 90 days");
    expect(html).toContain("Checking your connections…");
    expect(html).toMatch(/aria-disabled="true"[^>]*>Continue</);
    // The card says what the module is before the brief is saved.
    expect(html).toContain(
      "See how your channels perform in one clear report.",
    );
  });

  it("Plan: one switch per source with what it shows, then Build report", () => {
    const html = render("plan", {
      period: 90,
      sources: ["instagram", "ga4"],
      sections: ["instagram"],
    });
    expect(currentStep(html)).toBe("2");
    expect(html).toContain("Last 90 days · Instagram, Google Analytics");
    expect(html).toContain(
      "Reach, views, accounts engaged, interactions and followers.",
    );
    expect(html).toContain("Instagram gives at most 30 days at a time.");
    expect(html).toContain("Active users, new users, sessions");
    expect(html.match(/role="switch"/g)).toHaveLength(2);
    expect(html).toMatch(
      /aria-checked="true"[^>]*aria-label="Include Instagram"|aria-label="Include Instagram"[^>]*aria-checked="true"/,
    );
    expect(html).toContain(
      "Then a short AI summary that only uses these numbers.",
    );
    expect(html).toMatch(/data-emphasis="primary"[^>]*>Build report</);
    expect(html).toContain(">Back<");
  });

  it("Create: the build in the open, or a stopped build to try again", () => {
    const running = render("create", {
      ...flow,
      build: {
        id: "b1",
        startedAt: new Date(Date.now() - 30_000).toISOString(),
        from: "plan",
      },
    });
    expect(currentStep(running)).toBe("3");
    expect(running).toContain("Building your report…");
    expect(running).toContain("Reading Instagram");
    expect(running).toContain("Reading Meta Ads");
    expect(running).toContain("Writing the summary");
    expect(running).not.toContain('data-emphasis="primary"');

    const stopped = render("create", {
      ...flow,
      build: {
        id: "b1",
        startedAt: new Date(Date.now() - 60 * 60_000).toISOString(),
        from: "plan",
      },
    });
    expect(stopped).toContain("This build stopped before it finished.");
    expect(stopped).toMatch(/data-emphasis="primary"[^>]*>Try again</);
  });

  it("Review: the summary, KPI tiles per source, a failed source's reason, then Share", () => {
    const html = render("review", { ...flow, report });
    expect(currentStep(html)).toBe("4");
    expect(html).toContain("Leads cost 30 TRY each.");
    expect(html).toContain("What went well");
    expect(html).toContain("Reach hit 12,345.");
    expect(html).toContain("Watch out");
    expect(html).toContain("Next steps");
    // Tiles: value, label, the period beside the source.
    expect(html).toContain(">12,345<");
    expect(html).toContain(">2.5M<");
    expect(html).toContain("Followers · Now");
    expect(html).toContain("Instagram");
    expect(html).toContain(" · @biduniq");
    expect(html).toContain("Last 28 days");
    expect(html).toContain(">1,500.50 TRY<");
    expect(html).toContain("Top campaigns");
    expect(html).toContain("Spring leads");
    expect(html).toContain("30 TRY each");
    // The failed source says why and where to fix it.
    expect(html).toContain("The connection expired. Reconnect it.");
    expect(html).toContain('href="/projects/proj-1/integrations"');
    expect(html).toContain("Built 5 Oct 2026, 14:32");
    expect(html).toMatch(/data-emphasis="primary"[^>]*>.*Share</);
    expect(html).toContain("Rebuild");
  });

  it("Review: nothing to share without numbers, and the summary's absence explained", () => {
    const html = render("review", {
      ...flow,
      report: {
        ...report,
        sections: [report.sections[2]],
        summary: null,
        summaryNote:
          "No source returned numbers, so there is nothing to summarize.",
      },
    });
    expect(html).toContain(
      "No source returned numbers, so there is nothing to summarize.",
    );
    expect(html).toContain("Nothing to share yet: no source returned numbers.");
    expect(html).toMatch(
      /data-emphasis="primary"[^>]*aria-disabled="true"|aria-disabled="true"[^>]*data-emphasis="primary"/,
    );
  });

  it("Share: the report stays readable with its three ways out, and shows Shared once shared", () => {
    const html = render("deliver", { ...flow, report });
    expect(currentStep(html)).toBe("5");
    expect(stepRegion(html)).toBe("Share");
    expect(html).toContain("Leads cost 30 TRY each.");
    expect(html).toContain("Copy summary");
    expect(html).toContain("Download Markdown");
    expect(html).toMatch(
      /data-emphasis="primary"[^>]*>.*Print \/ Save as PDF</,
    );
    expect(html).not.toContain(">Shared<");

    const shared = render("deliver", {
      ...flow,
      report,
      sharedAt: "2026-10-05T12:00:00.000Z",
    });
    expect(shared).toContain(">Shared<");
    // Every step done, none current.
    expect(currentStep(shared)).toBeUndefined();
    expect(shared.match(/, done/g)).toHaveLength(5);
  });

  it("says why nothing can change in a completed Work", () => {
    const html = render("plan", flow, { ...HOST, active: false });
    expect(html).toContain("This Work is completed. Reopen it to continue.");
    expect(html).toMatch(/aria-disabled="true"[^>]*>Build report</);
  });

  it("never trusts the stored data: garbage still renders a way back", () => {
    const html = render("review", { report: "nope", sources: 7, period: "x" });
    expect(html).toContain("This report can&#x27;t be shown. Build it again.");
    expect(html).toContain("Pick the sources in the brief first.");
    expect(html).toMatch(/aria-disabled="true"[^>]*>Build report</);
  });
});
