import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  sampleMonthlyCard,
  samplePlanCard,
  sampleWeeklyCard,
} from "@/lib/website-analytics/reports/test-fixtures";
import type { WebsiteReportArchiveItem } from "@/lib/website-analytics/reports/types";

// Bu dosyanın kanıtladığı (GA-F8 ClientReportSection): bayrak kapalı, yönetici
// değil ya da bu mülkün kartı yokken null (sorgusuz); kart başına Markdown ve
// Print / PDF bağlantıları; müşteri bağlantısı paneli yalnız haftalık/aylıkta;
// paylaşımlar tek çağrıyla yüklenir; ipucu /websites#branding'e bağlanır; demo
// kart notu.

const mocks = vi.hoisted(() => ({
  projectFind: vi.fn(),
  brandingGet: vi.fn(),
  listShares: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: { project: { findUnique: mocks.projectFind } },
}));
vi.mock("@/lib/report-share/flags", () => ({
  reportShareOn: (env: Readonly<Record<string, string | undefined>> = process.env) =>
    env.GA_AGENCY === "true",
}));
vi.mock("@/server/report-share/branding", () => ({
  ReportBrandings: { get: mocks.brandingGet },
}));
vi.mock("@/server/website-analytics/agency/share", () => ({
  listWebsiteReportShares: mocks.listShares,
}));
// İstemci paneli ve eylemleri taklit edilir.
vi.mock("./share-link-panel", () => ({
  SharePanel: (props: { commandId: string; shares: unknown[] }) =>
    createElement("div", {
      "data-share-panel": props.commandId,
      "data-shares": String(props.shares.length),
    }),
}));

const { ClientReportSection } = await import("./client-report-section");

function item(
  variant: WebsiteReportArchiveItem["variant"],
  card = variant === "weekly"
    ? sampleWeeklyCard()
    : variant === "monthly"
      ? sampleMonthlyCard()
      : samplePlanCard(),
): WebsiteReportArchiveItem {
  return {
    commandId: `garep_${variant}_proj_1_x`,
    variant,
    title: card.title,
    periodLabel: card.periodLabel,
    builtAt: card.builtAt,
    chatHref: "/chat",
    card,
  };
}

async function render(
  props: Partial<Parameters<typeof ClientReportSection>[0]> = {},
): Promise<string | null> {
  const element = await ClientReportSection({
    projectId: "proj_1",
    linkId: "link_1",
    items: [item("weekly"), item("monthly"), item("plan")],
    canManage: true,
    ...props,
  });
  return element ? renderToStaticMarkup(element) : null;
}

beforeEach(() => {
  vi.unstubAllEnvs();
  vi.stubEnv("GA_AGENCY", "true");
  vi.stubEnv("GA_SYNC", "true");
  vi.stubEnv("NODE_ENV", "test");
  for (const mock of Object.values(mocks)) mock.mockReset();
  mocks.projectFind.mockResolvedValue({ workspaceId: "ws_1" });
  mocks.brandingGet.mockResolvedValue({
    displayName: "Acme Digital",
    accent: "blue",
    footer: null,
    logoAssetId: null,
  });
  mocks.listShares.mockResolvedValue({});
});

describe("ClientReportSection", () => {
  it("renders nothing, without a query, when the flag is off, the viewer is no manager or the dev guard refuses", async () => {
    vi.stubEnv("GA_AGENCY", "false");
    expect(await render()).toBeNull();
    vi.stubEnv("GA_AGENCY", "true");
    expect(await render({ canManage: false })).toBeNull();
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("DATABASE_URL", "postgresql://u:p@db.example.com/live");
    vi.stubEnv("GA_SYNC_DEV_PROJECTS", "");
    expect(await render()).toBeNull();
    expect(mocks.projectFind).not.toHaveBeenCalled();
    expect(mocks.listShares).not.toHaveBeenCalled();
  });

  it("renders nothing when this property has no report cards", async () => {
    expect(await render({ linkId: "link_other" })).toBeNull();
    expect(await render({ items: [] })).toBeNull();
    expect(mocks.projectFind).not.toHaveBeenCalled();
  });

  it("shows the export links for each item of this link", async () => {
    const html = (await render()) ?? "";
    expect(html).toContain('id="client-reports"');
    expect(html).toContain(">Client reports<");
    expect(html).toContain(
      "/api/projects/proj_1/client-report?command=garep_weekly_proj_1_x&amp;format=md",
    );
    expect(html).toContain("/projects/proj_1/site/client/garep_monthly_proj_1_x");
    expect(html).toContain("/projects/proj_1/site/client/garep_plan_proj_1_x");
    expect(html.match(/>Markdown</g)).toHaveLength(3);
    expect(html.match(/Print \/ PDF/g)).toHaveLength(3);
  });

  it("offers the client link panel for weekly and monthly only, loaded in one call", async () => {
    mocks.listShares.mockResolvedValue({ garep_weekly_proj_1_x: [{ id: "s1" }] });
    const html = (await render()) ?? "";
    expect(html).toContain('data-share-panel="garep_weekly_proj_1_x"');
    expect(html).toContain('data-share-panel="garep_monthly_proj_1_x"');
    expect(html).not.toContain('data-share-panel="garep_plan_proj_1_x"');
    expect(html).toContain('data-shares="1"');
    expect(mocks.listShares).toHaveBeenCalledTimes(1);
    expect(mocks.listShares).toHaveBeenCalledWith("proj_1", [
      "garep_weekly_proj_1_x",
      "garep_monthly_proj_1_x",
    ]);
  });

  it("explains the branding and links to the workspace branding form", async () => {
    const html = (await render()) ?? "";
    expect(html).toContain("Uses Acme Digital branding.");
    expect(html).toContain('href="/websites#branding"');
    expect(html).toContain("Edit it in Websites.");
    expect(mocks.brandingGet).toHaveBeenCalledWith("ws_1");
  });

  it("only lists the cards of the selected property", async () => {
    const other = sampleWeeklyCard({ linkId: "link_2", title: "Second site weekly" });
    const html =
      (await render({
        items: [item("weekly"), { ...item("monthly", other), commandId: "garep_weekly_proj_1_s" }],
      })) ?? "";
    expect(html).not.toContain("Second site weekly");
    expect(html).not.toContain("garep_weekly_proj_1_s");
  });

  it("marks demo cards", async () => {
    const html =
      (await render({ items: [item("weekly", sampleWeeklyCard({ isMock: true }))] })) ?? "";
    expect(html).toContain("Demo data");
    expect((await render()) ?? "").not.toContain("Demo data");
  });

  it("renders nothing when the project vanished", async () => {
    mocks.projectFind.mockResolvedValue(null);
    expect(await render()).toBeNull();
  });
});
