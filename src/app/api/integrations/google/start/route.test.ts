import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";

// Bu dosyanın kanıtladığı: normal bağlanış değişmez; upgrade=edit her ret
// durumunda (bayrak kapalı, üye rolü, bağlantı yok, mülk yok, yanlış servis)
// tam hata koduyla geri döner ve Google'a yönlendirmez; başarıda analytics.edit
// ister, include_granted_scopes göndermez ve state'e upgrade yazar.

const mocks = vi.hoisted(() => ({
  requireUser: vi.fn(),
  requireProjectAccess: vi.fn(),
  isWorkspaceManager: vi.fn(),
  findUnique: vi.fn(),
  isIntegrationConfigured: vi.fn(),
}));

vi.mock("@/lib/env", () => ({
  getEnv: () => ({
    NEXT_PUBLIC_APP_URL: "https://app.example.com",
    GOOGLE_OAUTH_CLIENT_ID: "google-client",
    GOOGLE_OAUTH_CLIENT_SECRET: "google-secret",
    AUTH_SECRET: "test-secret",
  }),
  isIntegrationConfigured: mocks.isIntegrationConfigured,
}));
vi.mock("@/server/security/tenant-context", () => ({
  requireUser: mocks.requireUser,
  requireProjectAccess: mocks.requireProjectAccess,
  isWorkspaceManager: mocks.isWorkspaceManager,
}));
vi.mock("@/lib/prisma", () => ({
  prisma: { integrationCredential: { findUnique: mocks.findUnique } },
}));

const { GET } = await import("./route");
const { verifyOAuthState } = await import("@/server/security/oauth-state");

function start(query: string) {
  return GET(
    new Request(`https://app.example.com/api/integrations/google/start?${query}`),
  );
}

const READY_CREDENTIAL = {
  status: "ACTIVE",
  encryptedSecret: "enc",
  metadata: {
    selectedGa4PropertyId: "123",
    connectedEmail: "owner@example.com",
  },
};

function expectRefusal(response: Response, code: string) {
  const location = new URL(response.headers.get("location") ?? "");
  expect(location.origin).toBe("https://app.example.com");
  expect(location.pathname).toBe("/projects/proj-1/integrations");
  expect(location.searchParams.get("integration")).toBe("google_analytics");
  expect(location.searchParams.get("googleError")).toBe(code);
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("GA_SYNC", "true");
  vi.stubEnv("GA_FIXES", "true");
  mocks.isIntegrationConfigured.mockReturnValue(true);
  mocks.requireUser.mockResolvedValue({ userId: "user-1" });
  mocks.requireProjectAccess.mockResolvedValue({
    workspaceId: "ws-1",
    projectId: "proj-1",
    defaultBrandId: "brand-1",
  });
  mocks.isWorkspaceManager.mockResolvedValue(true);
  mocks.findUnique.mockResolvedValue(READY_CREDENTIAL);
});
afterEach(() => {
  vi.unstubAllEnvs();
});

describe("Google OAuth start", () => {
  it("keeps the normal flow unchanged", async () => {
    const response = await start("projectId=proj-1&service=analytics");
    const location = new URL(response.headers.get("location") ?? "");
    expect(location.origin).toBe("https://accounts.google.com");
    expect(location.searchParams.get("scope")).not.toContain("analytics.edit");
    expect(location.searchParams.get("prompt")).toBe("consent select_account");
    expect(location.searchParams.get("login_hint")).toBeNull();
    const state = verifyOAuthState(location.searchParams.get("state") ?? "");
    expect(state?.upgrade).toBeUndefined();
    expect(mocks.findUnique).not.toHaveBeenCalled();
    expect(mocks.isWorkspaceManager).not.toHaveBeenCalled();
  });

  it("ignores an unknown upgrade value", async () => {
    const response = await start(
      "projectId=proj-1&service=analytics&upgrade=admin",
    );
    const location = new URL(response.headers.get("location") ?? "");
    expect(location.origin).toBe("https://accounts.google.com");
    expect(location.searchParams.get("scope")).not.toContain("analytics.edit");
    expect(mocks.findUnique).not.toHaveBeenCalled();
  });

  it("refuses upgrade=edit for Search Console with a 400", async () => {
    const response = await start(
      "projectId=proj-1&service=search_console&upgrade=edit",
    );
    expect(response.status).toBe(400);
    expect(response.headers.get("location")).toBeNull();
  });

  it("refuses while GA_FIXES is off", async () => {
    vi.stubEnv("GA_FIXES", "");
    const response = await start(
      "projectId=proj-1&service=analytics&upgrade=edit",
    );
    expectRefusal(response, "edit_not_available");
    expect(mocks.findUnique).not.toHaveBeenCalled();
  });

  it("refuses a workspace member who is not an owner or admin", async () => {
    mocks.isWorkspaceManager.mockResolvedValue(false);
    const response = await start(
      "projectId=proj-1&service=analytics&upgrade=edit",
    );
    expectRefusal(response, "edit_manager_only");
    expect(mocks.isWorkspaceManager).toHaveBeenCalledWith("user-1", "ws-1");
  });

  it.each([
    ["no credential", null],
    ["revoked credential", { ...READY_CREDENTIAL, status: "REVOKED" }],
    ["empty token", { ...READY_CREDENTIAL, encryptedSecret: "" }],
    [
      "no selected property",
      { ...READY_CREDENTIAL, metadata: { connectedEmail: "owner@example.com" } },
    ],
  ])("asks to connect first with %s", async (_name, credential) => {
    mocks.findUnique.mockResolvedValue(credential);
    const response = await start(
      "projectId=proj-1&service=analytics&upgrade=edit",
    );
    expectRefusal(response, "edit_connect_first");
  });

  it("sends the edit consent without include_granted_scopes", async () => {
    const response = await start(
      "projectId=proj-1&service=analytics&upgrade=edit",
    );
    const location = new URL(response.headers.get("location") ?? "");
    expect(location.origin).toBe("https://accounts.google.com");
    const params = location.searchParams;
    expect(params.get("scope")?.split(" ")).toContain(
      "https://www.googleapis.com/auth/analytics.edit",
    );
    expect(params.get("include_granted_scopes")).toBeNull();
    expect(params.get("prompt")).toBe("consent");
    expect(params.get("login_hint")).toBe("owner@example.com");
    expect(params.get("code_challenge_method")).toBe("S256");
    const state = verifyOAuthState(params.get("state") ?? "");
    expect(state).toMatchObject({
      projectId: "proj-1",
      userId: "user-1",
      service: "analytics",
      upgrade: "edit",
    });
    expect(state?.codeVerifier).toBeTruthy();
  });
});
