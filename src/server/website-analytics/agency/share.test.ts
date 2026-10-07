import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  sampleMonthlyCard,
  samplePlanCard,
  sampleWeeklyCard,
} from "@/lib/website-analytics/reports/test-fixtures";
import type { WebsiteReportCardData } from "@/lib/website-analytics/reports/types";

// Bu dosyanın kanıtladığı (GA-F8 share.ts, SC-F9 modülleri taklit edilir):
// bayrak kapalı ya da yerel izin listesi reddederken sorgu/çağrı yok; yükleyici
// yanlış proje, yanlış çeşit, allowPlan olmadan plan ve başka projenin bağını
// reddeder; oluşturma onay, rapor, gün ve sınır hatalarını eşler, başarıda
// 'WEBSITE' tür, rapor kimliği ve alt bilgi yedeğiyle marka anlık görüntüsünü
// geçirir ve adresi bir kez döner; liste/iptal ReportShares'a devredilir.

const mocks = vi.hoisted(() => ({
  commandFindFirst: vi.fn(),
  linkFindFirst: vi.fn(),
  brandingGet: vi.fn(),
  create: vi.fn(),
  listForProject: vi.fn(),
  revoke: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    command: { findFirst: mocks.commandFindFirst },
    gaPropertyLink: { findFirst: mocks.linkFindFirst },
  },
}));
vi.mock("@/lib/app-url", () => ({
  appUrl: (path: string) => new URL(path, "https://app.example.com"),
}));
vi.mock("@/server/report-share/branding", () => ({
  ReportBrandings: { get: mocks.brandingGet },
}));
vi.mock("@/server/report-share/store", () => ({
  ReportShares: {
    create: mocks.create,
    listForProject: mocks.listForProject,
    revoke: mocks.revoke,
  },
}));

const {
  WEBSITE_SHARE_FOOTER_FALLBACK,
  createWebsiteReportShare,
  listWebsiteReportShares,
  loadWebsiteReportForClient,
  revokeWebsiteReportShare,
} = await import("./share");

const PROJECT = "proj_1";
const WEEKLY_ID = `garep_weekly_${PROJECT}_2026-09-28`;
const MONTHLY_ID = `garep_monthly_${PROJECT}_2026-09`;
const PLAN_ID = `garep_plan_${PROJECT}_2026-10`;

function row(card: WebsiteReportCardData) {
  return { parsedIntent: { card } };
}

const branding = {
  displayName: "Acme Digital",
  accent: "blue",
  footer: null,
  logoAssetId: null,
};

beforeEach(() => {
  vi.unstubAllEnvs();
  vi.stubEnv("GA_AGENCY", "true");
  vi.stubEnv("GA_SYNC", "true");
  vi.stubEnv("NODE_ENV", "test");
  for (const mock of Object.values(mocks)) mock.mockReset();
  mocks.commandFindFirst.mockResolvedValue(row(sampleWeeklyCard()));
  mocks.linkFindFirst.mockResolvedValue({ isPrimary: true, isSecondary: false });
  mocks.brandingGet.mockResolvedValue(branding);
  mocks.create.mockResolvedValue({
    ok: true,
    id: "share_1",
    token: "tok_secret_123",
    expiresAt: new Date("2026-11-04T10:00:00.000Z"),
  });
  mocks.listForProject.mockResolvedValue({});
  mocks.revoke.mockResolvedValue(true);
});

function anyCall(): boolean {
  return Object.values(mocks).some((mock) => mock.mock.calls.length > 0);
}

describe("flag and dev guard", () => {
  it.each([
    ["GA_AGENCY off", () => vi.stubEnv("GA_AGENCY", "false")],
    ["GA_SYNC off", () => vi.stubEnv("GA_SYNC", "false")],
    [
      "dev process outside the allow list",
      () => {
        vi.stubEnv("NODE_ENV", "development");
        vi.stubEnv("DATABASE_URL", "postgresql://u:p@db.example.com/live");
        vi.stubEnv("GA_SYNC_DEV_PROJECTS", "other_project");
      },
    ],
  ])("answers before any query: %s", async (_name, setup) => {
    setup();
    expect(
      await loadWebsiteReportForClient({
        projectId: PROJECT,
        commandId: WEEKLY_ID,
        allowPlan: true,
      }),
    ).toBeNull();
    expect(
      await createWebsiteReportShare({
        workspaceId: "ws_1",
        projectId: PROJECT,
        userId: "u1",
        commandId: WEEKLY_ID,
        days: 30,
        confirmPublic: true,
      }),
    ).toEqual({ ok: false, reason: "off" });
    expect(await listWebsiteReportShares(PROJECT, [WEEKLY_ID])).toEqual({});
    expect(
      await revokeWebsiteReportShare({
        projectId: PROJECT,
        shareId: "s1",
        userId: "u1",
      }),
    ).toBe(false);
    expect(anyCall()).toBe(false);
  });

  it("lets an allow-listed dev project through", async () => {
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("DATABASE_URL", "postgresql://u:p@db.example.com/live");
    vi.stubEnv("GA_SYNC_DEV_PROJECTS", `x, ${PROJECT}`);
    expect(
      await loadWebsiteReportForClient({
        projectId: PROJECT,
        commandId: WEEKLY_ID,
        allowPlan: false,
      }),
    ).not.toBeNull();
  });
});

