import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";

import { WEBSITE_REPORT_COPY } from "@/lib/website-analytics/reports/copy";
import {
  sampleAlertCard,
  sampleMonthlyCard,
  samplePlanCard,
  samplePulseCard,
  sampleWeeklyCard,
} from "@/lib/website-analytics/reports/test-fixtures";
import type {
  ReportFindingSnap,
  WebsiteReportCardData,
} from "@/lib/website-analytics/reports/types";

// Bu dosyanın kanıtladığı: her örnek kart başlığıyla çizilir; "Preliminary"
// yalnız ön veride çıkar; Google kaynaklı metin kaçırılır; Accept/Dismiss yalnız
// insights "on" iken OPEN bulguda; plan kartında öneri başına metricKey
// onay kutusu; uyarı kartında "Mute for 7 days" (yeniden bağlanmada
// "Reconnect", susturma yok); bozuk kart nötr satır gösterir; hiçbir şey
// çekilmez. Sunucu eylemleri ve yönlendirici taklit edilir.

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn() }),
}));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock("@/server/actions/website-report-actions", () => ({
  updateGaReportSettingsAction: vi.fn(),
  applyGaPlanTargetsAction: vi.fn(),
}));
vi.mock("@/server/actions/website-insights-actions", () => ({
  acceptGaFindingAction: vi.fn(),
  dismissGaFindingAction: vi.fn(),
  loadOpenGaFindingIdsAction: vi.fn().mockResolvedValue([]),
  markGaFindingDoneAction: vi.fn(),
  reviewGaFindingAction: vi.fn(),
}));
vi.mock("@/server/actions/measurement-health-actions", () => ({
  muteMeasurementAlertAction: vi.fn(),
  recheckMeasurementHealthAction: vi.fn(),
}));

const { WebsiteReportCard, WebsiteReportWorksCard } = await import(
  "./website-report-card"
);
const { DecisionForms } = await import("./finding-decision-buttons");

afterEach(() => {
  vi.restoreAllMocks();
});

const render = (card: WebsiteReportCardData, commandId?: string) =>
  renderToStaticMarkup(createElement(WebsiteReportCard, { card, commandId }));

function snap(partial: Partial<ReportFindingSnap> = {}): ReportFindingSnap {
  return {
    id: "finding-1",
    ruleKey: "AN3",
    list: "opportunities",
    kind: "cro",
    title: "Pricing page converts poorly",
    detail: "The page gets visits but few key events.",
    impact: null,
    confidence: "Significant",
    period: "Sep 7 – Oct 4",
    explanation: null,
    status: "OPEN",
    outcome: null,
    preliminary: false,
    href: "/projects/proj-1/site#finding-finding-1",
    ...partial,
  };
}

