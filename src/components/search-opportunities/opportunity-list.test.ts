import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import type {
  OpportunitiesPanel,
  OpportunityItem,
} from "@/server/seo/opportunities/panel";

// Bu dosyanın kanıtladığı (SC-F4 Opportunities görünümü): satırda başlık,
// özet, çipler, kanıt tablosu ve gizli projectId/findingId taşıyan Accept /
// Dismiss / Mark done formları; vurgulanan satır halkalı; boş liste mesajı;
// gölge incelemede Useful / Not useful ve mevcut karar.

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }),
}));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock("@/components/search-actions/fix-this-button", () => ({
  FixThisButton: ({
    findingId,
    existing,
  }: {
    findingId: string;
    existing: { statusLabel: string } | null;
  }) =>
    createElement(
      "span",
      { "data-fix-this": findingId },
      existing ? `Open fix · ${existing.statusLabel}` : "Fix this",
    ),
}));
vi.mock("@/server/actions/search-opportunity-actions", () => ({
  acceptOpportunityAction: vi.fn(),
  dismissOpportunityAction: vi.fn(),
  markOpportunityDoneAction: vi.fn(),
  reviewShadowFindingAction: vi.fn(),
}));

const { OpportunityListView } = await import("./opportunity-list");
const { ShadowReview } = await import("./shadow-review");

const NOW = new Date("2026-10-07T10:00:00.000Z");

function item(overrides: Partial<OpportunityItem> = {}): OpportunityItem {
  return {
    id: "f-1",
    ruleKey: "SO1_STRIKING_DISTANCE",
    kind: "OPPORTUNITY",
    status: "OPEN",
    severity: "INFO",
    confidence: "SIGNIFICANT",
    effort: "S",
    actionKind: "TITLE_META",
    impact: { kind: "clicks", perMonth: 120, low: 84, high: 156 },
    priority: 120,
    title: "Push “running shoes” onto page one",
    summary: "It ranks 8.4 with 3,400 impressions a month.",
    explanation: "Moving to position 4 could double its clicks.",
    evidence: {
      window: { from: "2026-08-31", to: "2026-09-27" },
      metrics: { impressions: 3400 },
      queries: [
        {
          queryId: "q-1",
          text: "running shoes",
          clicks: 40,
          impressions: 3400,
          position: 8.44,
        },
      ],
      pages: [
        {
          pageId: "page-1",
          path: "/shoes/running",
          url: null,
          clicks: 40,
          impressions: 5100,
          position: 9,
        },
      ],
    },
    periodStart: "2026-08-31",
    periodEnd: "2026-09-27",
    periodKey: "W:2026-09-27",
    pageId: "page-1",
    queryId: "q-1",
    clusterId: null,
    keyword: "running shoes",
    ideaIds: [],
    signalId: null,
    shadow: false,
    review: null,
    createdAt: NOW,
    lastSeenAt: NOW,
    actionLabel: "Fix the snippet",
    impactLabel: "Expected +120 clicks/month",
    confidenceLabel: "Solid",
    effortLabel: "Quick fix",
    highlighted: false,
    ...overrides,
  };
}

function panel(
  overrides: Partial<OpportunitiesPanel> = {},
): OpportunitiesPanel {
  return {
    projectId: "proj-1",
    mode: "on",
    state: "ready",
    week: "2026-09-21",
    lastRunAt: NOW,
    items: [item()],
    accepted: [
      item({
        id: "f-9",
        status: "ACCEPTED",
        title: "Refresh the guide page",
        explanation: null,
      }),
    ],
    shadowReview: null,
    counts: { open: 1, accepted: 1, done30d: 0 },
    notes: [],
    ...overrides,
  };
}

const render = (value: OpportunitiesPanel) =>
  renderToStaticMarkup(createElement(OpportunityListView, { panel: value }));

