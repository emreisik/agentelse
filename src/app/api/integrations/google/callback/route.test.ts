import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Bu dosyanın kanıtladığı: Google onay ekranında veri izni kaldırılırsa
// bağlantı kurulmaz (eskiden "Connected" görünüp her çağrı 403 alıyordu);
// PKCE doğrulayıcısı kod değişimine gider; bağlanan Google hesabının kimliği
// saklanır ve yeniden bağlanınca kopma işareti düşer. İsteğe bağlı ikinci
// onayda (GA-F7) token yer değiştirir, gaEdit yazılır, mülk seçimi korunur;
// eksik izin, Search Console izni taşıyan geniş token, farklı hesap, üye
// rolü ve kapalı bayrak hiçbir şey yazmaz ve hiçbir token iptal edilmez.

const mocks = vi.hoisted(() => ({
  verifyOAuthState: vi.fn(),
  requireUser: vi.fn(),
  requireProjectAccess: vi.fn(),
  findUnique: vi.fn(),
  upsert: vi.fn(),
  record: vi.fn(),
  exchangeGoogleAuthCode: vi.fn(),
  fetchGa4PropertyList: vi.fn(),
  fetchGoogleIdentity: vi.fn(),
  isWorkspaceManager: vi.fn(),
  update: vi.fn(),
  markGaEditGranted: vi.fn(),
  forgetGoogleAccessTokens: vi.fn(),
  revokeGoogleToken: vi.fn(),
}));

vi.mock("@/lib/env", () => ({
  getEnv: () => ({ NEXT_PUBLIC_APP_URL: "https://app.example.com" }),
}));
vi.mock("@/server/security/oauth-state", () => ({
  verifyOAuthState: mocks.verifyOAuthState,
}));
vi.mock("@/server/security/tenant-context", () => ({
  requireUser: mocks.requireUser,
  requireProjectAccess: mocks.requireProjectAccess,
  isWorkspaceManager: mocks.isWorkspaceManager,
}));
vi.mock("@/server/website-analytics/fixes/edit-grant", () => ({
  markGaEditGranted: mocks.markGaEditGranted,
}));
vi.mock("@/server/integrations/google/access-token", () => ({
  forgetGoogleAccessTokens: mocks.forgetGoogleAccessTokens,
}));
vi.mock("@/lib/prisma", () => ({
  prisma: {
    integrationCredential: {
      findUnique: mocks.findUnique,
      upsert: mocks.upsert,
      update: mocks.update,
    },
  },
}));
vi.mock("@/server/repositories/audit-log.repository", () => ({
  AuditLogRepository: { record: mocks.record },
}));
vi.mock("@/server/security/crypto", () => ({
  encryptSecret: (value: string) => `enc(${value})`,
}));
vi.mock("@/server/integrations/google/oauth", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("@/server/integrations/google/oauth")
  >()),
  fetchGoogleIdentity: mocks.fetchGoogleIdentity,
  revokeGoogleToken: mocks.revokeGoogleToken,
}));
vi.mock("@/server/integrations/google-client", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("@/server/integrations/google-client")
  >()),
  exchangeGoogleAuthCode: mocks.exchangeGoogleAuthCode,
  fetchGa4PropertyList: mocks.fetchGa4PropertyList,
}));

const { GET } = await import("./route");

const EMAIL_SCOPE = "https://www.googleapis.com/auth/userinfo.email";
const GA_SCOPE = "https://www.googleapis.com/auth/analytics.readonly";
const GA_EDIT = "https://www.googleapis.com/auth/analytics.edit";
const SC_SCOPE = "https://www.googleapis.com/auth/webmasters.readonly";

function callback() {
  return GET(
    new Request(
      "https://app.example.com/api/integrations/google/callback?code=code-1&state=signed",
    ),
  );
}

function locationOf(response: Response): URL {
  return new URL(response.headers.get("location") ?? "");
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("GA_SYNC", "true");
  vi.stubEnv("GA_FIXES", "true");
  mocks.isWorkspaceManager.mockResolvedValue(true);
  mocks.update.mockResolvedValue({ id: "cred-ga" });
  mocks.verifyOAuthState.mockReturnValue({
    projectId: "proj-1",
    userId: "user-1",
    service: "analytics",
    codeVerifier: "verifier-1",
  });
  mocks.requireUser.mockResolvedValue({ userId: "user-1", email: null });
  mocks.requireProjectAccess.mockResolvedValue({
    workspaceId: "ws-1",
    projectId: "proj-1",
    defaultBrandId: "brand-1",
  });
  mocks.findUnique.mockResolvedValue(null);
  mocks.upsert.mockResolvedValue({ id: "cred-ga" });
  mocks.fetchGoogleIdentity.mockResolvedValue({
    googleSub: "sub-1",
    email: "owner@example.com",
  });
  mocks.fetchGa4PropertyList.mockResolvedValue({
    ga4Properties: [
      { propertyId: "123", propertyName: "Web", accountName: "Acme" },
    ],
  });
});

