import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import type { An3Evidence } from "@/lib/website-analytics/analysis/types";
import type {
  GaFindingView,
  WebsiteInsightsView,
} from "@/lib/website-analytics/analysis/view-types";

// Bu dosyanın kanıtladığı (GA-F4 "Insights" bölümü): boş durum metinleri;
// canlı OPEN satırda Accept/Dismiss, kabul edilmiş değerlendirilebilir satırda
// Mark done; DONE satırında ölçüm metni; inceleme modunda Useful/Not useful
// ve Shadow çipi; açıklama ve Preliminary çipi. Sunucu eylemleri ve
// ActionForm taklit edilir.

vi.mock("@/server/actions/website-insights-actions", () => ({
  acceptGaFindingAction: vi.fn(),
  dismissGaFindingAction: vi.fn(),
  markGaFindingDoneAction: vi.fn(),
  reviewGaFindingAction: vi.fn(),
}));

// ActionForm geçirgen: başarı mesajını ve eylem adını işaretler.
vi.mock("@/components/shared/action-form", () => ({
  ActionForm: ({
    action,
    successMessage,
    children,
  }: {
    action: { getMockName?: () => string };
    successMessage?: string;
    children: ReactNode;
  }) =>
    createElement(
      "form",
      {
        "data-success": successMessage,
        "data-action": action?.getMockName?.() ?? "",
      },
      children,
    ),
}));

const { WebsiteInsights } = await import("./website-insights");
const actions = await import("@/server/actions/website-insights-actions");
vi.mocked(actions.acceptGaFindingAction).mockName("accept");
vi.mocked(actions.dismissGaFindingAction).mockName("dismiss");
vi.mocked(actions.markGaFindingDoneAction).mockName("done");
vi.mocked(actions.reviewGaFindingAction).mockName("review");

const EVIDENCE: An3Evidence = {
  v: 1,
  rule: "AN3",
  variant: "cro",
  window: { from: "2026-09-07", to: "2026-10-04" },
  page: "/pricing",
  sessions: 1200,
  keyEvents: 6,
  rate: 0.005,
  restSessions: 18000,
  restKeyEvents: 600,
  restRate: 0.0333,
  ratio: 0.15,
  threshold: 0.5,
  p: 0.001,
  bhAccepted: true,
  excludedDays: [],
  holidays: [],
};

function finding(patch: Partial<GaFindingView> = {}): GaFindingView {
  return {
    id: "f1",
    ruleKey: "AN3",
    kind: "OPPORTUNITY",
    subject: "page:/pricing",
    subjectLabel: "/pricing",
    period: {
      grain: "WINDOW28",
      from: "2026-09-07",
      to: "2026-10-04",
      key: "2026-W40:28d",
    },
    severity: "WARN",
    confidence: "SIGNIFICANT",
    status: "OPEN",
    mode: "live",
    priority: 1,
    evidence: EVIDENCE,
    impact: {
      metric: "keyEvents",
      perWeek: 8,
      low: 6,
      high: 10,
      directional: false,
    },
    explanation: null,
    occurrences: 1,
    evaluable: true,
    preliminary: false,
    createdAt: "2026-10-06T08:00:00.000Z",
    acceptedAt: null,
    doneAt: null,
    evaluateAfter: null,
    evaluatedAt: null,
    outcome: null,
    reviewVerdict: null,
    ...patch,
  };
}

function insights(
  patch: Partial<WebsiteInsightsView> = {},
): WebsiteInsightsView {
  return {
    review: false,
    timeZone: "Europe/Skopje",
    currency: "EUR",
    changed: [],
    opportunities: [],
    inProgress: [],
    ...patch,
  };
}

const render = (value: WebsiteInsightsView) =>
  renderToStaticMarkup(
    createElement(WebsiteInsights, { projectId: "proj-1", view: value }),
  );

