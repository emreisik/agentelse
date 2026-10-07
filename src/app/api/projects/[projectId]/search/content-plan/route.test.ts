import { beforeEach, describe, expect, it, vi } from "vitest";

// Bu dosyanın kanıtladığı (SC-F7 plan ucu): bayrak kapalıyken ya da proje izin
// listesinde değilken 404 ve oturuma da veritabanına da dokunulmaz; oturum
// yoksa 401; erişim hatası 404; başarıda 200 { plan, currentMonth }; geçersiz
// ?month= yok sayılır. Hepsinde (hata yanıtları dahil) "private, no-store".

const mocks = vi.hoisted(() => ({
  requireUser: vi.fn(),
  requireProjectAccess: vi.fn(),
  loadContentPlanView: vi.fn(),
  currentLocalMonth: vi.fn(),
}));

vi.mock("@/server/security/tenant-context", () => ({
  requireUser: mocks.requireUser,
  requireProjectAccess: mocks.requireProjectAccess,
}));
vi.mock("@/server/seo/content-plan/store", () => ({
  loadContentPlanView: mocks.loadContentPlanView,
  currentLocalMonth: mocks.currentLocalMonth,
}));

const { GET } = await import("./route");
const { AgentelseError } = await import("@/server/security/errors");

const NO_STORE = "private, no-store";

function call(projectId = "p1", query = "") {
  return GET(
    new Request(
      `http://localhost/api/projects/${projectId}/search/content-plan${query}`,
    ),
    { params: Promise.resolve({ projectId }) },
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.unstubAllEnvs();
  vi.stubEnv("SEO_CONTENT_PLAN", "true");
  vi.stubEnv("GSC_SYNC", "true");
  vi.stubEnv("SEO_INSIGHTS", "on");
  vi.stubEnv("GSC_SEARCH_PAGE", "true");
  vi.stubEnv("GSC_ROLLOUT_PROJECTS", "");
  mocks.requireUser.mockResolvedValue({ userId: "u1" });
  mocks.requireProjectAccess.mockResolvedValue({
    workspaceId: "w1",
    projectId: "p1",
    defaultBrandId: "b1",
  });
  mocks.loadContentPlanView.mockResolvedValue({ month: "2026-10" });
  mocks.currentLocalMonth.mockResolvedValue("2026-10");
});

describe("GET /api/projects/[projectId]/search/content-plan", () => {
  it("bayrak kapalıyken 404 verir ve oturuma da veriye de dokunmaz", async () => {
    vi.stubEnv("SEO_CONTENT_PLAN", "false");
    const response = await call();
    expect(response.status).toBe(404);
    expect(response.headers.get("Cache-Control")).toBe(NO_STORE);
    expect(await response.json()).toEqual({ error: "Not found" });
    expect(mocks.requireUser).not.toHaveBeenCalled();
    expect(mocks.requireProjectAccess).not.toHaveBeenCalled();
    expect(mocks.loadContentPlanView).not.toHaveBeenCalled();
    expect(mocks.currentLocalMonth).not.toHaveBeenCalled();
  });

  it("Search sayfası bayrağı kapalıyken de 404 verir", async () => {
    vi.stubEnv("GSC_SEARCH_PAGE", "false");
    const response = await call();
    expect(response.status).toBe(404);
    expect(mocks.loadContentPlanView).not.toHaveBeenCalled();
  });

  it("izin listesi dışındaki projede 404 verir", async () => {
    vi.stubEnv("GSC_ROLLOUT_PROJECTS", "other-project");
    const response = await call();
    expect(response.status).toBe(404);
    expect(response.headers.get("Cache-Control")).toBe(NO_STORE);
    expect(mocks.requireUser).not.toHaveBeenCalled();
  });

  it("oturum yoksa 401 verir", async () => {
    mocks.requireUser.mockRejectedValue(new Error("no session"));
    const response = await call();
    expect(response.status).toBe(401);
    expect(response.headers.get("Cache-Control")).toBe(NO_STORE);
    expect(mocks.loadContentPlanView).not.toHaveBeenCalled();
  });

  it("erişim hatasında 404 verir", async () => {
    mocks.requireProjectAccess.mockRejectedValue(
      new AgentelseError("PERMISSION_DENIED", "denied"),
    );
    const response = await call();
    expect(response.status).toBe(404);
    expect(response.headers.get("Cache-Control")).toBe(NO_STORE);
    expect(mocks.loadContentPlanView).not.toHaveBeenCalled();
  });

  it("başarıda plan ve şimdiki yerel ayı döndürür", async () => {
    const response = await call("p1", "?month=2026-09");
    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe(NO_STORE);
    expect(await response.json()).toEqual({
      plan: { month: "2026-10" },
      currentMonth: "2026-10",
    });
    expect(mocks.loadContentPlanView).toHaveBeenCalledWith(
      "p1",
      expect.objectContaining({ month: "2026-09" }),
    );
  });

  it("plan yoksa plan: null döner", async () => {
    mocks.loadContentPlanView.mockResolvedValue(null);
    const response = await call();
    expect(await response.json()).toEqual({
      plan: null,
      currentMonth: "2026-10",
    });
  });

  it.each(["?month=2026-13", "?month=nope", "?month=2026-1", "?month="])(
    "geçersiz ay (%s) yok sayılır",
    async (query) => {
      const response = await call("p1", query);
      expect(response.status).toBe(200);
      const options = mocks.loadContentPlanView.mock.calls[0]?.[1] as Record<
        string,
        unknown
      >;
      expect(options.month).toBeUndefined();
    },
  );

  it("okuma hatasında 500 verir ama yine önbelleğe almaz", async () => {
    mocks.loadContentPlanView.mockRejectedValue(new Error("db down"));
    const response = await call();
    expect(response.status).toBe(500);
    expect(response.headers.get("Cache-Control")).toBe(NO_STORE);
    expect(JSON.stringify(await response.json())).not.toContain("db down");
  });
});