describe("Google OAuth callback", () => {
  it("does not connect when the Analytics box was unticked", async () => {
    mocks.exchangeGoogleAuthCode.mockResolvedValue({
      accessToken: "at",
      refreshToken: "rt",
      expiresIn: 3600,
      grantedScopes: [EMAIL_SCOPE],
    });

    const location = locationOf(await callback());
    expect(location.pathname).toBe("/projects/proj-1/integrations");
    expect(location.searchParams.get("googleError")).toBe("scope_missing");
    expect(mocks.upsert).not.toHaveBeenCalled();
  });

  it("sends the PKCE verifier and stores the Google account's id", async () => {
    mocks.exchangeGoogleAuthCode.mockResolvedValue({
      accessToken: "at",
      refreshToken: "rt",
      expiresIn: 3600,
      grantedScopes: [EMAIL_SCOPE, GA_SCOPE],
    });
    // Daha önce koparılmış satıra yeniden bağlanma.
    mocks.findUnique.mockResolvedValue({
      metadata: {
        disconnectedAt: "2026-10-01T00:00:00.000Z",
        googleHealth: { state: "NEEDS_RECONNECT", checkedAt: "2026-10-01" },
      },
    });

    const location = locationOf(await callback());
    expect(location.searchParams.get("googleError")).toBeNull();
    expect(mocks.exchangeGoogleAuthCode).toHaveBeenCalledWith(
      "code-1",
      "verifier-1",
    );

    const write = mocks.upsert.mock.calls[0]?.[0];
    expect(write.create.status).toBe("ACTIVE");
    expect(write.create.encryptedSecret).toBe("enc(rt)");
    expect(write.update.metadata).toMatchObject({
      googleSub: "sub-1",
      connectedEmail: "owner@example.com",
    });
    expect(write.update.metadata).not.toHaveProperty("disconnectedAt");
    expect(write.update.metadata).not.toHaveProperty("googleHealth");
  });

  it("still connects when Google leaves the scope field out", async () => {
    mocks.exchangeGoogleAuthCode.mockResolvedValue({
      accessToken: "at",
      refreshToken: "rt",
      expiresIn: 3600,
      grantedScopes: [],
    });

    await callback();
    expect(mocks.upsert).toHaveBeenCalled();
  });
});

afterEach(() => {
  vi.unstubAllEnvs();
});

const CONNECTED = {
  id: "cred-ga",
  status: "ACTIVE",
  encryptedSecret: "enc(old)",
  metadata: {
    selectedGa4PropertyId: "123",
    selectedGa4PropertyName: "Web",
    googleSub: "sub-1",
    connectedEmail: "owner@example.com",
  },
};