describe("WebsiteReportCard", () => {
  it.each([
    ["pulse", samplePulseCard],
    ["weekly", sampleWeeklyCard],
    ["monthly", sampleMonthlyCard],
    ["plan", samplePlanCard],
    ["alert", sampleAlertCard],
  ])("renders the %s sample with its title", (variant, make) => {
    const card = make();
    const html = render(card, `garep_${variant}_proj-1_x`);
    expect(html).toContain('data-card="website-report"');
    expect(html).toContain(`data-card-id="garep_${variant}_proj-1_x"`);
    expect(html).toContain(card.title.replace(/&/g, "&amp;"));
    expect(html).toContain("Sent ");
  });

  it("shows 'Preliminary' only when the card is preliminary", () => {
    const base = sampleWeeklyCard({ preliminary: false });
    expect(render(base)).not.toContain("Preliminary");
    expect(render({ ...base, preliminary: true })).toContain("Preliminary");
  });

  it("shows 'Demo data' only for mock cards", () => {
    const base = sampleWeeklyCard({ isMock: false });
    expect(render(base)).not.toContain("Demo data");
    expect(render({ ...base, isMock: true })).toContain("Demo data");
  });

  it("keeps the numbers-as-sent note in the footer", () => {
    expect(render(sampleMonthlyCard())).toContain(
      WEBSITE_REPORT_COPY.snapshotNote,
    );
  });

  it("escapes Google-sourced text", () => {
    const evil = "<script>alert(1)</script>";
    // Aylık kart ayrıntıyla açık gelir.
    const monthly = sampleMonthlyCard();
    if (monthly.body.variant !== "monthly") throw new Error("not monthly");
    const html = render({
      ...monthly,
      body: {
        ...monthly.body,
        opportunities: [snap({ title: evil, detail: evil })],
      },
    });
    // Form kullanan sayfalarda React kendi <script>'ini ekler: yalnız bizim
    // metnimizin kaçırıldığına bakılır.
    expect(html).not.toContain("<script>alert(1)");
    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
  });

  it("escapes a script label in the title", () => {
    const html = render(sampleWeeklyCard({ title: "<script>x</script>" }));
    expect(html).not.toContain("<script>x");
    expect(html).toContain("&lt;script&gt;x&lt;/script&gt;");
  });

  describe("finding decisions", () => {
    const monthlyWith = (
      insights: "on" | "off",
      findings: ReportFindingSnap[],
    ) => {
      const card = sampleMonthlyCard();
      if (card.body.variant !== "monthly") throw new Error("not monthly");
      return {
        ...card,
        body: {
          ...card.body,
          insights,
          opportunities: findings,
          whatChanged: [],
        },
      };
    };

    it("draws no buttons before the live status is known, even for an OPEN snapshot", () => {
      // Saklı kart gönderim anındaki durumu taşır: düğmeler yalnız canlı
      // denetim (istemci etkisi) bulgunun hâlâ OPEN olduğunu söyleyince çıkar.
      const html = render(monthlyWith("on", [snap()]));
      expect(html).toContain("Pricing page converts poorly");
      expect(html).not.toContain(">Accept<");
      expect(html).not.toContain(">Dismiss<");
    });

    it("draws the Accept and Dismiss forms for a finding confirmed OPEN", () => {
      const html = renderToStaticMarkup(
        createElement(DecisionForms, {
          projectId: "proj-1",
          findingId: "finding-1",
          title: "Pricing page converts poorly",
        }),
      );
      expect(html).toContain(">Accept<");
      expect(html).toContain(">Dismiss<");
      expect(html).toContain('name="findingId"');
    });

    it("hides them when insights are off", () => {
      const html = render(monthlyWith("off", [snap()]));
      expect(html).toContain("Pricing page converts poorly");
      expect(html).not.toContain(">Accept<");
      expect(html).not.toContain(">Dismiss<");
    });

    it("hides them for a finding that is no longer OPEN", () => {
      const html = render(
        monthlyWith("on", [snap({ status: "ACCEPTED" })]),
      );
      expect(html).toContain("Pricing page converts poorly");
      expect(html).not.toContain(">Accept<");
    });
  });

  it("keeps the weekly details closed until opened", () => {
    const html = render(sampleWeeklyCard());
    expect(html).toContain("Show full report");
    expect(render(sampleMonthlyCard())).toContain("Hide full report");
  });

  describe("plan card", () => {
    it("has one metricKey checkbox per proposal", () => {
      const card = samplePlanCard();
      if (card.body.variant !== "plan") throw new Error("not a plan");
      const count = card.body.proposals.length;
      expect(count).toBeGreaterThan(0);
      const html = render(card, "garep_plan_proj-1_2026-10");
      expect(html.match(/name="metricKey"/g)).toHaveLength(count);
      expect(html).toContain('name="commandId"');
      expect(html).toContain("Use these targets");
      expect(html).toContain("You can change targets anytime in");
    });

    it("lists the proposals without a form when there is no command id", () => {
      const html = render(samplePlanCard());
      expect(html).not.toContain('name="metricKey"');
      expect(html).not.toContain("Use these targets");
    });
  });

  describe("alert card", () => {
    it("offers 'Mute for 7 days' and an Open link", () => {
      const card = sampleAlertCard();
      if (card.body.variant !== "alert") throw new Error("not an alert");
      const html = render({
        ...card,
        body: { ...card.body, kind: "GA_MH1", reconnect: false },
      });
      expect(html).toContain("Mute for 7 days");
      expect(html).toContain('name="alertId"');
      expect(html).toContain(">Open<");
      expect(html).toContain(WEBSITE_REPORT_COPY.alertBody);
    });

    it("shows 'Reconnect' and no mute for GA_MH24", () => {
      const card = sampleAlertCard();
      if (card.body.variant !== "alert") throw new Error("not an alert");
      const html = render({
        ...card,
        body: { ...card.body, kind: "GA_MH24", reconnect: true },
      });
      expect(html).toContain("Reconnect");
      expect(html).not.toContain("Mute for 7 days");
      expect(html).toContain(WEBSITE_REPORT_COPY.reconnectBody);
    });
  });

  it("never fetches anything", () => {
    const spy = vi.spyOn(globalThis, "fetch");
    for (const make of [
      samplePulseCard,
      sampleWeeklyCard,
      sampleMonthlyCard,
      samplePlanCard,
      sampleAlertCard,
    ]) {
      render(make());
    }
    expect(spy).not.toHaveBeenCalled();
  });
});

describe("WebsiteReportWorksCard", () => {
  it("renders a valid stored card", () => {
    const card = sampleWeeklyCard();
    const html = renderToStaticMarkup(
      createElement(WebsiteReportWorksCard, { card, commandId: "c1" }),
    );
    expect(html).toContain(card.title.replace(/&/g, "&amp;"));
  });

  it("shows a neutral line for a malformed card without throwing", () => {
    const malformed = {
      kind: "website-report",
      v: 1,
      variant: "weekly",
      body: { variant: "monthly" },
    };
    const html = renderToStaticMarkup(
      createElement(WebsiteReportWorksCard, { card: malformed }),
    );
    expect(html).toContain(WEBSITE_REPORT_COPY.reportUnavailable.replace(/'/g, "&#x27;"));
    expect(html).toContain('data-card="website-report"');
  });

  it("shows the neutral line for non-card values", () => {
    for (const value of [null, undefined, 42, "x", []]) {
      const html = renderToStaticMarkup(
        createElement(WebsiteReportWorksCard, { card: value }),
      );
      expect(html).toContain("can&#x27;t be shown");
    }
  });
});
