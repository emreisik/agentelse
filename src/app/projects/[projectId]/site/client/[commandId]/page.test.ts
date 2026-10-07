import { createElement, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { sampleWeeklyCard } from "@/lib/website-analytics/reports/test-fixtures";

// Bu dosyanın kanıtladığı (GA-F8 yönetici yazdırma sayfası): yönetici olmayan,
// bayrak kapalı, GA_WEBSITE_PAGE kapalı, kart yok ve yerel bekçi durumlarında
// notFound; geçerli kartta çerçeve printable, canlı marka ve alt bilgi yedeğiyle
// çizilir, logo assetUrl üzerinden gelir, çıktıda Agentelse yoktur.

class NotFoundSignal extends Error {}

const mocks = vi.hoisted(() => ({
  requireUser: vi.fn(),
  requireProjectAccess: vi.fn(),
  isWorkspaceManager: vi.fn(),
  load: vi.fn(),
  brandingGet: vi.fn(),
  projectFind: vi.fn(),
  notFound: vi.fn(),
}));

vi.mock("next/navigation", () => ({ notFound: mocks.notFound }));
vi.mock("@/server/security/tenant-context", () => ({
  requireUser: mocks.requireUser,
  requireProjectAccess: mocks.requireProjectAccess,
  isWorkspaceManager: mocks.isWorkspaceManager,
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
  WEBSITE_SHARE_FOOTER_FALLBACK: "Numbers from Google Analytics.",
  loadWebsiteReportForClient: mocks.load,
}));
vi.mock("@/components/report-share/white-label-frame", () => ({
  WhiteLabelFrame: (props: {
    title: string;
    periodLabel: string | null;
    branding: { displayName: string; footer: string | null };
    logoSrc: string | null;
    printable?: boolean;
    children: ReactNode;
  }) =>
    createElement(
      "div",
      {
        "data-frame": "1",
        "data-printable": String(props.printable === true),
        "data-logo": props.logoSrc ?? "",
      },
      createElement("h1", null, props.title),
      createElement("p", null, props.periodLabel),
      createElement("footer", null, props.branding.footer),
      props.children,
    ),
}));
vi.mock("@/components/report-share/print-button", () => ({
  PrintButton: () => createElement("button", null, "Print"),
}));

const Page = (await import("./page")).default;

const WEEKLY_ID = "garep_weekly_proj_1_2026-09-28";

async function render(commandId = WEEKLY_ID): Promise<ReactElement> {
  return (await Page({
    params: Promise.resolve({ projectId: "proj_1", commandId }),
  })) as ReactElement;
}

const branding = {
  displayName: "Acme Digital",
  accent: "blue",
  footer: null as string | null,
  logoAssetId: "asset_9" as string | null,
};

beforeEach(() => {
  vi.unstubAllEnvs();
  vi.stubEnv("GA_AGENCY", "true");
  vi.stubEnv("GA_SYNC", "true");
  vi.stubEnv("GA_WEBSITE_PAGE", "true");
  vi.stubEnv("NODE_ENV", "test");
  for (const mock of Object.values(mocks)) mock.mockReset();
  mocks.notFound.mockImplementation(() => {
    throw new NotFoundSignal();
  });
  mocks.requireUser.mockResolvedValue({ userId: "user_1" });
  mocks.requireProjectAccess.mockResolvedValue({ workspaceId: "ws_1" });
  mocks.isWorkspaceManager.mockResolvedValue(true);
  mocks.load.mockResolvedValue(
    sampleWeeklyCard({ title: "Agentelse weekly report" }),
  );
  mocks.projectFind.mockResolvedValue({ name: "Shop Ltd" });
  mocks.brandingGet.mockResolvedValue({ ...branding });
});

describe("client report print page", () => {
  it("renders a printable frame with the live branding and the footer fallback", async () => {
    const element = await render();
    expect(element.props).toMatchObject({
      title: "Acme Digital weekly report",
      periodLabel: "Sep 28 – Oct 4",
      printable: true,
      logoSrc: "/api/assets/asset_9?w=768",
      branding: {
        displayName: "Acme Digital",
        footer: "Numbers from Google Analytics.",
      },
    });
    expect(mocks.load).toHaveBeenCalledWith({
      projectId: "proj_1",
      commandId: WEEKLY_ID,
      allowPlan: true,
    });
  });

  it("keeps a footer the workspace wrote and omits the logo when none is set", async () => {
    mocks.brandingGet.mockResolvedValue({
      ...branding,
      footer: "Prepared with care.",
      logoAssetId: null,
    });
    const element = await render();
    expect(element.props).toMatchObject({
      logoSrc: null,
      branding: { footer: "Prepared with care." },
    });
  });

  it("prints the report body, a print button and no Agentelse", async () => {
    const html = renderToStaticMarkup(await render());
    expect(html).toContain("Print");
    expect(html).toContain("4,760");
    expect(html).toContain("Shop Ltd");
    expect(html).not.toContain("<a ");
    expect(html.toLowerCase()).not.toContain("agentelse");
  });

  it.each([
    ["GA_WEBSITE_PAGE off", () => vi.stubEnv("GA_WEBSITE_PAGE", "false")],
    ["GA_AGENCY off", () => vi.stubEnv("GA_AGENCY", "false")],
    [
      "dev process outside the allow list",
      () => {
        vi.stubEnv("NODE_ENV", "development");
        vi.stubEnv("DATABASE_URL", "postgresql://u:p@db.example.com/live");
        vi.stubEnv("GA_SYNC_DEV_PROJECTS", "");
      },
    ],
  ])("is notFound before any lookup: %s", async (_name, setup) => {
    setup();
    await expect(render()).rejects.toBeInstanceOf(NotFoundSignal);
    expect(mocks.requireUser).not.toHaveBeenCalled();
    expect(mocks.load).not.toHaveBeenCalled();
  });

  it("is notFound for a non-manager and for no access", async () => {
    mocks.isWorkspaceManager.mockResolvedValue(false);
    await expect(render()).rejects.toBeInstanceOf(NotFoundSignal);
    mocks.isWorkspaceManager.mockResolvedValue(true);
    mocks.requireProjectAccess.mockRejectedValue(new Error("denied"));
    await expect(render()).rejects.toBeInstanceOf(NotFoundSignal);
    expect(mocks.load).not.toHaveBeenCalled();
  });

  it("is notFound when the card is missing or cannot be converted", async () => {
    mocks.load.mockResolvedValue(null);
    await expect(render()).rejects.toBeInstanceOf(NotFoundSignal);
    mocks.load.mockResolvedValue({
      ...sampleWeeklyCard(),
      variant: "pulse",
      body: { variant: "pulse" },
    });
    await expect(render()).rejects.toBeInstanceOf(NotFoundSignal);
  });
});
