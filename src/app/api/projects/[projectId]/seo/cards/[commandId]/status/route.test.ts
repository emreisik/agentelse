import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Durum ucu: bayrak, oturum ve proje yetkisi; yanıt JSON ve önbelleksiz.

const requireUser = vi.fn();
const requireProjectAccess = vi.fn();
vi.mock("@/server/security/tenant-context", () => ({
  requireUser,
  requireProjectAccess,
}));

const loadSeoCardStatus = vi.fn();
vi.mock("@/server/modules/seo/card-status", () => ({ loadSeoCardStatus }));

const { GET } = await import("./route");
const { AgentelseError } = await import("@/server/security/errors");

const params = {
  params: Promise.resolve({ projectId: "p1", commandId: "c1" }),
};
const request = () =>
  new Request("http://localhost/api/projects/p1/seo/cards/c1/status");

const original = process.env.SEO_ACTIONS;

beforeEach(() => {
  vi.clearAllMocks();
  process.env.SEO_ACTIONS = "true";
  requireUser.mockResolvedValue({ userId: "u1", email: null });
  requireProjectAccess.mockResolvedValue({ workspaceId: "ws1" });
});

afterEach(() => {
  if (original === undefined) delete process.env.SEO_ACTIONS;
  else process.env.SEO_ACTIONS = original;
});

describe("GET /api/projects/[projectId]/seo/cards/[commandId]/status", () => {
  it("bayrak kapalıyken 404 döner ve oturuma bakmaz", async () => {
    delete process.env.SEO_ACTIONS;
    const response = await GET(request(), params);
    expect(response.status).toBe(404);
    expect(requireUser).not.toHaveBeenCalled();
    expect(loadSeoCardStatus).not.toHaveBeenCalled();
  });

  it("oturum yoksa 401 döner", async () => {
    requireUser.mockRejectedValue(
      new AgentelseError("LOGIN_REQUIRED", "Authentication required"),
    );
    const response = await GET(request(), params);
    expect(response.status).toBe(401);
    expect(loadSeoCardStatus).not.toHaveBeenCalled();
  });

  it("erişimi olmayan proje için 404 döner", async () => {
    requireProjectAccess.mockRejectedValue(
      new AgentelseError("NOT_FOUND", "Project not found"),
    );
    const response = await GET(request(), params);
    expect(response.status).toBe(404);
    expect(loadSeoCardStatus).not.toHaveBeenCalled();
  });

  it("kart yoksa 404 döner", async () => {
    loadSeoCardStatus.mockResolvedValue(null);
    const response = await GET(request(), params);
    expect(response.status).toBe(404);
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
  });

  it("durumu JSON ve önbelleksiz döndürür", async () => {
    const status = {
      piece: { status: "APPROVED", label: "On calendar for Fri 9 Oct, 10:00", at: "2026-10-09T07:00:00.000Z" },
      action: null,
      suggestion: { topic: "running shoes" },
      removed: false,
    };
    loadSeoCardStatus.mockResolvedValue(status);
    const response = await GET(request(), params);
    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
    expect(await response.json()).toEqual(status);
    expect(loadSeoCardStatus).toHaveBeenCalledWith("p1", "c1");
  });
});
