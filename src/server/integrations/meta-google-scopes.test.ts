import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/env", () => ({
  getEnv: () => ({
    META_APP_ID: "meta-app",
    NEXT_PUBLIC_APP_URL: "https://app.example.com",
    GOOGLE_OAUTH_CLIENT_ID: "google-client",
  }),
}));

import { buildGoogleAuthorizeUrl } from "@/server/integrations/google-client";
import {
  META_PROVIDER,
  buildMetaAuthorizeUrl,
  parseMetaService,
} from "@/server/integrations/meta-client";

function scopesOf(url: string, separator: string): string[] {
  return (new URL(url).searchParams.get("scope") ?? "").split(separator);
}

describe("Meta OAuth scopes are isolated per integration", () => {
  it("Instagram asks for publishing scopes and no ads scopes", () => {
    const scopes = scopesOf(buildMetaAuthorizeUrl("s", "instagram"), ",");
    expect(scopes).toContain("instagram_content_publish");
    expect(scopes).not.toContain("ads_management");
    expect(scopes).not.toContain("ads_read");
  });

  it("Meta Ads asks for ads scopes and no Instagram scopes", () => {
    const scopes = scopesOf(buildMetaAuthorizeUrl("s", "ads"), ",");
    expect(scopes).toContain("ads_management");
    expect(scopes).toContain("ads_read");
    expect(scopes).not.toContain("instagram_basic");
    expect(scopes).not.toContain("instagram_content_publish");
  });

  it("stores each integration under its own provider key", () => {
    expect(META_PROVIDER).toEqual({ instagram: "instagram", ads: "meta_ads" });
    expect(parseMetaService("ads")).toBe("ads");
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