describe("Google OAuth callback edit upgrade", () => {
  beforeEach(() => {
    mocks.verifyOAuthState.mockReturnValue({
      projectId: "proj-1",
      userId: "user-1",
      service: "analytics",
      codeVerifier: "verifier-1",
      upgrade: "edit",
    });
    mocks.findUnique.mockResolvedValue(CONNECTED);
    mocks.exchangeGoogleAuthCode.mockResolvedValue({
      accessToken: "at",
      refreshToken: "rt-new",
      expiresIn: 3600,
      grantedScopes: [EMAIL_SCOPE, GA_SCOPE, GA_EDIT],
    });
  });

  function expectNothingWritten() {
    expect(mocks.update).not.toHaveBeenCalled();
    expect(mocks.upsert).not.toHaveBeenCalled();
    expect(mocks.markGaEditGranted).not.toHaveBeenCalled();
    expect(mocks.forgetGoogleAccessTokens).not.toHaveBeenCalled();
    expect(mocks.revokeGoogleToken).not.toHaveBeenCalled();
  }

  it("replaces the token, records the grant and keeps the property selection", async () => {
    const location = locationOf(await callback());
    expect(location.pathname).toBe("/projects/proj-1/integrations");
    expect(location.searchParams.get("googleEdit")).toBe("granted");
    expect(location.searchParams.get("googleError")).toBeNull();
    expect(mocks.exchangeGoogleAuthCode).toHaveBeenCalledWith(
      "code-1",
      "verifier-1",
    );

    expect(mocks.update).toHaveBeenCalledTimes(1);
    const write = mocks.update.mock.calls[0]?.[0];
    expect(write.where).toEqual({ id: "cred-ga" });
    expect(write.data).toEqual({
      encryptedSecret: "enc(rt-new)",
      status: "ACTIVE",
    });
    // Seçim ve diğer metadata'ya dokunulmaz; liste yeniden alınmaz.
    expect(write.data).not.toHaveProperty("metadata");
    expect(mocks.fetchGa4PropertyList).not.toHaveBeenCalled();
    expect(mocks.upsert).not.toHaveBeenCalled();

    expect(mocks.markGaEditGranted).toHaveBeenCalledWith(
      "cred-ga",
      expect.objectContaining({ grantedByUserId: "user-1" }),
    );
    expect(mocks.forgetGoogleAccessTokens).toHaveBeenCalledWith("cred-ga");
    expect(mocks.record).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "integration_credential.edit_access_granted",
        metadata: { provider: "google_analytics" },
      }),
    );
    expect(mocks.revokeGoogleToken).not.toHaveBeenCalled();
  });

  it("runs before the generic scope checks: a missing edit scope is edit_scope_missing", async () => {
    mocks.exchangeGoogleAuthCode.mockResolvedValue({
      accessToken: "at",
      refreshToken: "rt-new",
      expiresIn: 3600,
      grantedScopes: [EMAIL_SCOPE, GA_SCOPE],
    });
    const location = locationOf(await callback());
    expect(location.searchParams.get("googleError")).toBe("edit_scope_missing");
    expectNothingWritten();
  });

  it("is edit_scope_missing even when the read scope is also gone", async () => {
    mocks.exchangeGoogleAuthCode.mockResolvedValue({
      accessToken: "at",
      refreshToken: null,
      expiresIn: 3600,
      grantedScopes: [EMAIL_SCOPE],
    });
    const location = locationOf(await callback());
    expect(location.searchParams.get("googleError")).toBe("edit_scope_missing");
    expectNothingWritten();
  });

  it("refuses a token that also carries the Search Console scope", async () => {
    mocks.exchangeGoogleAuthCode.mockResolvedValue({
      accessToken: "at",
      refreshToken: "rt-new",
      expiresIn: 3600,
      grantedScopes: [EMAIL_SCOPE, GA_SCOPE, GA_EDIT, SC_SCOPE],
    });
    const location = locationOf(await callback());
    expect(location.searchParams.get("googleError")).toBe("edit_not_available");
    expectNothingWritten();
  });

  it("needs a refresh token", async () => {
    mocks.exchangeGoogleAuthCode.mockResolvedValue({
      accessToken: "at",
      refreshToken: null,
      expiresIn: 3600,
      grantedScopes: [EMAIL_SCOPE, GA_SCOPE, GA_EDIT],
    });
    const location = locationOf(await callback());
    expect(location.searchParams.get("googleError")).toBe("no_refresh_token");
    expectNothingWritten();
  });

  it("refuses a different Google account", async () => {
    mocks.fetchGoogleIdentity.mockResolvedValue({
      googleSub: "sub-2",
      email: "other@example.com",
    });
    const location = locationOf(await callback());
    expect(location.searchParams.get("googleError")).toBe(
      "edit_account_mismatch",
    );
    expectNothingWritten();
  });

  it("compares the email case-insensitively when no account id is known", async () => {
    mocks.findUnique.mockResolvedValue({
      ...CONNECTED,
      metadata: {
        selectedGa4PropertyId: "123",
        connectedEmail: "Owner@Example.com",
      },
    });
    mocks.fetchGoogleIdentity.mockResolvedValue({
      googleSub: null,
      email: "owner@example.com",
    });
    const location = locationOf(await callback());
    expect(location.searchParams.get("googleEdit")).toBe("granted");
  });

  it("refuses when nobody can be identified", async () => {
    mocks.fetchGoogleIdentity.mockResolvedValue({
      googleSub: null,
      email: null,
    });
    const location = locationOf(await callback());
    expect(location.searchParams.get("googleError")).toBe(
      "edit_account_mismatch",
    );
    expectNothingWritten();
  });

  it.each([
    ["no credential", null],
    ["revoked credential", { ...CONNECTED, status: "REVOKED" }],
    ["no selected property", { ...CONNECTED, metadata: { googleSub: "sub-1" } }],
  ])("asks to connect first with %s", async (_name, credential) => {
    mocks.findUnique.mockResolvedValue(credential);
    const location = locationOf(await callback());
    expect(location.searchParams.get("googleError")).toBe("edit_connect_first");
    expectNothingWritten();
  });

  it("refuses a workspace member who is not an owner or admin before the code is used", async () => {
    mocks.isWorkspaceManager.mockResolvedValue(false);
    const location = locationOf(await callback());
    expect(location.searchParams.get("googleError")).toBe("edit_manager_only");
    expect(mocks.exchangeGoogleAuthCode).not.toHaveBeenCalled();
    expectNothingWritten();
  });

  it("refuses while GA_FIXES is off", async () => {
    vi.stubEnv("GA_FIXES", "");
    const location = locationOf(await callback());
    expect(location.searchParams.get("googleError")).toBe("edit_not_available");
    expect(mocks.exchangeGoogleAuthCode).not.toHaveBeenCalled();
    expectNothingWritten();
  });

  it("never treats a Search Console state as an upgrade", async () => {
    mocks.verifyOAuthState.mockReturnValue({
      projectId: "proj-1",
      userId: "user-1",
      service: "search_console",
      codeVerifier: "verifier-1",
      upgrade: "edit",
    });
    const location = locationOf(await callback());
    expect(location.searchParams.get("googleError")).toBe("edit_not_available");
    expectNothingWritten();
  });
});
