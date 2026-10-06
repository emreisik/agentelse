import { beforeEach, describe, expect, it, vi } from "vitest";

// Bu dosyanın kanıtladığı: Google onay ekranında veri izni kaldırılırsa
// bağlantı kurulmaz (eskiden "Connected" görünüp her çağrı 403 alıyordu);
// PKCE doğrulayıcısı kod değişimine gider; bağlanan Google hesabının kimliği
// saklanır ve yeniden bağlanınca kopma işareti düşer.

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
}));
vi.mock("@/lib/prisma", () => ({
  prisma: {
    integrationCredential: {
      findUnique: mocks.findUnique,
      upsert: mocks.upsert,
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
      metadata: { disconnectedAt: "2026-10-01T00:00:00.000Z" },
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
