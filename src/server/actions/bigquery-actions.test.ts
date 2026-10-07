import { beforeEach, describe, expect, it, vi } from "vitest";

// Bu dosyanın kanıtladığı (GA-F8 BigQuery eylemleri): OWNER/ADMIN dışı reddedilir,
// geliştirme koruması/bayrak kapalıyken yazım yok, veri kümesi kullanıcı alanı
// DEĞİL (mülk kimliğinden hesaplanır), ikinci proje alanı (faturalama projesi) kabul
// edilmez, geçersiz kimlikler reddedilir, yenileme 1 saatte bir.

const mocks = vi.hoisted(() => ({
  revalidatePath: vi.fn(),
  requireUser: vi.fn(),
  requireProjectAccess: vi.fn(),
  isWorkspaceManager: vi.fn(),
  linkFindFirst: vi.fn(),
  verify: vi.fn(),
  remove: vi.fn(),
  refresh: vi.fn(),
}));

vi.mock("next/cache", () => ({ revalidatePath: mocks.revalidatePath }));
vi.mock("@/server/security/tenant-context", () => ({
  requireUser: mocks.requireUser,
  requireProjectAccess: mocks.requireProjectAccess,
  isWorkspaceManager: mocks.isWorkspaceManager,
}));
vi.mock("@/lib/prisma", () => ({
  prisma: { gaPropertyLink: { findFirst: mocks.linkFindFirst } },
}));
vi.mock("@/server/website-analytics/bigquery/verify", () => ({
  verifyAndSaveBigQuerySource: mocks.verify,
}));
vi.mock("@/server/website-analytics/bigquery/store", () => ({
  removeBigQuerySource: mocks.remove,
  requestBigQueryRefresh: mocks.refresh,
}));

const {
  refreshBigQuerySourceAction,
  removeBigQuerySourceAction,
  saveBigQuerySourceAction,
} = await import("./bigquery-actions");

function form(values: Record<string, string> = {}): FormData {
  const data = new FormData();
  data.set("projectId", "proj1");
  data.set("linkId", "link1");
  data.set("gcpProjectId", "my-company-123456");
  for (const [key, value] of Object.entries(values)) data.set(key, value);
  return data;
}

beforeEach(() => {
  vi.stubEnv("GA_AGENCY", "true");
  vi.stubEnv("GA_SYNC", "true");
  vi.stubEnv("GA_BIGQUERY", "true");
  vi.stubEnv("NODE_ENV", "test");
  mocks.revalidatePath.mockReset();
  mocks.requireUser.mockReset().mockResolvedValue({ userId: "user1" });
  mocks.requireProjectAccess.mockReset().mockResolvedValue({ workspaceId: "ws1" });
  mocks.isWorkspaceManager.mockReset().mockResolvedValue(true);
  mocks.linkFindFirst.mockReset().mockResolvedValue({ propertyId: "424242" });
  mocks.verify.mockReset().mockResolvedValue({ ok: true });
  mocks.remove.mockReset().mockResolvedValue("ok");
  mocks.refresh.mockReset().mockResolvedValue("ok");
});

describe("gates", () => {
  it.each([
    ["save", saveBigQuerySourceAction],
    ["remove", removeBigQuerySourceAction],
    ["refresh", refreshBigQuerySourceAction],
  ] as const)("refuses a non-manager on %s", async (_name, action) => {
    mocks.isWorkspaceManager.mockResolvedValue(false);
    const result = await action(form());
    expect(result).toEqual({
      ok: false,
      message: "Only workspace owners and admins can change this.",
    });
    expect(mocks.verify).not.toHaveBeenCalled();
    expect(mocks.remove).not.toHaveBeenCalled();
    expect(mocks.refresh).not.toHaveBeenCalled();
  });

  it.each([
    ["save", saveBigQuerySourceAction],
    ["remove", removeBigQuerySourceAction],
    ["refresh", refreshBigQuerySourceAction],
  ] as const)("refuses %s while the flag is off", async (_name, action) => {
    vi.stubEnv("GA_BIGQUERY", "false");
    expect(await action(form())).toEqual({
      ok: false,
      message: "BigQuery export isn't available for this project.",
    });
    expect(mocks.verify).not.toHaveBeenCalled();
    expect(mocks.remove).not.toHaveBeenCalled();
    expect(mocks.refresh).not.toHaveBeenCalled();
  });

  it("refuses a project outside the dev allow-list", async () => {
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("DATABASE_URL", "postgresql://user:pass@ep-live.neon.tech/db");
    vi.stubEnv("GA_SYNC_DEV_PROJECTS", "someone-else");
    const result = await saveBigQuerySourceAction(form());
    expect(result.ok).toBe(false);
    expect(mocks.verify).not.toHaveBeenCalled();
  });

  it("refuses a request without a property", async () => {
    const result = await saveBigQuerySourceAction(form({ linkId: "" }));
    expect(result).toEqual({
      ok: false,
      message: "Google Analytics isn't connected for this property.",
    });
    expect(mocks.verify).not.toHaveBeenCalled();
  });

  it("maps session and access errors to fixed messages without leaking", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    mocks.requireProjectAccess.mockRejectedValue(new Error("db password leaked"));
    const result = await saveBigQuerySourceAction(form());
    expect(result).toEqual({ ok: false, message: "Could not save the BigQuery export." });
    expect(JSON.stringify(spy.mock.calls)).not.toContain("password");
    spy.mockRestore();
  });
});

