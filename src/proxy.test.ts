import { describe, expect, it } from "vitest";

import { isPublicPath } from "@/lib/public-paths";

describe("proxy public path matching", () => {
  it.each([
    "/",
    "/login",
    "/api/auth",
    "/api/auth/session",
    "/api/auth/callback/credentials",
    "/api/cron/worker",
    "/api/health",
    "/data-deletion",
    "/api/integrations/meta/deauthorize",
    "/api/integrations/meta/data-deletion",
    "/api/webhooks/meta-ads",
  ])("allows %s", (pathname) => {
    expect(isPublicPath(pathname)).toBe(true);
  });

  it.each([
    "/dashboard",
    "/login-help",
    "/api/authentic",
    "/api/authz",
    // Only the two Meta callbacks are open: the OAuth start/callback need a session.
    "/api/integrations/meta/start",
    "/api/integrations/meta/callback",
    "/data-deletion/extra",
    "/api/healthz",
    "/api/health/details",
    "/api/webhooks/meta-ads/extra",
    "/api/webhooks/other",
  ])(
    "protects %s",
    (pathname) => {
      expect(isPublicPath(pathname)).toBe(false);
    },
  );
});
