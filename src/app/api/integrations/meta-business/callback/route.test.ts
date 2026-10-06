import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  requireUser: vi.fn(),
  requireWorkspaceMembership: vi.fn(),
  memberFindUnique: vi.fn(),
  connectFromCode: vi.fn(),
  verifyOAuthState: vi.fn(),
}));
vi.mock("@/server/security/tenant-context", () => ({
  requireUser: mocks.requireUser,
  requireWorkspaceMembership: mocks.requireWorkspaceMembership,
}));
vi.mock("@/lib/prisma", () => ({
  prisma: { workspaceMember: { findUnique: mocks.memberFindUnique } },
}));
vi.mock("@/server/ads/connections", () => ({
  AdsConnections: { connectFromCode: mocks.connectFromCode },
}));
vi.mock("@/server/security/oauth-state", () => ({
  verifyOAuthState: mocks.verifyOAuthState,
}));
vi.mock("@/lib/app-url", () => ({
  appUrl: (path: string) => new URL(path, "https://agentelse.test"),
}));

import { GET } from "./route";

const URL_BASE = "https://agentelse.test/api/integrations/meta-business/callback";

function call(query: string) {
  return GET(new Request(`${URL_BASE}?${query}`));
}

describe("Facebook Login for Business callback (F8)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.META_ADS_AGENCY = "true";
    mocks.requireUser.mockResolvedValue({ userId: "u-1" });
    mocks.requireWorkspaceMembership.mockResolvedValue({ workspaceId: "ws-1" });
    mocks.memberFindUnique.mockResolvedValue({ role: "OWNER" });
    mocks.verifyOAuthState.mockReturnValue({ projectId: "", userId: "u-1", service: "meta_business" });
    mocks.connectFromCode.mockResolvedValue({ id: "conn-1" });
  });
  afterEach(() => {
    delete process.env.META_ADS_AGENCY;
  });

  it("connects the business for an owner and returns to /ads", async () => {
    const response = await call("code=abc&state=signed");
    expect(response.headers.get("location")).toBe(
      "https://agentelse.test/ads?metaBusinessConnected=1",
    );
    expect(mocks.connectFromCode).toHaveBeenCalledWith({
      workspaceId: "ws-1",
      userId: "u-1",
      code: "abc",
    });
  });

  it("refuses a state that is invalid or belongs to someone else", async () => {
    mocks.verifyOAuthState.mockReturnValueOnce(null);
    expect((await call("code=abc&state=bad")).headers.get("location")).toContain(
      "metaBusinessError=invalid_state",
    );
    mocks.verifyOAuthState.mockReturnValueOnce({ projectId: "", userId: "u-2", service: "meta_business" });
    expect((await call("code=abc&state=other")).headers.get("location")).toContain(
      "metaBusinessError=invalid_state",
    );
    mocks.verifyOAuthState.mockReturnValueOnce({ projectId: "p-1", userId: "u-1", service: "ads" });
    expect((await call("code=abc&state=ads")).headers.get("location")).toContain(
      "metaBusinessError=invalid_state",
    );
    expect(mocks.connectFromCode).not.toHaveBeenCalled();
  });

  it("only an owner or admin can connect, and Meta's refusal is shown", async () => {
    mocks.memberFindUnique.mockResolvedValue({ role: "MEMBER" });
    expect((await call("code=abc&state=signed")).headers.get("location")).toContain(
      "metaBusinessError=not_admin",
    );
    expect((await call("error=access_denied")).headers.get("location")).toContain(
      "metaBusinessError=denied",
    );
    expect(mocks.connectFromCode).not.toHaveBeenCalled();
  });

  it("does not exist while the flag is off", async () => {
    delete process.env.META_ADS_AGENCY;
    expect((await call("code=abc&state=signed")).status).toBe(404);
  });
});
