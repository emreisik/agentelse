import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/env", () => ({
  getEnv: () => ({
    NEXT_PUBLIC_APP_URL: "https://app.example.com",
    GOOGLE_OAUTH_CLIENT_ID: "google-client",
    GOOGLE_OAUTH_CLIENT_SECRET: "google-secret",
  }),
}));

const { buildGoogleAuthorizeUrl, exchangeGoogleAuthCode, fetchGoogleIdentity } =
  await import("./oauth");

// Bu dosyanın kanıtladığı: yetkilendirme adresi PKCE taşır ve izinleri
// birleştirmez; düzenleme yükseltmesi izinleri açıkça listeler, GA_FIXES
// kapalıyken hiç kurulmaz; kod değişimi verilen izinleri döndürür ve tekrar denenmez.

const fetchMock = vi.fn();

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("buildGoogleAuthorizeUrl", () => {
  it("sends the PKCE challenge and asks for consent and an account choice", () => {
    const params = new URL(
      buildGoogleAuthorizeUrl("state-1", "analytics", "challenge-1"),
    ).searchParams;
    expect(params.get("code_challenge")).toBe("challenge-1");
    expect(params.get("code_challenge_method")).toBe("S256");
    expect(params.get("prompt")).toBe("consent select_account");
    expect(params.get("access_type")).toBe("offline");
    expect(params.get("include_granted_scopes")).toBeNull();
    expect(params.get("redirect_uri")).toBe(
      "https://app.example.com/api/integrations/google/callback",
    );
  });

  it("leaves PKCE out when no challenge is given", () => {
    const params = new URL(buildGoogleAuthorizeUrl("s", "search_console"))
      .searchParams;
    expect(params.get("code_challenge")).toBeNull();
  });
});

describe("buildGoogleAuthorizeUrl edit upgrade", () => {
  it("lists both scopes, keeps granted scopes apart and skips the account picker", () => {
    vi.stubEnv("GA_SYNC", "true");
    vi.stubEnv("GA_FIXES", "true");
    const params = new URL(
      buildGoogleAuthorizeUrl("state-1", "analytics", "challenge-1", {
        upgrade: "edit",
        loginHint: "owner@example.com",
      }),
    ).searchParams;
    expect(params.get("scope")?.split(" ")).toEqual([
      "https://www.googleapis.com/auth/analytics.readonly",
      "https://www.googleapis.com/auth/analytics.edit",
      "https://www.googleapis.com/auth/userinfo.email",
    ]);
    expect(params.get("include_granted_scopes")).toBeNull();
    expect(params.get("prompt")).toBe("consent");
    expect(params.get("login_hint")).toBe("owner@example.com");
    expect(params.get("code_challenge")).toBe("challenge-1");
    expect(params.get("access_type")).toBe("offline");
  });

  it("leaves login_hint out when none is known", () => {
    vi.stubEnv("GA_SYNC", "true");
    vi.stubEnv("GA_FIXES", "true");
    const params = new URL(
      buildGoogleAuthorizeUrl("s", "analytics", undefined, { upgrade: "edit" }),
    ).searchParams;
    expect(params.get("login_hint")).toBeNull();
  });

  it("throws while GA_FIXES or GA_SYNC is off", () => {
    vi.stubEnv("GA_SYNC", "true");
    vi.stubEnv("GA_FIXES", "");
    expect(() =>
      buildGoogleAuthorizeUrl("s", "analytics", "c", { upgrade: "edit" }),
    ).toThrow();
    vi.stubEnv("GA_SYNC", "");
    vi.stubEnv("GA_FIXES", "true");
    expect(() =>
      buildGoogleAuthorizeUrl("s", "analytics", "c", { upgrade: "edit" }),
    ).toThrow();
  });

  it("throws for Search Console even with the flags on", () => {
    vi.stubEnv("GA_SYNC", "true");
    vi.stubEnv("GA_FIXES", "true");
    expect(() =>
      buildGoogleAuthorizeUrl("s", "search_console", "c", { upgrade: "edit" }),
    ).toThrow();
  });

  it("leaves the normal URL untouched when the flags are on", () => {
    vi.stubEnv("GA_SYNC", "true");
    vi.stubEnv("GA_FIXES", "true");
    const params = new URL(buildGoogleAuthorizeUrl("s", "analytics", "c"))
      .searchParams;
    expect(params.get("scope")).not.toContain("analytics.edit");
    expect(params.get("prompt")).toBe("consent select_account");
    expect(params.get("login_hint")).toBeNull();
  });
});

describe("exchangeGoogleAuthCode", () => {
  it("passes the verifier and returns the granted scopes", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          access_token: "at",
          refresh_token: "rt",
          expires_in: 3599,
          scope:
            "https://www.googleapis.com/auth/userinfo.email https://www.googleapis.com/auth/analytics.readonly",
        }),
        { status: 200 },
      ),
    );
    const tokens = await exchangeGoogleAuthCode("code-1", "verifier-1");
    expect(tokens.refreshToken).toBe("rt");
    expect(tokens.grantedScopes).toContain(
      "https://www.googleapis.com/auth/analytics.readonly",
    );
    const body = new URLSearchParams(
      String((fetchMock.mock.calls[0]?.[1] as RequestInit).body),
    );
    expect(body.get("code_verifier")).toBe("verifier-1");
    expect(body.get("grant_type")).toBe("authorization_code");
  });

  it("never retries: an authorization code works only once", async () => {
    fetchMock.mockRejectedValue(new TypeError("fetch failed"));
    await expect(exchangeGoogleAuthCode("code-1")).rejects.toThrow();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe("fetchGoogleIdentity", () => {
  it("returns the account id and email, and never throws", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ id: "sub-1", email: "a@b.com" }), {
        status: 200,
      }),
    );
    expect(await fetchGoogleIdentity("at")).toEqual({
      googleSub: "sub-1",
      email: "a@b.com",
    });

    fetchMock.mockResolvedValueOnce(new Response("", { status: 401 }));
    expect(await fetchGoogleIdentity("bad")).toEqual({
      googleSub: null,
      email: null,
    });
  });
});
