import { beforeEach, describe, expect, it, vi } from "vitest";

import { sampleView } from "@/lib/seo/reports/test-support";

// Bu dosyanın kanıtladığı (SC-F5 rapor ucu): bayrak kapalıyken ya da proje
// izin listesinde değilken 404 ve hiç veritabanı okuması yok; oturum yoksa
// 401; erişim hatası 404; rapor yoksa 404; başarıda 200 { report }. Hepsinde
// "private, no-store".

const mocks = vi.hoisted(() => ({
  requireUser: vi.fn(),
  requireProjectAccess: vi.fn(),
  readSeoReportView: vi.fn(),
}));

vi.mock("@/server/security/tenant-context", () => ({
  requireUser: mocks.requireUser,
  requireProjectAccess: mocks.requireProjectAccess,
}));
vi.mock("@/server/seo/reports/store", () => ({
  readSeoReportView: mocks.readSeoReportView,
}));

const { GET } = await import("./route");
const { AgentelseError } = await import("@/server/security/errors");

const NO_STORE = "private, no-store";

function call(projectId = "p1", reportId = "r1") {
  return GET(
    new Request(`http://localhost/api/projects/${projectId}/search/reports/${reportId}`),
    { params: Promise.resolve({ projectId, reportId }) },
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.unstubAllEnvs();
  vi.stubEnv("GSC_SYNC", "true");
  vi.stubEnv("SEO_REPORTS", "true");
  vi.stubEnv("GSC_ROLLOUT_PROJECTS", "");
  mocks.requireUser.mockResolvedValue({ userId: "u1" });
  mocks.requireProjectAccess.mockResolvedValue({
    workspaceId: "w1",
    projectId: "p1",
    defaultBrandId: "b1",
  });
  mocks.readSeoReportView.mockResolvedValue(sampleView("WEEKLY"));
});

describe("GET /api/projects/[projectId]/search/reports/[reportId]", () => {
  it("bayrak kapalıyken 404 verir ve hiçbir okuma yapmaz", async () => {
    vi.stubEnv("SEO_REPORTS", "false");
    const response = await call();
    expect(response.status).toBe(404);
    expect(response.headers.get("Cache-Control")).toBe(NO_STORE);
    expect(mocks.requireUser).not.toHaveBeenCalled();
    expect(mocks.readSeoReportView).not.toHaveBeenCalled();
  });

  it("GSC_SYNC kapalıyken de 404 verir", async () => {
    vi.stubEnv("GSC_SYNC", "false");
    const response = await call();
    expect(response.status).toBe(404);
    expect(mocks.readSeoReportView).not.toHaveBeenCalled();
  });

  it("izin listesi dışındaki projede 404 verir ve okumaz", async () => {
    vi.stubEnv("GSC_ROLLOUT_PROJECTS", "other-project");
    const response = await call();
    expect(response.status).toBe(404);
    expect(response.headers.get("Cache-Control")).toBe(NO_STORE);
    expect(mocks.requireUser).not.toHaveBeenCalled();
    expect(mocks.readSeoReportView).not.toHaveBeenCalled();
  });

  it("oturum yoksa 401 verir", async () => {
    mocks.requireUser.mockRejectedValue(new Error("no session"));
    const response = await call();
    expect(response.status).toBe(401);
    expect(response.headers.get("Cache-Control")).toBe(NO_STORE);
    expect(mocks.readSeoReportView).not.toHaveBeenCalled();
  });

  it("projeye erişim yoksa 404 verir ve raporu okumaz", async () => {
    mocks.requireProjectAccess.mockRejectedValue(
      new AgentelseError("PERMISSION_DENIED", "no"),
    );
    const response = await call();
    expect(response.status).toBe(404);
    expect(response.headers.get("Cache-Control")).toBe(NO_STORE);
    expect(mocks.readSeoReportView).not.toHaveBeenCalled();
  });

  it("rapor yoksa 404 verir (silinmiş rapor hemen kaybolur)", async () => {
    mocks.readSeoReportView.mockResolvedValue(null);
    const response = await call();
    expect(response.status).toBe(404);
    expect(response.headers.get("Cache-Control")).toBe(NO_STORE);
    expect(mocks.readSeoReportView).toHaveBeenCalledWith("p1", "r1");
  });

  it("başarıda 200 ve { report } döner, önbelleğe alınmaz", async () => {
    const response = await call();
    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe(NO_STORE);
    const body = (await response.json()) as { report: { id: string } };
    expect(body.report.id).toBe("report_1");
  });
});
