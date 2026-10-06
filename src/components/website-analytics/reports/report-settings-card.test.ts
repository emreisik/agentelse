import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { GA_REPORT_SETTINGS_DEFAULTS } from "@/lib/website-analytics/reports/settings";

// Bu dosyanın kanıtladığı: bayrak kapalıyken ya da geliştirme kapsamı projeyi
// dışarıda bırakırken kart null döner ve hiçbir okuma yapılmaz; açıkken form
// alan adları ve varsayılanlar doğru, yardım metni saat dilimini söyler.

const mocks = vi.hoisted(() => ({
  loadGaReportSettings: vi.fn(),
  getProjectTimezone: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn() }),
}));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock("@/server/website-analytics/reports/settings", () => ({
  loadGaReportSettings: mocks.loadGaReportSettings,
}));
vi.mock("@/server/chat/content-plan", () => ({
  getProjectTimezone: mocks.getProjectTimezone,
}));
vi.mock("@/server/actions/website-report-actions", () => ({
  updateGaReportSettingsAction: vi.fn(),
  applyGaPlanTargetsAction: vi.fn(),
}));

const { WebsiteReportSettingsCard } = await import("./report-settings-card");

beforeEach(() => {
  vi.unstubAllEnvs();
  mocks.loadGaReportSettings.mockReset();
  mocks.getProjectTimezone.mockReset();
  mocks.loadGaReportSettings.mockResolvedValue({
    ...GA_REPORT_SETTINGS_DEFAULTS,
    stored: false,
  });
  mocks.getProjectTimezone.mockResolvedValue("Europe/Istanbul");
});

describe("WebsiteReportSettingsCard", () => {
  it("returns null without any read when GA_REPORTS is unset", async () => {
    vi.stubEnv("GA_SYNC", "true");
    vi.stubEnv("GA_REPORTS", "");
    expect(await WebsiteReportSettingsCard({ projectId: "p1" })).toBeNull();
    expect(mocks.loadGaReportSettings).not.toHaveBeenCalled();
    expect(mocks.getProjectTimezone).not.toHaveBeenCalled();
  });

  it("returns null when GA_SYNC is off", async () => {
    vi.stubEnv("GA_REPORTS", "true");
    vi.stubEnv("GA_SYNC", "");
    expect(await WebsiteReportSettingsCard({ projectId: "p1" })).toBeNull();
    expect(mocks.loadGaReportSettings).not.toHaveBeenCalled();
  });

  it("returns null when the dev scope excludes the project", async () => {
    vi.stubEnv("GA_REPORTS", "true");
    vi.stubEnv("GA_SYNC", "true");
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("DATABASE_URL", "postgresql://u:p@ep-x.neon.tech/neondb");
    vi.stubEnv("GA_SYNC_DEV_PROJECTS", "other-project");
    expect(await WebsiteReportSettingsCard({ projectId: "p1" })).toBeNull();
    expect(mocks.loadGaReportSettings).not.toHaveBeenCalled();
  });

  it("renders the form fields with the defaults when on", async () => {
    vi.stubEnv("GA_REPORTS", "true");
    vi.stubEnv("GA_SYNC", "true");
    const element = await WebsiteReportSettingsCard({ projectId: "p1" });
    expect(element).not.toBeNull();
    const html = renderToStaticMarkup(element);

    expect(html).toContain('id="website-reports"');
    expect(html).toContain("Website reports");
    expect(html).toContain('name="projectId"');
    for (const name of [
      "weeklyEnabled",
      "weeklyWeekday",
      "monthlyEnabled",
      "monthlyDay",
      "pulse",
      "alertChat",
      "alertTelegram",
    ]) {
      expect(html).toContain(`name="${name}"`);
    }
    expect(html).toContain("Weekly report");
    expect(html).toContain("Monthly report and next month plan");
    expect(html).toContain("Only when something stands out");
    expect(html).toContain(
      "Post critical tracking alerts in the Website analytics chat",
    );
    expect(html).toContain(
      "never includes numbers or page addresses",
    );
    expect(html).toContain("08:00");
    expect(html).toContain("Europe/Istanbul");
    expect(html).toContain("Archiving the Website analytics chat does not stop");
    // Varsayılanlar: üç anahtar açık, nabız "notable".
    expect(html.match(/data-checked/g)?.length ?? 0).toBeGreaterThanOrEqual(4);
    expect(html).toContain('value="notable"');
    expect(mocks.loadGaReportSettings).toHaveBeenCalledWith("p1");
    expect(mocks.getProjectTimezone).toHaveBeenCalledWith("p1");
  });

  it("reflects stored values", async () => {
    vi.stubEnv("GA_REPORTS", "true");
    vi.stubEnv("GA_SYNC", "true");
    mocks.loadGaReportSettings.mockResolvedValue({
      ...GA_REPORT_SETTINGS_DEFAULTS,
      weeklyEnabled: false,
      alertTelegram: false,
      pulse: "off",
      weeklyWeekday: 3,
      stored: true,
    });
    const html = renderToStaticMarkup(
      await WebsiteReportSettingsCard({ projectId: "p1" }),
    );
    expect(html).toContain("Wednesday");
    expect(html).toContain("data-unchecked");
  });
});