describe("saveBigQuerySourceAction", () => {
  it("computes the dataset from the property id and passes the single project", async () => {
    expect(await saveBigQuerySourceAction(form({ location: "EU" }))).toEqual({ ok: true });
    expect(mocks.verify).toHaveBeenCalledWith({
      projectId: "proj1",
      linkId: "link1",
      userId: "user1",
      config: {
        gcpProjectId: "my-company-123456",
        datasetId: "analytics_424242",
        location: "EU",
      },
    });
    expect(mocks.linkFindFirst.mock.calls[0]![0].where).toEqual({
      id: "link1",
      projectId: "proj1",
    });
    expect(mocks.revalidatePath).toHaveBeenCalledWith("/projects/proj1/site");
  });

  it("cannot be told another dataset or a second project by the form", async () => {
    await saveBigQuerySourceAction(
      form({
        datasetId: "analytics_999999",
        billingProjectId: "victim-project-999999",
        datasetProjectId: "victim-project-999999",
      }),
    );
    const config = mocks.verify.mock.calls[0]![0].config;
    expect(config.datasetId).toBe("analytics_424242");
    expect(Object.keys(config).sort()).toEqual(["datasetId", "gcpProjectId"]);
    expect(JSON.stringify(mocks.verify.mock.calls)).not.toContain("victim");
  });

  it("omits an empty location", async () => {
    await saveBigQuerySourceAction(form({ location: "  " }));
    expect(mocks.verify.mock.calls[0]![0].config).not.toHaveProperty("location");
  });

  it("returns the verification message for invalid ids", async () => {
    mocks.verify.mockResolvedValue({
      ok: false,
      code: "invalid",
      message: "Enter the id of the Google Cloud project that holds the export, for example my-company-123456.",
    });
    const result = await saveBigQuerySourceAction(form({ gcpProjectId: "Bad Id" }));
    expect(result.ok).toBe(false);
    expect(mocks.revalidatePath).not.toHaveBeenCalled();
  });

  it("refuses a link that is not in the project", async () => {
    mocks.linkFindFirst.mockResolvedValue(null);
    expect(await saveBigQuerySourceAction(form())).toEqual({
      ok: false,
      message: "Google Analytics isn't connected for this property.",
    });
    expect(mocks.verify).not.toHaveBeenCalled();
  });
});

describe("removeBigQuerySourceAction", () => {
  it("removes the source and records who did it", async () => {
    expect(await removeBigQuerySourceAction(form())).toEqual({ ok: true });
    expect(mocks.remove).toHaveBeenCalledWith({
      projectId: "proj1",
      linkId: "link1",
      userId: "user1",
    });
  });

  it("reports a missing source", async () => {
    mocks.remove.mockResolvedValue("not_found");
    expect(await removeBigQuerySourceAction(form())).toEqual({
      ok: false,
      message: "BigQuery isn't set up for this property.",
    });
  });
});

describe("refreshBigQuerySourceAction", () => {
  it("requests a refresh", async () => {
    expect(await refreshBigQuerySourceAction(form())).toEqual({ ok: true });
    expect(mocks.refresh).toHaveBeenCalledWith({ projectId: "proj1", linkId: "link1" });
  });

  it("throttles a refresh within the hour", async () => {
    mocks.refresh.mockResolvedValue("throttled");
    expect(await refreshBigQuerySourceAction(form())).toEqual({
      ok: false,
      message: "Already refreshed recently.",
    });
    expect(mocks.revalidatePath).not.toHaveBeenCalled();
  });

  it("reports a missing source", async () => {
    mocks.refresh.mockResolvedValue("not_found");
    expect(await refreshBigQuerySourceAction(form())).toMatchObject({ ok: false });
  });
});
