import { describe, expect, it } from "vitest";

import {
  GA_EDIT_SCOPE,
  GOOGLE_SERVICE_SCOPE,
  googleScopesFor,
  googleServiceForProvider,
  hasGaEditScope,
  hasServiceScope,
  parseGrantedScopes,
} from "./services";

// Bu dosyanın kanıtladığı: her servis yalnız kendi veri iznini ister ve
// bağlantı yalnız o izin gerçekten verildiyse kurulur.

describe("Google service scopes", () => {
  it("asks each service only for its own read scope plus the account email", () => {
    expect(googleScopesFor("analytics")).toEqual([
      "https://www.googleapis.com/auth/analytics.readonly",
      "https://www.googleapis.com/auth/userinfo.email",
    ]);
    expect(googleScopesFor("search_console")).not.toContain(
      GOOGLE_SERVICE_SCOPE.analytics,
    );
  });

  it("reads the space-separated scope field of a token response", () => {
    expect(
      parseGrantedScopes(
        " https://www.googleapis.com/auth/userinfo.email  openid ",
      ),
    ).toEqual(["https://www.googleapis.com/auth/userinfo.email", "openid"]);
    expect(parseGrantedScopes(undefined)).toEqual([]);
  });

  it("detects an unticked data permission on the consent screen", () => {
    const emailOnly = ["https://www.googleapis.com/auth/userinfo.email"];
    expect(hasServiceScope("analytics", emailOnly)).toBe(false);
    expect(
      hasServiceScope("analytics", [
        ...emailOnly,
        GOOGLE_SERVICE_SCOPE.analytics,
      ]),
    ).toBe(true);
    // Başka servisin izni yerine geçmez.
    expect(
      hasServiceScope("search_console", [GOOGLE_SERVICE_SCOPE.analytics]),
    ).toBe(false);
  });

  it("maps a provider string back to its service", () => {
    expect(googleServiceForProvider("google_analytics")).toBe("analytics");
    expect(googleServiceForProvider("google_search_console")).toBe(
      "search_console",
    );
    expect(googleServiceForProvider("meta_ads")).toBeNull();
  });
});

describe("GA edit scope (GA-F7)", () => {
  it("adds analytics.edit only when the upgrade asks for it", () => {
    expect(GA_EDIT_SCOPE).toBe(
      "https://www.googleapis.com/auth/analytics.edit",
    );
    expect(googleScopesFor("analytics", { edit: false })).toEqual(
      googleScopesFor("analytics"),
    );
    expect(googleScopesFor("analytics", { edit: true })).toEqual([
      "https://www.googleapis.com/auth/analytics.readonly",
      "https://www.googleapis.com/auth/analytics.edit",
      "https://www.googleapis.com/auth/userinfo.email",
    ]);
  });

  it("never hands Search Console a write scope", () => {
    expect(googleScopesFor("search_console", { edit: true })).toEqual(
      googleScopesFor("search_console"),
    );
    expect(googleScopesFor("search_console", { edit: true })).not.toContain(
      GA_EDIT_SCOPE,
    );
  });

  it("detects the edit scope in a token's granted scopes", () => {
    expect(hasGaEditScope([GOOGLE_SERVICE_SCOPE.analytics])).toBe(false);
    expect(hasGaEditScope([GOOGLE_SERVICE_SCOPE.analytics, GA_EDIT_SCOPE])).toBe(
      true,
    );
    expect(hasGaEditScope([])).toBe(false);
  });

  it("keeps both first-connect scopes read-only", () => {
    expect(GOOGLE_SERVICE_SCOPE.analytics).toMatch(/readonly$/);
    expect(GOOGLE_SERVICE_SCOPE.search_console).toMatch(/readonly$/);
  });
});
