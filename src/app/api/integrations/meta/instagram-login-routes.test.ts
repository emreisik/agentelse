import { beforeEach, describe, expect, it, vi } from "vitest";

// What this suite proves: the Instagram connection can be started and finished
// through Instagram Login (no Facebook account, no Page) and still behaves
// like the Facebook route everywhere else. Start picks the route from `login`
// and refuses it when its app credentials are missing; callback stores the
// account itself (no Page list), turns a personal account away before saving
// anything, and leaves the Facebook route's exchange untouched.

const mocks = vi.hoisted(() => ({
  configured: new Set<string>(["META", "INSTAGRAM_LOGIN"]),
  signOAuthState: vi.fn(() => "signed-state"),
  verifyOAuthState: vi.fn(),
  requireUser: vi.fn(),
  requireProjectAccess: vi.fn(),
  findUnique: vi.fn(),
  upsert: vi.fn(),
  record: vi.fn(),
  encryptSecret: vi.fn((value: string) => `enc(${value})`),
  exchangeInstagramAuthCode: vi.fn(),
  exchangeInstagramLongLivedToken: vi.fn(),
  fetchInstagramLoginProfile: vi.fn(),
  exchangeMetaAuthCode: vi.fn(),
  exchangeForLongLivedToken: vi.fn(),
  fetchMetaAccountName: vi.fn(),
  fetchMetaPageList: vi.fn(),
  fetchMetaAdAccountList: vi.fn(),
}));

vi.mock("@/lib/env", () => ({
  getEnv: () => ({
    NEXT_PUBLIC_APP_URL: "https://app.example.com",
    INSTAGRAM_APP_ID: "ig-app",
    META_APP_ID: "meta-app",
  }),
  isIntegrationConfigured: (key: string) => mocks.configured.has(key),
}));
vi.mock("@/server/security/oauth-state", () => ({
  signOAuthState: mocks.signOAuthState,
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
  encryptSecret: mocks.encryptSecret,
}));
vi.mock("@/server/integrations/meta-client", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/server/integrations/meta-client")>();
  return {
    ...actual,
    exchangeInstagramAuthCode: mocks.exchangeInstagramAuthCode,
    exchangeInstagramLongLivedToken: mocks.exchangeInstagramLongLivedToken,
    fetchInstagramLoginProfile: mocks.fetchInstagramLoginProfile,
    exchangeMetaAuthCode: mocks.exchangeMetaAuthCode,
    exchangeForLongLivedToken: mocks.exchangeForLongLivedToken,
    fetchMetaAccountName: mocks.fetchMetaAccountName,
    fetchMetaPageList: mocks.fetchMetaPageList,
    fetchMetaAdAccountList: mocks.fetchMetaAdAccountList,
  };
});

const { GET: start } = await import("./start/route");
const { GET: callback } = await import("./callback/route");

const startUrl = (query: string) =>
  new Request(`https://app.example.com/api/integrations/meta/start?${query}`);
const callbackUrl = (query = "code=the-code&state=signed-state") =>
  new Request(`https://app.example.com/api/integrations/meta/callback?${query}`);

const location = (response: Response) => new URL(response.headers.get("location")!);

beforeEach(() => {
  vi.clearAllMocks();
  mocks.configured = new Set(["META", "INSTAGRAM_LOGIN"]);
  mocks.requireUser.mockResolvedValue({ userId: "user-1" });
  mocks.requireProjectAccess.mockResolvedValue({
    workspaceId: "ws-1",
    projectId: "proj-1",
    defaultBrandId: "brand-1",
  });
});

describe("start", () => {
  it("login=instagram sends the person to Instagram's consent screen, with the route in the signed state", async () => {
    const response = await start(
      startUrl("projectId=proj-1&service=instagram&login=instagram"),
    );
    const url = location(response);
    expect(url.origin + url.pathname).toBe("https://www.instagram.com/oauth/authorize");
    expect(url.searchParams.get("client_id")).toBe("ig-app");
    expect(mocks.signOAuthState).toHaveBeenCalledWith({
      projectId: "proj-1",
      userId: "user-1",
      service: "instagram",
      login: "instagram",
    });
  });

  it("without login it is the Facebook route, as before", async () => {
    const response = await start(startUrl("projectId=proj-1&service=instagram"));
    expect(location(response).hostname).toBe("www.facebook.com");
    expect(mocks.signOAuthState).toHaveBeenCalledWith({
      projectId: "proj-1",
      userId: "user-1",
      service: "instagram",
    });
  });

  it("Meta Ads ignores login=instagram: ads only exist on the Facebook route", async () => {
    const response = await start(
      startUrl("projectId=proj-1&service=ads&login=instagram"),
    );
    expect(location(response).hostname).toBe("www.facebook.com");
  });

  it("login=instagram without the Instagram app credentials says 'not configured' instead of leaving", async () => {
    mocks.configured = new Set(["META"]);
    const response = await start(
      startUrl("projectId=proj-1&service=instagram&login=instagram"),
    );
    const url = location(response);
    expect(url.hostname).toBe("app.example.com");
    expect(url.searchParams.get("metaError")).toBe("not_configured");
    expect(url.searchParams.get("integration")).toBe("instagram");
  });
});

