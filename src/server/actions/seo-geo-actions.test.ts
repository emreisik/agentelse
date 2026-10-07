import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { AgentelseError } from "@/server/security/errors";

// Bu dosyanın kanıtladığı (SC-F8 GEO eylemleri): ikisi de önce oturum, sonra
// proje erişimi ister (hata hâlinde başka hiçbir iş yapılmaz); bayrak ya da
// izin listesi yoksa iş yok; "I decided this" yalnız OWNER/ADMIN'e açıktır ve
// yalnız GEO2 ile GEO9'u kabul eder; başarıda denetim kaydı yalnız kontrol
// kimliğini taşır ve Search sayfası tazelenir; "Check again" proje üyesine açık.

const mocks = vi.hoisted(() => ({
  revalidatePath: vi.fn(),
  requireUser: vi.fn(),
  requireProjectAccess: vi.fn(),
  isWorkspaceManager: vi.fn(),
  record: vi.fn(),
  auditNow: vi.fn(),
  setAcknowledged: vi.fn(),
}));

vi.mock("next/cache", () => ({ revalidatePath: mocks.revalidatePath }));
vi.mock("@/server/security/tenant-context", () => ({
  requireUser: mocks.requireUser,
  requireProjectAccess: mocks.requireProjectAccess,
  isWorkspaceManager: mocks.isWorkspaceManager,
}));
vi.mock("@/server/repositories/audit-log.repository", () => ({
  AuditLogRepository: { record: mocks.record },
}));
vi.mock("@/server/seo/geo/runner", () => ({
  SeoGeo: { auditNow: mocks.auditNow },
}));
vi.mock("@/server/seo/geo/store", () => ({
  setAcknowledged: mocks.setAcknowledged,
}));

const { acknowledgeGeoCheckAction, auditGeoNowAction } = await import(
  "./seo-geo-actions"
);

const form = (fields: Record<string, string> = {}) => {
  const data = new FormData();
  data.set("projectId", "proj-1");
  for (const [key, value] of Object.entries(fields)) data.set(key, value);
  return data;
};

function expectNoWork() {
  expect(mocks.auditNow).not.toHaveBeenCalled();
  expect(mocks.setAcknowledged).not.toHaveBeenCalled();
  expect(mocks.record).not.toHaveBeenCalled();
  expect(mocks.revalidatePath).not.toHaveBeenCalled();
}

