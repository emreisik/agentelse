import { beforeEach, describe, expect, it, vi } from "vitest";

// The route's own job (the state itself is covered by facebook-share.test.ts):
// no session is a 401, a missing creative and another workspace's creative are
// the same 404, and otherwise the share state of the creative's own project is
// returned uncached.

const requireUser = vi.fn();
const requireProjectAccess = vi.fn();
vi.mock("@/server/security/tenant-context", () => ({
  requireUser,
  requireProjectAccess,
}));

const creativeFindUnique = vi.fn();
vi.mock("@/lib/prisma", () => ({
  prisma: { creative: { findUnique: creativeFindUnique } },
}));

const readFacebookShareState = vi.fn();
vi.mock("@/server/commands/facebook-share", () => ({ readFacebookShareState }));

const { GET } = await import("./route");
const { AgentelseError } = await import("@/server/security/errors");

const params = { params: Promise.resolve({ creativeId: "cr-1" }) };
const request = () =>
  new Request("http://localhost/api/creatives/cr-1/facebook-share");

beforeEach(() => {
  vi.clearAllMocks();
  requireUser.mockResolvedValue({ userId: "user-1", email: null });
  requireProjectAccess.mockResolvedValue({
    workspaceId: "ws-1",
    projectId: "proj-1",
    defaultBrandId: "brand-1",
  });
  creativeFindUnique.mockResolvedValue({ projectId: "proj-1" });
  readFacebookShareState.mockResolvedValue({
    kind: "ready",
    pageName: "Web Health",
  });
});

describe("GET /api/creatives/[creativeId]/facebook-share", () => {
  it("returns 401 without a session", async () => {
    requireUser.mockRejectedValue(
      new AgentelseError("LOGIN_REQUIRED", "Authentication required"),
    );
    expect((await GET(request(), params)).status).toBe(401);
    expect(readFacebookShareState).not.toHaveBeenCalled();
  });

  it("answers a missing creative and another workspace's creative with the same 404", async () => {
    creativeFindUnique.mockResolvedValue(null);
    const missing = await GET(request(), params);

    creativeFindUnique.mockResolvedValue({ projectId: "proj-other" });
    requireProjectAccess.mockRejectedValue(
      new AgentelseError(
        "PERMISSION_DENIED",
        "User user-1 has no access to workspace ws-9",
      ),
    );
    const foreign = await GET(request(), params);

    expect(missing.status).toBe(404);
    expect(foreign.status).toBe(404);
    expect(await foreign.json()).toEqual(await missing.json());
    expect(readFacebookShareState).not.toHaveBeenCalled();
  });

  it("returns the share state of the creative's own project, uncached", async () => {
    const response = await GET(request(), params);

    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(await response.json()).toEqual({
      kind: "ready",
      pageName: "Web Health",
    });
    expect(requireProjectAccess).toHaveBeenCalledWith("user-1", "proj-1");
    expect(readFacebookShareState).toHaveBeenCalledWith("proj-1", "cr-1");
  });
});