const text = (html: string) =>
  html
    .replace(/<!-- -->/g, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&#x27;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ");

describe("WebsiteInsights", () => {
  it("shows both empty states", () => {
    const html = render(insights());
    expect(html).toContain('id="insights"');
    const body = text(html);
    expect(body).toContain("Insights");
    expect(body).toContain("What changed");
    expect(body).toContain(
      "Nothing unusual lately. We check every day and every Monday.",
    );
    expect(body).toContain(
      "No opportunities right now. We look again every Monday.",
    );
    expect(body).not.toContain("Review mode");
  });

  it("shows Accept and Dismiss on an open live finding", () => {
    const html = render(insights({ opportunities: [finding()] }));
    expect(html).toContain('id="finding-f1"');
    expect(html).toContain('data-action="accept"');
    expect(html).toContain('data-success="Accepted"');
    expect(html).toContain('data-action="dismiss"');
    expect(html).toContain('data-success="Dismissed"');
    expect(html).not.toContain('data-action="done"');
    expect(html).not.toContain('data-action="review"');
    expect(html).toContain('name="projectId" value="proj-1"');
    expect(html).toContain('name="findingId" value="f1"');
    expect(html).toContain(
      'aria-label="Accept: /pricing gets visits but few key events"',
    );
    expect(html).toContain('title="Passed the statistical check"');
    const body = text(html);
    expect(body).toContain("/pricing gets visits but few key events");
    expect(body).toContain("Significant");
    expect(body).toContain("Sep 7 – Oct 4, 2026");
    expect(body).toContain(
      "About +8 key events a week if this page converted like the rest of the site",
    );
    expect(body).not.toContain("Shadow");
  });

  it("shows Mark done on an accepted evaluable finding", () => {
    const html = render(
      insights({
        inProgress: [finding({ status: "ACCEPTED" })],
      }),
    );
    expect(html).toContain('data-action="done"');
    expect(html).toContain('data-action="dismiss"');
    expect(html).not.toContain('data-action="accept"');
    const body = text(html);
    expect(body).toContain("In progress");
    expect(body).toContain("Accepted — mark it done when the change is live");
  });

  it("shows the measuring text on a done finding", () => {
    const html = render(
      insights({
        inProgress: [
          finding({
            status: "DONE",
            doneAt: "2026-10-06T08:00:00.000Z",
            evaluateAfter: "2026-11-11T08:00:00.000Z",
          }),
        ],
      }),
    );
    expect(text(html)).toContain("Measuring results until Nov 11");
    expect(html).not.toContain('data-action="done"');
    expect(html).not.toContain('data-action="accept"');
  });

  it("shows review buttons and the Shadow chip in review mode", () => {
    const html = render(
      insights({
        review: true,
        changed: [
          finding({ id: "s1", mode: "shadow", reviewVerdict: "USEFUL" }),
        ],
      }),
    );
    const body = text(html);
    expect(body).toContain(
      "Review mode: shadow findings are visible only to you. Mark each one useful or not.",
    );
    expect(body).toContain("Shadow");
    expect(body).toContain("Marked useful");
    expect(html).toContain('data-action="review"');
    expect(html).toContain('name="verdict" value="USEFUL"');
    expect(html).toContain('name="verdict" value="NOT_USEFUL"');
    expect(html).toContain('aria-label="Not useful: /pricing gets visits');
    // Gölge satırda kullanıcı eylemi yok.
    expect(html).not.toContain('data-action="accept"');
  });

  it("renders the explanation and the Preliminary chip", () => {
    const html = render(
      insights({
        changed: [
          finding({
            explanation: "Most visitors leave before the form.",
            preliminary: true,
            confidence: "DIRECTIONAL",
          }),
        ],
      }),
    );
    const body = text(html);
    expect(body).toContain("Summary");
    expect(body).toContain("Most visitors leave before the form.");
    expect(body).toContain("Preliminary");
    expect(body).toContain("Directional");
    expect(html).toContain(
      'title="Google Analytics may still update these days"',
    );
    expect(html).toContain('title="A likely pattern, not proven"');
  });
});
