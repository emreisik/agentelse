import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import type { BigQueryCardView } from "@/server/website-analytics/bigquery/read";

// Bu dosyanın kanıtladığı (GA-F8 "BigQuery export check" kartı): her durum çizilir;
// yöneticiler formları görür, salt okunur görünümde form yoktur; servis hesabı
// e-postası yalnız kurulum ve hata durumlarında görünür; veri kümesi salt okunur
// metindir (form alanı değildir) ve tek proje alanı vardır.

const SA = "reader@agentelse.iam.gserviceaccount.com";

vi.mock("@/server/actions/bigquery-actions", () => ({
  saveBigQuerySourceAction: vi.fn(),
  removeBigQuerySourceAction: vi.fn(),
  refreshBigQuerySourceAction: vi.fn(),
}));
vi.mock("@/server/website-analytics/bigquery/read", () => ({
  loadBigQueryCard: vi.fn(),
}));
vi.mock("@/components/shared/action-form", () => ({
  ActionForm: ({
    action,
    children,
  }: {
    action: { getMockName?: () => string };
    children: ReactNode;
  }) => createElement("form", { "data-action": action?.getMockName?.() ?? "" }, children),
}));

const { BigQueryCardBody, BigQueryCard } = await import("./bigquery-card");
const actions = await import("@/server/actions/bigquery-actions");
const read = await import("@/server/website-analytics/bigquery/read");
vi.mocked(actions.saveBigQuerySourceAction).mockName("save");
vi.mocked(actions.removeBigQuerySourceAction).mockName("remove");
vi.mocked(actions.refreshBigQuerySourceAction).mockName("refresh");

function view(patch: Partial<BigQueryCardView> = {}): BigQueryCardView {
  return {
    state: "ok",
    serviceAccountEmail: SA,
    suggestedDataset: "analytics_424242",
    config: {
      gcpProjectId: "my-company-123456",
      datasetId: "analytics_424242",
      location: "EU",
    },
    lastDay: "2026-10-06",
    errorCode: null,
    compare: { level: "close", days: 28, sessionsDiffPct: 3.2, usersDiffPct: 4.1 },
    topEvents: [{ name: "page_view", count: 12000 }],
    topPages: [{ page: "/pricing", views: 900 }],
    usageBytes: 1_500_000_000,
    budgetBytes: 100_000_000_000,
    ...patch,
  };
}

function render(
  v: BigQueryCardView,
  props: { canManage?: boolean; readOnly?: boolean } = {},
) {
  return renderToStaticMarkup(
    createElement(BigQueryCardBody, {
      view: v,
      projectId: "proj1",
      linkId: "link1",
      canManage: props.canManage ?? true,
      readOnly: props.readOnly ?? false,
    }),
  );
}

const SETUP: Partial<BigQueryCardView> = {
  state: "not_set_up",
  config: null,
  lastDay: null,
  compare: null,
  topEvents: [],
  topPages: [],
  usageBytes: 0,
};