describe("loadWebsiteReportForClient", () => {
  const load = (commandId: string, allowPlan = false) =>
    loadWebsiteReportForClient({ projectId: PROJECT, commandId, allowPlan });

  it("returns the stored card of a weekly and a monthly report", async () => {
    expect((await load(WEEKLY_ID))?.variant).toBe("weekly");
    mocks.commandFindFirst.mockResolvedValue(row(sampleMonthlyCard()));
    expect((await load(MONTHLY_ID))?.variant).toBe("monthly");
  });

  it("scopes the query to the project's website work and SYSTEM rows", async () => {
    await load(WEEKLY_ID);
    expect(mocks.commandFindFirst).toHaveBeenCalledWith({
      where: {
        id: WEEKLY_ID,
        projectId: PROJECT,
        workId: `wkga_${PROJECT}`,
        source: "SYSTEM",
      },
      select: { parsedIntent: true },
    });
    expect(mocks.linkFindFirst).toHaveBeenCalledWith({
      where: { id: "link_1", projectId: PROJECT },
      select: { isPrimary: true, isSecondary: true },
    });
  });

  it("rejects ids of other variants before querying", async () => {
    expect(await load(`garep_pulse_${PROJECT}_2026-10-05`)).toBeNull();
    expect(await load(`garep_alert_${PROJECT}_a`)).toBeNull();
    expect(await load("cmd_123")).toBeNull();
    expect(await load(PLAN_ID, false)).toBeNull();
    expect(mocks.commandFindFirst).not.toHaveBeenCalled();
  });

  it("allows a plan card only with allowPlan", async () => {
    mocks.commandFindFirst.mockResolvedValue(row(samplePlanCard()));
    expect((await load(PLAN_ID, true))?.variant).toBe("plan");
  });

  it("rejects a missing row, an unreadable card and a variant that differs from the id", async () => {
    mocks.commandFindFirst.mockResolvedValueOnce(null);
    expect(await load(WEEKLY_ID)).toBeNull();
    mocks.commandFindFirst.mockResolvedValueOnce({ parsedIntent: { card: { kind: "x" } } });
    expect(await load(WEEKLY_ID)).toBeNull();
    mocks.commandFindFirst.mockResolvedValueOnce(row(sampleMonthlyCard()));
    expect(await load(WEEKLY_ID)).toBeNull();
  });

  it("rejects a card that names another project", async () => {
    mocks.commandFindFirst.mockResolvedValue(
      row(sampleWeeklyCard({ projectId: "proj_other" })),
    );
    expect(await load(WEEKLY_ID)).toBeNull();
    expect(mocks.linkFindFirst).not.toHaveBeenCalled();
  });

  it("rejects a card whose link is missing, in another project or not an engine link", async () => {
    mocks.linkFindFirst.mockResolvedValueOnce(null);
    expect(await load(WEEKLY_ID)).toBeNull();
    mocks.linkFindFirst.mockResolvedValueOnce({ isPrimary: false, isSecondary: false });
    expect(await load(WEEKLY_ID)).toBeNull();
  });

  it("accepts the card of a secondary link while the agency flag is on", async () => {
    mocks.linkFindFirst.mockResolvedValue({ isPrimary: false, isSecondary: true });
    expect(await load(WEEKLY_ID)).not.toBeNull();
  });
});