beforeEach(() => {
  for (const mock of Object.values(mocks)) mock.mockReset();
  vi.stubEnv("SEO_HEALTH", "true");
  vi.stubEnv("SEO_CRAWL", "true");
  vi.stubEnv("SEO_GEO", "true");
  vi.stubEnv("SEO_DEV_PROJECTS", "");
  vi.stubEnv("SEO_ROLLOUT_PROJECTS", "");
  mocks.requireUser.mockResolvedValue({ userId: "user-1", email: null });
  mocks.requireProjectAccess.mockResolvedValue({
    workspaceId: "ws-1",
    projectId: "proj-1",
    defaultBrandId: "brand-1",
  });
  mocks.isWorkspaceManager.mockResolvedValue(true);
  mocks.auditNow.mockResolvedValue({ ok: true });
  mocks.setAcknowledged.mockResolvedValue({ ok: true, score: 55 });
  mocks.record.mockResolvedValue({});
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("auth order", () => {
  it.each([
    ["auditGeoNow", () => auditGeoNowAction(form())],
    ["acknowledgeGeoCheck", () => acknowledgeGeoCheckAction(form({ checkId: "GEO2", on: "true" }))],
  ])("%s asks for the session first, then project access", async (_name, run) => {
    await run();
    expect(mocks.requireUser.mock.invocationCallOrder[0]!).toBeLessThan(
      mocks.requireProjectAccess.mock.invocationCallOrder[0]!,
    );
    expect(mocks.requireProjectAccess).toHaveBeenCalledWith("user-1", "proj-1");
  });

  it.each([
    ["auditGeoNow", () => auditGeoNowAction(form())],
    ["acknowledgeGeoCheck", () => acknowledgeGeoCheckAction(form({ checkId: "GEO2", on: "true" }))],
  ])("%s does nothing and answers in plain words without a session", async (_name, run) => {
    mocks.requireUser.mockRejectedValue(new AgentelseError("LOGIN_REQUIRED", "no"));
    expect(await run()).toEqual({ ok: false, message: "Please sign in again." });
    expect(mocks.requireProjectAccess).not.toHaveBeenCalled();
    expectNoWork();
  });

  it("answers that the project is unavailable without access", async () => {
    mocks.requireProjectAccess.mockRejectedValue(new AgentelseError("PERMISSION_DENIED", "no"));
    expect(await auditGeoNowAction(form())).toEqual({ ok: false, message: "This project isn't available." });
    expectNoWork();
  });

  it("never leaks an unexpected error text", async () => {
    mocks.auditNow.mockRejectedValue(new Error("secret internals"));
    const outcome = await auditGeoNowAction(form());
    expect(outcome).toEqual({ ok: false, message: "That did not work. Try again later." });
    expect(JSON.stringify(vi.mocked(console.error).mock.calls)).not.toContain("secret");
  });
});

describe("auditGeoNowAction", () => {
  it("runs the check for any project member and refreshes the page", async () => {
    mocks.isWorkspaceManager.mockResolvedValue(false);
    expect(await auditGeoNowAction(form())).toEqual({ ok: true });
    expect(mocks.auditNow).toHaveBeenCalledWith({ projectId: "proj-1", userId: "user-1" });
    expect(mocks.isWorkspaceManager).not.toHaveBeenCalled();
    expect(mocks.revalidatePath).toHaveBeenCalledWith("/projects/proj-1/arama");
  });

  it("relays the runner's refusal without refreshing", async () => {
    mocks.auditNow.mockResolvedValue({ ok: false, message: "You can check again in a few hours." });
    expect(await auditGeoNowAction(form())).toEqual({ ok: false, message: "You can check again in a few hours." });
    expect(mocks.revalidatePath).not.toHaveBeenCalled();
  });

  it("does nothing when the flag is off or the project is not allowed", async () => {
    vi.stubEnv("SEO_GEO", "false");
    expect(await auditGeoNowAction(form())).toMatchObject({ ok: false });
    vi.stubEnv("SEO_GEO", "true");
    vi.stubEnv("SEO_ROLLOUT_PROJECTS", "someone-else");
    expect(await auditGeoNowAction(form())).toMatchObject({ ok: false });
    expectNoWork();
  });
});

describe("acknowledgeGeoCheckAction", () => {
  it.each(["GEO2", "GEO9"])("accepts %s for a manager", async (checkId) => {
    expect(await acknowledgeGeoCheckAction(form({ checkId, on: "true" }))).toEqual({ ok: true });
    expect(mocks.setAcknowledged).toHaveBeenCalledWith("proj-1", checkId, true);
    expect(mocks.isWorkspaceManager).toHaveBeenCalledWith("user-1", "ws-1");
    expect(mocks.revalidatePath).toHaveBeenCalledWith("/projects/proj-1/arama");
    expect(mocks.record.mock.calls[0]![0]).toMatchObject({
      workspaceId: "ws-1",
      projectId: "proj-1",
      actorType: "USER",
      actorId: "user-1",
      action: "seo_geo.check_acknowledged",
      entityType: "SeoGeoAudit",
      metadata: { checkId },
    });
  });

  it("removes a decision with on=false", async () => {
    expect(await acknowledgeGeoCheckAction(form({ checkId: "GEO2", on: "false" }))).toEqual({ ok: true });
    expect(mocks.setAcknowledged).toHaveBeenCalledWith("proj-1", "GEO2", false);
    expect(mocks.record.mock.calls[0]![0].action).toBe("seo_geo.check_unacknowledged");
  });

  it.each(["GEO1", "GEO3", "GEO11", "geo2", "", "x"])("rejects %j before any work", async (checkId) => {
    expect(await acknowledgeGeoCheckAction(form({ checkId, on: "true" }))).toEqual({
      ok: false,
      message: "Something is missing. Reload the page and try again.",
    });
    expect(mocks.isWorkspaceManager).not.toHaveBeenCalled();
    expectNoWork();
  });

  it("rejects a bad on value", async () => {
    expect(await acknowledgeGeoCheckAction(form({ checkId: "GEO2", on: "yes" }))).toMatchObject({ ok: false });
    expectNoWork();
  });

  it("is for owners and admins only", async () => {
    mocks.isWorkspaceManager.mockResolvedValue(false);
    expect(await acknowledgeGeoCheckAction(form({ checkId: "GEO2", on: "true" }))).toEqual({
      ok: false,
      message: "Only workspace owners and admins can change this.",
    });
    expectNoWork();
  });

  it("does nothing when the flag is off", async () => {
    vi.stubEnv("SEO_GEO", "false");
    expect(await acknowledgeGeoCheckAction(form({ checkId: "GEO2", on: "true" }))).toMatchObject({ ok: false });
    expect(mocks.isWorkspaceManager).not.toHaveBeenCalled();
    expectNoWork();
  });

  it("asks for a check first when there is no audit to update", async () => {
    mocks.setAcknowledged.mockResolvedValue({ ok: false });
    expect(await acknowledgeGeoCheckAction(form({ checkId: "GEO9", on: "true" }))).toEqual({
      ok: false,
      message: "Run a check first, then try again.",
    });
    expect(mocks.record).not.toHaveBeenCalled();
    expect(mocks.revalidatePath).not.toHaveBeenCalled();
  });
});
