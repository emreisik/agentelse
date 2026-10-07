import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  sampleMonthlyCard,
  samplePlanCard,
  sampleWeeklyCard,
} from "@/lib/website-analytics/reports/test-fixtures";
import type { WebsiteReportCardData } from "@/lib/website-analytics/reports/types";

// Bu dosyanın kanıtladığı (GA-F8 Markdown dışa aktarma ucu): oturumsuz 401,
// erişimsiz ve yönetici olmayan için 404; bayrak, yerel bekçi ve reportShareOn
// kapalıyken 404 (hiçbir sorgu olmadan); md dışı biçim ve kötü kart kimliği 404;
// md yanıtı başlıkları, ajans adı ve Agentelse içermeyen gövde; denetim satırı
// yalnız çeşit ve biçimi taşır.

const mocks = vi.hoisted(() => ({
  requireUser: vi.fn(),
  requireProjectAccess: vi.fn(),
  isWorkspaceManager: vi.fn(),
  load: vi.fn(),
  brandingGet: vi.fn(),
  auditRecord: vi.fn(),
  projectFind: vi.fn(),
}));

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
vi.mock("@/server/repositories/audit-log.repository", () => ({
  AuditLogRepository: { record: mocks.auditRecord },
}));
vi.mock("@/server/website-analytics/agency/share", () => ({
  WEBSITE_SHARE_FOOTER_FALLBACK: "Numbers from Google Analytics.",
  loadWebsiteReportForClient: mocks.load,
}));

const { GET } = await import("./route");
const { AgentelseError } = await import("@/server/security/errors");

const WEEKLY_ID = "garep_weekly_proj_1_2026-09-28";

const call = (query = `command=${WEEKLY_ID}&format=md`) =>
  GET(
    new Request(`https://app.example.com/api/projects/proj_1/client-report?${query}`),
    { params: Promise.resolve({ projectId: "proj_1" }) },
  );

beforeEach(() => {
  vi.unstubAllEnvs();
  vi.stubEnv("GA_AGENCY", "true");
  vi.stubEnv("GA_SYNC", "true");
  vi.stubEnv("NODE_ENV", "test");
  for (const mock of Object.values(mocks)) mock.mockReset();
  mocks.requireUser.mockResolvedValue({ userId: "user_1" });
  mocks.requireProjectAccess.mockResolvedValue({ workspaceId: "ws_1" });
  mocks.isWorkspaceManager.mockResolvedValue(true);
  mocks.load.mockResolvedValue(
    sampleWeeklyCard({ title: "Agentelse weekly report" }),
  );
  mocks.projectFind.mockResolvedValue({ name: "Shop Ltd" });
  mocks.brandingGet.mockResolvedValue({
    displayName: "Acme Digital",
    accent: "blue",
    footer: null,
    logoAssetId: null,
  });
  mocks.auditRecord.mockResolvedValue(undefined);
});

describe("GET client-report", () => {
  it("downloads Markdown with the right headers", async () => {
    const response = await call();
    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toBe(
      "text/markdown; charset=utf-8",
    );
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
    const disposition = response.headers.get("Content-Disposition") ?? "";
    expect(disposition).toMatch(/^attachment; filename="[a-z0-9-]+\.md"$/);
    expect(mocks.load).toHaveBeenCalledWith({
      projectId: "proj_1",
      commandId: WEEKLY_ID,
      allowPlan: true,
    });
  });

  it("writes the agency name and no Agentelse into the body", async () => {
    const text = await (await call()).text();
    expect(text.startsWith("# Acme Digital weekly report")).toBe(true);
    expect(text).toContain("Prepared by Acme Digital");
    expect(text).toContain("Numbers from Google Analytics.");
    expect(text.toLowerCase()).not.toContain("agentelse");
  });

  it("exports a plan and a monthly card", async () => {
    mocks.load.mockResolvedValue(samplePlanCard());
    expect((await call("command=garep_plan_proj_1_2026-10&format=md")).status).toBe(200);
    mocks.load.mockResolvedValue(sampleMonthlyCard());
    expect((await call("command=garep_monthly_proj_1_2026-09&format=md")).status).toBe(200);
  });

  it("records only ids, the variant and the format in the audit log", async () => {
    await call();
    expect(mocks.auditRecord).toHaveBeenCalledTimes(1);
    const entry = mocks.auditRecord.mock.calls[0]?.[0];
    expect(entry).toMatchObject({
      workspaceId: "ws_1",
      projectId: "proj_1",
      actorType: "USER",
      actorId: "user_1",
      action: "ga_client_report.exported",
      entityId: WEEKLY_ID,
      metadata: { variant: "weekly", format: "md" },
    });
    expect(JSON.stringify(entry)).not.toMatch(/4760|4,760|Example Shop/);
  });

  it("answers 401 without a session", async () => {
    mocks.requireUser.mockRejectedValue(new Error("no session"));
    expect((await call()).status).toBe(401);
  });

  it("answers 404 without project access and for non-managers", async () => {
    mocks.requireProjectAccess.mockRejectedValue(
      new AgentelseError("PERMISSION_DENIED", "No access"),
    );
    expect((await call()).status).toBe(404);
    mocks.requireProjectAccess.mockResolvedValue({ workspaceId: "ws_1" });
    mocks.isWorkspaceManager.mockResolvedValue(false);
    expect((await call()).status).toBe(404);
    expect(mocks.load).not.toHaveBeenCalled();
  });

  it("rethrows an unexpected access failure", async () => {
    mocks.requireProjectAccess.mockRejectedValue(new Error("db down"));
    await expect(call()).rejects.toThrow("db down");
  });

  it.each([
    ["GA_AGENCY", "false"],
    ["GA_SYNC", "false"],
  ])("answers 404 before any lookup when %s=%s", async (name, value) => {
    vi.stubEnv(name, value);
    expect((await call()).status).toBe(404);
    expect(mocks.requireUser).not.toHaveBeenCalled();
    expect(mocks.load).not.toHaveBeenCalled();
  });

  it("answers 404 for a dev process outside the allow list", async () => {
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("DATABASE_URL", "postgresql://u:p@db.example.com/live");
    vi.stubEnv("GA_SYNC_DEV_PROJECTS", "");
    expect((await call()).status).toBe(404);
    expect(mocks.requireUser).not.toHaveBeenCalled();
  });

  it("answers 404 for another format, a missing command and an unknown card", async () => {
    expect((await call(`command=${WEEKLY_ID}&format=html`)).status).toBe(404);
    expect((await call(`command=${WEEKLY_ID}`)).status).toBe(404);
    expect((await call("format=md")).status).toBe(404);
    mocks.load.mockResolvedValue(null);
    expect((await call()).status).toBe(404);
    expect(mocks.auditRecord).not.toHaveBeenCalled();
  });

  it("answers 404 for a card that cannot be converted", async () => {
    mocks.load.mockResolvedValue({
      ...sampleWeeklyCard(),
      variant: "pulse",
      body: { variant: "pulse" },
    } as unknown as WebsiteReportCardData);
    expect((await call()).status).toBe(404);
  });
});
