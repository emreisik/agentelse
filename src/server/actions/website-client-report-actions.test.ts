import { beforeEach, describe, expect, it, vi } from "vitest";

// Bu dosyanın kanıtladığı (GA-F8 müşteri bağlantısı eylemleri): yalnız
// OWNER/ADMIN; bayrak, yerel bekçi ve reportShareOn kapalıyken iş yapılmaz;
// onay kutusu ve gün sayısı doğrulanır; hız sınırı mesajı; share.ts sonuç
// kodları sabit mesajlara eşlenir; başarıda /r/<belirteç> adresi döner ve sayfa
// yenilenir; iptal yalnız yönetici.

const mocks = vi.hoisted(() => ({
  revalidatePath: vi.fn(),
  requireUser: vi.fn(),
  requireProjectAccess: vi.fn(),
  isWorkspaceManager: vi.fn(),
  isRateLimited: vi.fn(),
  createShare: vi.fn(),
  revokeShare: vi.fn(),
}));

vi.mock("next/cache", () => ({ revalidatePath: mocks.revalidatePath }));
vi.mock("@/server/security/tenant-context", () => ({
  requireUser: mocks.requireUser,
  requireProjectAccess: mocks.requireProjectAccess,
  isWorkspaceManager: mocks.isWorkspaceManager,
}));
vi.mock("@/lib/rate-limit", () => ({ isRateLimited: mocks.isRateLimited }));
vi.mock("@/lib/report-share/flags", () => ({
  reportShareOn: (env: Readonly<Record<string, string | undefined>> = process.env) =>
    env.GA_AGENCY === "true",
}));
vi.mock("@/lib/report-share/types", () => ({ REPORT_SHARE_DAYS: [7, 30, 90] }));
vi.mock("@/server/website-analytics/agency/share", () => ({
  createWebsiteReportShare: mocks.createShare,
  revokeWebsiteReportShare: mocks.revokeShare,
}));

const { createWebsiteReportShareAction, revokeWebsiteReportShareAction } =
  await import("./website-client-report-actions");
const { AgentelseError } = await import("@/server/security/errors");

const form = (fields: Record<string, string> = {}) => {
  const data = new FormData();
  data.set("projectId", "proj_1");
  data.set("commandId", "garep_weekly_proj_1_2026-09-28");
  data.set("days", "30");
  data.set("confirm", "on");
  for (const [key, value] of Object.entries(fields)) data.set(key, value);
  return data;
};

beforeEach(() => {
  vi.unstubAllEnvs();
  vi.stubEnv("GA_AGENCY", "true");
  vi.stubEnv("GA_SYNC", "true");
  vi.stubEnv("NODE_ENV", "test");
  for (const mock of Object.values(mocks)) mock.mockReset();
  mocks.requireUser.mockResolvedValue({ userId: "user_1" });
  mocks.requireProjectAccess.mockResolvedValue({ workspaceId: "ws_1" });
  mocks.isWorkspaceManager.mockResolvedValue(true);
  mocks.isRateLimited.mockReturnValue(false);
  mocks.createShare.mockResolvedValue({
    ok: true,
    url: "https://app.example.com/r/tok_abc",
    expiresAt: "2026-11-04T10:00:00.000Z",
  });
  mocks.revokeShare.mockResolvedValue(true);
});