describe("OpportunityListView", () => {
  it("shows Fix this only with the fixThis prop and only for fixable kinds (SC-F6)", () => {
    const value = panel({
      accepted: [item({ id: "f-9", actionKind: "INVESTIGATE", status: "ACCEPTED" })],
    });
    expect(render(value)).not.toContain("data-fix-this");
    const html = renderToStaticMarkup(
      createElement(OpportunityListView, {
        panel: value,
        fixThis: {
          "f-1": {
            actionId: "a-1",
            status: "ACCEPTED",
            statusLabel: "To do",
            href: "/projects/proj-1?work=seofix_a-1",
          },
        },
      }),
    );
    expect(html).toContain('data-fix-this="f-1"');
    expect(html).toContain("Open fix · To do");
    // INVESTIGATE bulgusunda düğme yoktur.
    expect(html).not.toContain('data-fix-this="f-9"');
  });

  it("shows each opportunity with its chips, evidence and forms", () => {
    const html = render(panel());
    expect(html).toContain(">Opportunities</h2>");
    expect(html).toContain("From your Search Console data · week of Sep 21");
    expect(html).toContain("Push “running shoes” onto page one");
    expect(html).toContain("It ranks 8.4 with 3,400 impressions a month.");
    for (const chip of [
      "Expected +120 clicks/month",
      "Solid",
      "Quick fix",
      "Fix the snippet",
    ]) {
      expect(html).toContain(`>${chip}</span>`);
    }
    expect(html).toContain("Why this matters");
    expect(html).toContain("Moving to position 4 could double its clicks.");
    // Kanıt tablosu: sorgu ve sayfa, gösterim ve ortalama sıra.
    expect(html).toContain(">running shoes</td>");
    expect(html).toContain(">/shoes/running</td>");
    expect(html).toContain(">3,400</td>");
    expect(html).toContain(">8.4</td>");
    // Formlar gizli kimlikleri taşır.
    expect(html).toContain(
      '<input type="hidden" name="projectId" value="proj-1"/>',
    );
    expect(html).toContain(
      '<input type="hidden" name="findingId" value="f-1"/>',
    );
    expect(html).toContain(
      '<input type="hidden" name="findingId" value="f-9"/>',
    );
    expect(html).toContain(">Accept</button>");
    expect(html).toContain(">Dismiss</button>");
    expect(html).toContain(">Mark done</button>");
    for (const reason of [
      ">Not relevant<",
      ">Already done<",
      ">Data looks wrong<",
      ">Not now<",
    ]) {
      expect(html).toContain(reason);
    }
    expect(html).toContain('name="reason"');
    // Kabul edilen alt liste.
    expect(html).toContain(">Accepted</h3>");
    expect(html).toContain("Refresh the guide page");
  });

  it("offers Mark done only on accepted rows", () => {
    const html = render(panel({ accepted: [] }));
    expect(html).toContain(">Accept</button>");
    expect(html).not.toContain(">Mark done</button>");
    expect(html).not.toContain(">Accepted</h3>");
  });

  it("rings the highlighted row and opens its explanation", () => {
    const html = render(panel({ items: [item({ highlighted: true })] }));
    expect(html).toMatch(
      /id="opportunity-f-1"[^>]*data-highlighted="true"[^>]*class="[^"]*ring-2 ring-primary/,
    );
    expect(html).toMatch(/<details[^>]*open=""/);
  });

  it("says when there are no opportunities, with the data note", () => {
    const html = render(
      panel({
        items: [],
        accepted: [],
        state: "collecting",
        week: null,
        notes: [
          "We need four complete weeks of Search Console data before we suggest opportunities.",
        ],
      }),
    );
    expect(html).toContain("No opportunities this week.");
    expect(html).toContain(
      "We need four complete weeks of Search Console data before we suggest opportunities.",
    );
    expect(html).not.toContain("week of");
    expect(html).not.toContain(">Accept</button>");
  });
});

describe("ShadowReview", () => {
  it("lets an operator mark findings and shows the current verdict", () => {
    const html = renderToStaticMarkup(
      createElement(ShadowReview, {
        panel: panel({
          mode: "shadow",
          items: [],
          accepted: [],
          shadowReview: [
            item({ shadow: true, review: "USEFUL" }),
            item({ id: "f-2", shadow: true }),
          ],
        }),
      }),
    );
    expect(html).toContain("Shadow review — only platform operators see this");
    expect(html).toContain(">Useful</button>");
    expect(html).toContain(">Not useful</button>");
    expect(html).toContain(
      '<input type="hidden" name="verdict" value="USEFUL"/>',
    );
    expect(html).toContain(
      '<input type="hidden" name="verdict" value="NOT_USEFUL"/>',
    );
    expect(html).toContain("Your review: Useful");
    expect(html).toContain("Not reviewed yet");
    expect(html).not.toContain(">Accept</button>");
  });
});
