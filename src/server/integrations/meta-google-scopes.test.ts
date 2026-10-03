import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/env", () => ({
  getEnv: () => ({
    META_APP_ID: "meta-app",
    INSTAGRAM_APP_ID: "ig-app",
    NEXT_PUBLIC_APP_URL: "https://app.example.com",
    GOOGLE_OAUTH_CLIENT_ID: "google-client",
  }),
}));

import { buildGoogleAuthorizeUrl } from "@/server/integrations/google-client";
import {
  META_PROVIDER,
  buildInstagramLoginAuthorizeUrl,
  buildMetaAuthorizeUrl,
  parseMetaService,
} from "@/server/integrations/meta-client";

function scopesOf(url: string, separator: string): string[] {
  return (new URL(url).searchParams.get("scope") ?? "").split(separator);
}

describe("Meta OAuth scopes are isolated per integration", () => {
  it("Instagram asks for publishing scopes, no ads scopes and no Page posting", () => {
    const scopes = scopesOf(buildMetaAuthorizeUrl("s", "instagram"), ",");
    expect(scopes).toContain("instagram_content_publish");
    expect(scopes).toContain("instagram_manage_insights");
    expect(scopes).not.toContain("ads_management");
    expect(scopes).not.toContain("ads_read");
    // Publishing to Instagram through a Page needs the Page's token, not the
    // right to post on the Page: that belongs to the Facebook service alone.
    expect(scopes).not.toContain("pages_manage_posts");
  });

  it("Meta Ads asks for ads scopes and no Instagram scopes or Page posting", () => {
    const scopes = scopesOf(buildMetaAuthorizeUrl("s", "ads"), ",");
    expect(scopes).toContain("ads_management");
    expect(scopes).toContain("ads_read");
    expect(scopes).not.toContain("instagram_basic");
    expect(scopes).not.toContain("instagram_content_publish");
    expect(scopes).not.toContain("pages_manage_posts");
  });

  it("Facebook asks for Page scopes and no ads or Instagram scopes", () => {
    const scopes = scopesOf(buildMetaAuthorizeUrl("s", "facebook"), ",");
    expect(scopes).toEqual(
      expect.arrayContaining([
        "pages_show_list",
        "pages_manage_posts",
        "pages_read_engagement",
      ]),
    );
    expect(scopes).not.toContain("ads_management");
    expect(scopes).not.toContain("ads_read");
    expect(scopes).not.toContain("instagram_basic");
    expect(scopes).not.toContain("instagram_content_publish");
  });

  it("Instagram Login uses Instagram's own consent screen, its own app id and only Instagram scopes", () => {
    const url = new URL(buildInstagramLoginAuthorizeUrl("s"));
    expect(url.origin + url.pathname).toBe(
      "https://www.instagram.com/oauth/authorize",
    );
    expect(url.searchParams.get("client_id")).toBe("ig-app");
    expect(url.searchParams.get("redirect_uri")).toBe(
      "https://app.example.com/api/integrations/meta/callback",
    );
    expect(url.searchParams.get("state")).toBe("s");
    const scopes = scopesOf(url.toString(), ",");
    expect(scopes).toEqual([
      "instagram_business_basic",
      "instagram_business_content_publish",
      "instagram_business_manage_insights",
    ]);
    // No Facebook scopes: that route asks for Page access, this one must not.
    expect(scopes.join(",")).not.toMatch(/pages_|business_management|ads_/);
  });

  it("asks Facebook again for a permission declined last time", () => {
    for (const service of ["instagram", "facebook", "ads"] as const) {
      const url = new URL(buildMetaAuthorizeUrl("s", service));
      expect(url.searchParams.get("auth_type")).toBe("rerequest");
    }
  });

  it("stores each integration under its own provider key", () => {
    expect(META_PROVIDER).toEqual({
      instagram: "instagram",
      facebook: "facebook",
      ads: "meta_ads",
    });
    expect(parseMetaService("ads")).toBe("ads");
    expect(parseMetaService("facebook")).toBe("facebook");
    expect(parseMetaService("meta")).toBeNull();
  });
});

describe("Google OAuth scopes are isolated per integration", () => {
  it("Analytics does not ask for Search Console access", () => {
    const scopes = scopesOf(buildGoogleAuthorizeUrl("s", "analytics"), " ");
    expect(scopes).toContain("https://www.googleapis.com/auth/analytics.readonly");
    expect(scopes).not.toContain(
      "https://www.googleapis.com/auth/webmasters.readonly",
    );
  });

  it("Search Console does not ask for Analytics access", () => {
    const scopes = scopesOf(buildGoogleAuthorizeUrl("s", "search_console"), " ");
    expect(scopes).toContain(
      "https://www.googleapis.com/auth/webmasters.readonly",
    );
    expect(scopes).not.toContain(
      "https://www.googleapis.com/auth/analytics.readonly",
    );
  });

  it("never merges previously granted scopes back in", () => {
    const params = new URL(buildGoogleAuthorizeUrl("s", "analytics"))
      .searchParams;
    expect(params.get("include_granted_scopes")).toBeNull();
  });
});