describe("createWebsiteReportShare", () => {
  const input = {
    workspaceId: "ws_1",
    projectId: PROJECT,
    userId: "u1",
    commandId: WEEKLY_ID,
    days: 30,
    confirmPublic: true,
  };

  it("needs the explicit confirmation before anything is read", async () => {
    expect(
      await createWebsiteReportShare({ ...input, confirmPublic: false }),
    ).toEqual({ ok: false, reason: "not_confirmed" });
    expect(anyCall()).toBe(false);
  });

  it("refuses a report that cannot be loaded", async () => {
    mocks.commandFindFirst.mockResolvedValue(null);
    expect(await createWebsiteReportShare(input)).toEqual({
      ok: false,
      reason: "bad_report",
    });
    expect(mocks.create).not.toHaveBeenCalled();
  });

  it("never shares a plan card", async () => {
    mocks.commandFindFirst.mockResolvedValue(row(samplePlanCard()));
    expect(
      await createWebsiteReportShare({ ...input, commandId: PLAN_ID }),
    ).toEqual({ ok: false, reason: "bad_report" });
  });

  it("maps INVALID_DAYS and LIMIT", async () => {
    mocks.create.mockResolvedValueOnce({ ok: false, code: "INVALID_DAYS" });
    expect(await createWebsiteReportShare({ ...input, days: 45 })).toEqual({
      ok: false,
      reason: "bad_days",
    });
    mocks.create.mockResolvedValueOnce({ ok: false, code: "LIMIT" });
    expect(await createWebsiteReportShare(input)).toEqual({
      ok: false,
      reason: "limit",
    });
  });

  it("creates a WEBSITE share with the footer fallback and returns the url once", async () => {
    const now = new Date("2026-10-05T10:00:00.000Z");
    const result = await createWebsiteReportShare({ ...input, now });
    expect(result).toEqual({
      ok: true,
      url: "https://app.example.com/r/tok_secret_123",
      expiresAt: "2026-11-04T10:00:00.000Z",
    });
    expect(mocks.create).toHaveBeenCalledWith({
      workspaceId: "ws_1",
      projectId: PROJECT,
      kind: "WEBSITE",
      reportId: WEEKLY_ID,
      days: 30,
      userId: "u1",
      branding: { ...branding, footer: WEBSITE_SHARE_FOOTER_FALLBACK },
      now,
    });
  });

  it("keeps a footer the workspace wrote and treats a blank one as empty", async () => {
    mocks.brandingGet.mockResolvedValueOnce({ ...branding, footer: "Our own words." });
    await createWebsiteReportShare(input);
    expect(mocks.create.mock.calls[0]?.[0].branding.footer).toBe("Our own words.");
    mocks.brandingGet.mockResolvedValueOnce({ ...branding, footer: "   " });
    await createWebsiteReportShare(input);
    expect(mocks.create.mock.calls[1]?.[0].branding.footer).toBe(
      WEBSITE_SHARE_FOOTER_FALLBACK,
    );
  });

  it("does not leak the token into the console", async () => {
    const spies = [
      vi.spyOn(console, "log").mockImplementation(() => undefined),
      vi.spyOn(console, "error").mockImplementation(() => undefined),
      vi.spyOn(console, "warn").mockImplementation(() => undefined),
    ];
    await createWebsiteReportShare(input);
    for (const spy of spies) {
      expect(JSON.stringify(spy.mock.calls)).not.toContain("tok_secret_123");
      spy.mockRestore();
    }
  });
});

describe("list and revoke", () => {
  it("lists in one ReportShares call for the WEBSITE kind", async () => {
    mocks.listForProject.mockResolvedValue({ [WEEKLY_ID]: [] });
    expect(await listWebsiteReportShares(PROJECT, [WEEKLY_ID, MONTHLY_ID])).toEqual({
      [WEEKLY_ID]: [],
    });
    expect(mocks.listForProject).toHaveBeenCalledTimes(1);
    expect(mocks.listForProject).toHaveBeenCalledWith(PROJECT, "WEBSITE", [
      WEEKLY_ID,
      MONTHLY_ID,
    ]);
  });

  it("skips the query when there is nothing to list", async () => {
    expect(await listWebsiteReportShares(PROJECT, [])).toEqual({});
    expect(mocks.listForProject).not.toHaveBeenCalled();
  });

  it("revokes through ReportShares", async () => {
    const input = { projectId: PROJECT, shareId: "s1", userId: "u1" };
    expect(await revokeWebsiteReportShare(input)).toBe(true);
    expect(mocks.revoke).toHaveBeenCalledWith(input);
    mocks.revoke.mockResolvedValueOnce(false);
    expect(await revokeWebsiteReportShare(input)).toBe(false);
  });
});