describe("callback (Instagram Login)", () => {
  beforeEach(() => {
    mocks.verifyOAuthState.mockReturnValue({
      projectId: "proj-1",
      userId: "user-1",
      service: "instagram",
      login: "instagram",
    });
    mocks.exchangeInstagramAuthCode.mockResolvedValue({ accessToken: "short", userId: "scoped-99" });
    mocks.exchangeInstagramLongLivedToken.mockResolvedValue({
      accessToken: "long",
      expiresIn: 5184000,
    });
    mocks.fetchInstagramLoginProfile.mockResolvedValue({
      id: "17841400",
      username: "webhealth",
      accountType: "BUSINESS",
    });
    mocks.findUnique.mockResolvedValue(null);
    mocks.upsert.mockResolvedValue({ id: "cred-1" });
  });

  it("stores the account itself, with no Page list, and encrypts the long-lived token", async () => {
    const response = await callback(callbackUrl());

    expect(mocks.exchangeMetaAuthCode).not.toHaveBeenCalled();
    expect(mocks.fetchMetaPageList).not.toHaveBeenCalled();
    expect(mocks.encryptSecret).toHaveBeenCalledWith("long");

    const saved = mocks.upsert.mock.calls[0]![0].create;
    expect(saved).toMatchObject({
      provider: "instagram",
      accountLabel: "@webhealth",
      encryptedSecret: "enc(long)",
      status: "ACTIVE",
    });
    expect(saved.metadata).toMatchObject({
      login: "instagram",
      // Both ids are kept: Meta's deauthorize / deletion requests name the person by the app-scoped one.
      instagramAccount: { id: "17841400", appScopedId: "scoped-99", username: "webhealth", accountType: "BUSINESS" },
      pages: [],
      connectedName: "@webhealth",
    });
    expect(typeof saved.metadata.longLivedTokenExpiresAt).toBe("string");

    const url = location(response);
    expect(url.pathname).toBe("/projects/proj-1/integrations");
    expect(url.searchParams.get("integration")).toBe("instagram");
    expect(url.searchParams.has("metaError")).toBe(false);
    expect(mocks.record).toHaveBeenCalledOnce();
  });

  it("a Creator account is accepted too", async () => {
    mocks.fetchInstagramLoginProfile.mockResolvedValue({
      id: "1",
      username: "maker",
      accountType: "MEDIA_CREATOR",
    });
    const response = await callback(callbackUrl());
    expect(location(response).searchParams.has("metaError")).toBe(false);
    expect(mocks.upsert).toHaveBeenCalledOnce();
  });

  it("a personal account is turned away before anything is saved", async () => {
    mocks.fetchInstagramLoginProfile.mockResolvedValue({
      id: "2",
      username: "someone",
      accountType: "PERSONAL",
    });
    const response = await callback(callbackUrl());
    expect(location(response).searchParams.get("metaError")).toBe("not_professional");
    expect(mocks.upsert).not.toHaveBeenCalled();
  });

  it("a failed exchange is 'exchange_failed', saves nothing, and says which step failed and what Meta said", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    mocks.exchangeInstagramAuthCode.mockRejectedValue(new Error("Invalid client secret"));
    const response = await callback(callbackUrl());
    const url = location(response);
    expect(url.searchParams.get("metaError")).toBe("exchange_failed");
    expect(url.searchParams.get("metaDetail")).toBe("code exchange: Invalid client secret");
    expect(mocks.upsert).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledOnce();
    log.mockRestore();
  });

  it("names the later steps too, so a bad profile call is not mistaken for a bad code", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    mocks.fetchInstagramLoginProfile.mockRejectedValue(new Error("Unsupported get request"));
    const response = await callback(callbackUrl());
    expect(location(response).searchParams.get("metaDetail")).toBe(
      "account profile: Unsupported get request",
    );
    log.mockRestore();
  });

  it("replaces a previous Facebook-route connection instead of keeping its Page selection", async () => {
    mocks.findUnique.mockResolvedValue({
      metadata: {
        selectedPageId: "p1",
        selectedPageName: "Old Page",
        pages: [{ pageId: "p1", pageName: "Old Page" }],
      },
    });
    await callback(callbackUrl());
    const saved = mocks.upsert.mock.calls[0]![0].update;
    expect(saved.metadata.selectedPageId).toBeUndefined();
    expect(saved.metadata.pages).toEqual([]);
    expect(saved.metadata.login).toBe("instagram");
  });
});

describe("callback (Facebook route)", () => {
  it("without login in the state still exchanges through Facebook and lists Pages", async () => {
    mocks.verifyOAuthState.mockReturnValue({
      projectId: "proj-1",
      userId: "user-1",
      service: "instagram",
    });
    mocks.exchangeMetaAuthCode.mockResolvedValue({ accessToken: "short", expiresIn: 3600 });
    mocks.exchangeForLongLivedToken.mockResolvedValue({ accessToken: "long", expiresIn: 5184000 });
    mocks.fetchMetaAccountName.mockResolvedValue("Emre");
    mocks.fetchMetaPageList.mockResolvedValue({
      pages: [{ pageId: "p1", pageName: "Web Health", instagramBusinessAccountId: "ig-1" }],
    });
    mocks.findUnique.mockResolvedValue(null);
    mocks.upsert.mockResolvedValue({ id: "cred-1" });

    await callback(callbackUrl());

    expect(mocks.exchangeInstagramAuthCode).not.toHaveBeenCalled();
    expect(mocks.exchangeMetaAuthCode).toHaveBeenCalledWith("the-code");
    const saved = mocks.upsert.mock.calls[0]![0].create;
    expect(saved.metadata.login).toBeUndefined();
    expect(saved.metadata.pages).toHaveLength(1);
    expect(saved.accountLabel).toBe("Emre");
  });
});
