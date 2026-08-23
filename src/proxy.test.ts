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
  ])("allows %s", (pathname) => {
    expect(isPublicPath(pathname)).toBe(true);
  });

  it.each(["/dashboard", "/login-help", "/api/authentic", "/api/authz"])(
    "protects %s",
    (pathname) => {
      expect(isPublicPath(pathname)).toBe(false);
    },
  );
});