describe("states", () => {
  it("renders nothing when off", () => {
    expect(render(view({ state: "off" }))).toBe("");
  });

  it("not_configured: shows the server notice to managers only", () => {
    const v = view({ ...SETUP, state: "not_configured" });
    expect(render(v)).toContain("BigQuery isn&#x27;t set up on this Agentelse server yet.");
    expect(render(v, { canManage: false })).toBe("");
    expect(render(v)).not.toContain(SA);
  });

  it("not_set_up: explains the steps, names the service account and has one project field", () => {
    const html = render(view(SETUP));
    expect(html).toContain("BigQuery export check");
    expect(html).toContain(SA);
    expect(html).toContain("BigQuery Data Viewer");
    expect(html).toContain("BigQuery Job User");
    expect(html).toContain("Google Cloud project that holds the export");
    expect(html).toContain('data-action="save"');
    // Veri kümesi salt okunur metin; hiç form alanı değil.
    expect(html).toContain("analytics_424242");
    expect(html).not.toMatch(/name="datasetId"/);
    expect(html).not.toMatch(/name="billingProjectId"/);
    expect(html).not.toMatch(/name="datasetProjectId"/);
    expect(html.match(/<input[^>]*type="hidden"/g)).toHaveLength(2);
    expect(html.match(/name="gcpProjectId"/g)).toHaveLength(1);
  });

  it("not_set_up: nothing for non-managers and in the read-only view", () => {
    expect(render(view(SETUP), { canManage: false })).toBe("");
    expect(render(view(SETUP), { readOnly: true })).toBe("");
  });

  it("pending: shows the waiting chip and the manager buttons", () => {
    const html = render(view({ state: "pending", lastDay: null, compare: null }));
    expect(html).toContain("Waiting for the first read");
    expect(html).toContain('data-action="refresh"');
    expect(html).toContain('data-action="remove"');
    expect(html).not.toContain(SA);
  });

  it("ok close: shows the documented sentence, the tops and the budget", () => {
    const html = render(view());
    expect(html).toContain("Connected");
    expect(html).toContain("Last export day: 2026-10-06");
    expect(html).toContain(
      "Your export and the Google Analytics numbers are within 10% for the last 28 days.",
    );
    expect(html).toContain("Sessions differ by 3.2%");
    expect(html).toContain("thresholding, modeling and the property time zone");
    expect(html).toContain("Revenue is not compared");
    expect(html).toContain("page_view");
    expect(html).toContain("12,000");
    expect(html).toContain("Top 50 per day");
    expect(html).toContain("/pricing");
    expect(html).toContain("1.5 GB of 100 GB");
    expect(html).toContain('data-action="refresh"');
    expect(html).toContain('data-action="remove"');
    // Servis hesabı yalnız kurulum/hata durumlarında
    expect(html).not.toContain(SA);
  });

  it("ok differs: says the numbers differ by more than 10%", () => {
    const html = render(
      view({
        compare: { level: "differs", days: 28, sessionsDiffPct: 22, usersDiffPct: 5 },
      }),
    );
    expect(html).toContain(
      "Your export and the Google Analytics numbers differ by more than 10% for the last 28 days.",
    );
  });

  it("ok unknown: asks for more days", () => {
    const html = render(
      view({
        compare: { level: "unknown", days: 3, sessionsDiffPct: null, usersDiffPct: null },
      }),
    );
    expect(html).toContain("Not enough days to compare yet");
    expect(html).not.toContain("within 10%");
  });

  it("ok with the budget stop: says reading continues next month", () => {
    const html = render(view({ errorCode: "budget" }));
    expect(html).toContain("budget is used up");
  });

  it("error: shows the fixed message, names the service account for not_shared", () => {
    const html = render(view({ state: "error", errorCode: "not_shared", compare: null, topEvents: [], topPages: [] }));
    expect(html).toContain("Needs attention");
    expect(html).toContain(SA);
    expect(html).toContain("BigQuery Data Viewer");
    expect(html).not.toContain("Your export and the Google Analytics numbers");
    expect(html).toContain('data-action="refresh"');
  });

  it("error with an unknown stored code falls back to the unavailable message", () => {
    const html = render(view({ state: "error", errorCode: "weird", compare: null }));
    expect(html).toContain("BigQuery isn&#x27;t available right now.");
  });
});

describe("read-only and non-manager views", () => {
  it("hides every form when read-only but still shows the status", () => {
    const html = render(view(), { readOnly: true });
    expect(html).not.toContain("<form");
    expect(html).toContain("Connected");
    expect(html).toContain("Last export day");
  });

  it("hides the buttons from non-managers", () => {
    expect(render(view(), { canManage: false })).not.toContain("<form");
  });

  it("never shows the service account email outside the setup and error states", () => {
    for (const state of ["pending", "ok"] as const) {
      expect(render(view({ state }))).not.toContain(SA);
    }
  });
});

describe("BigQueryCard (async wrapper)", () => {
  it("returns null when the loader says off", async () => {
    vi.mocked(read.loadBigQueryCard).mockResolvedValue(view({ state: "off" }));
    expect(
      await BigQueryCard({ projectId: "proj1", linkId: "link1", canManage: true, readOnly: false }),
    ).toBeNull();
  });

  it("loads the view for the given property and renders it", async () => {
    vi.mocked(read.loadBigQueryCard).mockResolvedValue(view());
    const element = await BigQueryCard({
      projectId: "proj1",
      linkId: "link1",
      canManage: true,
      readOnly: false,
    });
    expect(read.loadBigQueryCard).toHaveBeenCalledWith("proj1", "link1");
    expect(renderToStaticMarkup(element as never)).toContain("BigQuery export check");
  });
});
