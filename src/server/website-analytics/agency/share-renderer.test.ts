import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  sampleMonthlyCard,
  sampleWeeklyCard,
} from "@/lib/website-analytics/reports/test-fixtures";
import type { WebsiteReportCardData } from "@/lib/website-analytics/reports/types";

// Bu dosyanın kanıtladığı (GA-F8 share-renderer.tsx): içe aktarmada 'WEBSITE'
// tam bir kez kaydolur; bayrak kapalıyken, yerel bekçi reddederken, kart yokken,
// plan/nabız/uyarı kimliğinde ve bağ yokken null döner; başarıda başlık, dönem ve
// Agentelse içermeyen, site içi arama ve bağlantısı olmayan bir düğüm döner;
// veritabanına hiç yazılmaz.

const mocks = vi.hoisted(() => ({
  register: vi.fn(),
  load: vi.fn(),
  writes: vi.fn(),
}));

vi.mock("@/server/report-share/renderers", () => ({
  registerShareRenderer: mocks.register,
}));
vi.mock("@/server/website-analytics/agency/share", () => ({
  loadWebsiteReportForClient: mocks.load,
}));
// Çizici hiçbir model yöntemini çağırmamalı: her erişim kaydedilir.
vi.mock("@/lib/prisma", () => ({
  prisma: new Proxy(
    {},
    {
      get: () =>
        new Proxy(
          {},
          { get: (_t, method) => (...args: unknown[]) => mocks.writes(method, args) },
        ),
    },
  ),
}));

await import("./share-renderer");

type Renderer = (share: {
  projectId: string;
  reportId: string;
  branding: { displayName: string; accent: string; footer: string | null; logoAssetId: string | null };
}) => Promise<{ title: string; periodLabel: string | null; node: React.ReactNode } | null>;

const registered = mocks.register.mock.calls.map((call) => call);
const renderer = registered[0]?.[1] as Renderer;

const branding = {
  displayName: "Acme Digital",
  accent: "blue",
  footer: null,
  logoAssetId: null,
};
const share = (reportId = "garep_weekly_proj_1_2026-09-28") => ({
  projectId: "proj_1",
  reportId,
  branding,
});

beforeEach(() => {
  vi.unstubAllEnvs();
  vi.stubEnv("GA_AGENCY", "true");
  vi.stubEnv("GA_SYNC", "true");
  vi.stubEnv("NODE_ENV", "test");
  mocks.load.mockReset();
  mocks.writes.mockReset();
  mocks.load.mockResolvedValue(sampleWeeklyCard());
});

describe("registration", () => {
  it("registers the WEBSITE renderer exactly once at import", () => {
    expect(registered).toHaveLength(1);
    expect(registered[0]?.[0]).toBe("WEBSITE");
    expect(typeof renderer).toBe("function");
  });
});

describe("renderer", () => {
  it("returns null when the flag is off or the dev guard refuses, without loading", async () => {
    vi.stubEnv("GA_AGENCY", "false");
    expect(await renderer(share())).toBeNull();
    vi.stubEnv("GA_AGENCY", "true");
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("DATABASE_URL", "postgresql://u:p@db.example.com/live");
    vi.stubEnv("GA_SYNC_DEV_PROJECTS", "");
    expect(await renderer(share())).toBeNull();
    expect(mocks.load).not.toHaveBeenCalled();
  });

  it("returns null when the card or its link is missing", async () => {
    mocks.load.mockResolvedValue(null);
    expect(await renderer(share())).toBeNull();
  });

  it("loads without allowPlan so plan, pulse and alert ids end up null", async () => {
    mocks.load.mockResolvedValue(null);
    for (const id of [
      "garep_plan_proj_1_2026-10",
      "garep_pulse_proj_1_2026-10-05",
      "garep_alert_proj_1_x",
    ]) {
      expect(await renderer(share(id))).toBeNull();
      expect(mocks.load).toHaveBeenLastCalledWith({
        projectId: "proj_1",
        commandId: id,
        allowPlan: false,
      });
    }
  });

  it("returns null for a card that cannot be converted", async () => {
    mocks.load.mockResolvedValue({
      ...sampleWeeklyCard(),
      variant: "pulse",
      body: { variant: "pulse" },
    } as unknown as WebsiteReportCardData);
    expect(await renderer(share())).toBeNull();
  });

  it("renders the share-safe document without Agentelse, site search or links", async () => {
    mocks.load.mockResolvedValue(
      sampleWeeklyCard({
        title: "Agentelse weekly report",
        narrative: {
          headline: "Agentelse found growth",
          highlights: [],
          watchouts: [],
          nextSteps: [],
        },
      }),
    );
    const result = await renderer(share());
    expect(result).not.toBeNull();
    if (!result) return;
    expect(result.title).toBe("Acme Digital weekly report");
    expect(result.periodLabel).toBe("Sep 28 – Oct 4");
    const html = renderToStaticMarkup(result.node as React.ReactElement);
    expect(html.toLowerCase()).not.toContain("agentelse");
    expect(html).toContain("Acme Digital found growth");
    expect(html).not.toContain("red running shoes");
    expect(html).not.toContain("<a ");
    expect(html).not.toContain("href=");
    // Dış dünya sayılarını gösterir.
    expect(html).toContain("4,760");
  });

  it("renders a monthly card too", async () => {
    mocks.load.mockResolvedValue(sampleMonthlyCard());
    const result = await renderer(share("garep_monthly_proj_1_2026-09"));
    expect(result?.periodLabel).toBe("September 2026");
  });

  it("never touches a prisma model", async () => {
    await renderer(share());
    await renderer(share("garep_plan_proj_1_2026-10"));
    expect(mocks.writes).not.toHaveBeenCalled();
  });
});