describe("createWebsiteReportShareAction", () => {
  it("creates a link and returns the url once", async () => {
    const result = await createWebsiteReportShareAction(form());
    expect(result).toEqual({
      ok: true,
      url: "https://app.example.com/r/tok_abc",
      expiresAt: "2026-11-04T10:00:00.000Z",
    });
    expect(result.ok && result.url).toMatch(/\/r\/[A-Za-z0-9_-]+$/);
    expect(mocks.createShare).toHaveBeenCalledWith({
      workspaceId: "ws_1",
      projectId: "proj_1",
      userId: "user_1",
      commandId: "garep_weekly_proj_1_2026-09-28",
      days: 30,
      confirmPublic: true,
    });
    expect(mocks.revalidatePath).toHaveBeenCalledWith("/projects/proj_1/site");
    expect(mocks.isRateLimited).toHaveBeenCalledWith("share-create:user_1", 20, 3_600_000);
  });

  it("is for workspace managers only and checks before anything else", async () => {
    mocks.isWorkspaceManager.mockResolvedValue(false);
    expect(await createWebsiteReportShareAction(form())).toEqual({
      ok: false,
      message: "Only a workspace owner or admin can share reports.",
    });
    expect(mocks.createShare).not.toHaveBeenCalled();
    expect(mocks.isRateLimited).not.toHaveBeenCalled();
  });

  it.each([
    ["GA_AGENCY", "false"],
    ["GA_SYNC", "false"],
  ])("refuses when %s=%s", async (name, value) => {
    vi.stubEnv(name, value);
    expect(await createWebsiteReportShareAction(form())).toEqual({
      ok: false,
      message: "Client links aren't available right now.",
    });
    expect(mocks.createShare).not.toHaveBeenCalled();
  });

  it("refuses an allow-list miss in a shared-database dev process", async () => {
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("DATABASE_URL", "postgresql://u:p@db.example.com/live");
    vi.stubEnv("GA_SYNC_DEV_PROJECTS", "");
    const result = await createWebsiteReportShareAction(form());
    expect(result.ok).toBe(false);
    expect(mocks.createShare).not.toHaveBeenCalled();
  });

  it("needs the confirmation", async () => {
    const data = form();
    data.delete("confirm");
    expect(await createWebsiteReportShareAction(data)).toEqual({
      ok: false,
      message: "Confirm that anyone with the link can see this report.",
    });
    expect(await createWebsiteReportShareAction(form({ confirm: "true" }))).toMatchObject({
      ok: false,
    });
    expect(mocks.createShare).not.toHaveBeenCalled();
  });

  it.each(["", "abc", "45", "0", "-7"])("refuses days=%j", async (days) => {
    expect(await createWebsiteReportShareAction(form({ days }))).toEqual({
      ok: false,
      message: "Choose how long the link should work.",
    });
    expect(mocks.createShare).not.toHaveBeenCalled();
  });

  it.each(["7", "30", "90"])("accepts days=%s", async (days) => {
    expect((await createWebsiteReportShareAction(form({ days }))).ok).toBe(true);
  });

  it("answers the rate limit with a fixed message", async () => {
    mocks.isRateLimited.mockReturnValue(true);
    expect(await createWebsiteReportShareAction(form())).toEqual({
      ok: false,
      message: "Too many links created. Try again in a while.",
    });
    expect(mocks.createShare).not.toHaveBeenCalled();
  });

  it.each([
    [
      "limit",
      "This project already has the maximum number of active client links. Revoke one first.",
    ],
    ["bad_report", "This report can't be shared."],
    ["bad_days", "Choose how long the link should work."],
    ["not_confirmed", "Confirm that anyone with the link can see this report."],
    ["off", "Client links aren't available right now."],
  ])("maps %s to a fixed message", async (reason, message) => {
    mocks.createShare.mockResolvedValue({ ok: false, reason });
    expect(await createWebsiteReportShareAction(form())).toEqual({
      ok: false,
      message,
    });
    expect(mocks.revalidatePath).not.toHaveBeenCalled();
  });

  it("answers an access error with its message and anything else generically", async () => {
    mocks.requireProjectAccess.mockRejectedValueOnce(
      new AgentelseError("PERMISSION_DENIED", "No access to this project"),
    );
    expect(await createWebsiteReportShareAction(form())).toEqual({
      ok: false,
      message: "No access to this project",
    });
    mocks.createShare.mockRejectedValueOnce(new Error("db password leaked"));
    expect(await createWebsiteReportShareAction(form())).toEqual({
      ok: false,
      message: "Something went wrong. Try again.",
    });
  });
});

describe("revokeWebsiteReportShareAction", () => {
  const revokeForm = () => form({ shareId: "share_1" });

  it("revokes and refreshes the site page", async () => {
    expect(await revokeWebsiteReportShareAction(revokeForm())).toEqual({ ok: true });
    expect(mocks.revokeShare).toHaveBeenCalledWith({
      projectId: "proj_1",
      shareId: "share_1",
      userId: "user_1",
    });
    expect(mocks.revalidatePath).toHaveBeenCalledWith("/projects/proj_1/site");
  });

  it("is for workspace managers only", async () => {
    mocks.isWorkspaceManager.mockResolvedValue(false);
    expect(await revokeWebsiteReportShareAction(revokeForm())).toEqual({
      ok: false,
      message: "Only a workspace owner or admin can share reports.",
    });
    expect(mocks.revokeShare).not.toHaveBeenCalled();
  });

  it("refuses when the flag is off", async () => {
    vi.stubEnv("GA_AGENCY", "false");
    expect(await revokeWebsiteReportShareAction(revokeForm())).toMatchObject({
      ok: false,
    });
    expect(mocks.revokeShare).not.toHaveBeenCalled();
  });

  it("says so when the link is already gone", async () => {
    mocks.revokeShare.mockResolvedValue(false);
    expect(await revokeWebsiteReportShareAction(revokeForm())).toEqual({
      ok: false,
      message: "This link was already revoked or no longer exists.",
    });
    expect(
      await revokeWebsiteReportShareAction(form({ shareId: "" })),
    ).toMatchObject({ ok: false });
  });
});
