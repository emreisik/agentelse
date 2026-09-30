export function isPublicPath(pathname: string): boolean {
  return (
    // Public marketing homepage — required by Google OAuth brand
    // verification (the consent screen's homepage URL must be reachable
    // and explain the app's purpose without signing in). page.tsx redirects
    // signed-in visitors to /dashboard itself.
    pathname === "/" ||
    pathname === "/login" ||
    pathname === "/register" ||
    pathname === "/privacy" ||
    pathname === "/terms" ||
    pathname === "/api/auth" ||
    pathname.startsWith("/api/auth/") ||
    // Has its own signed-token verification (see
    // asset-public-link.ts/verifyAssetPublicToken) — DELIBERATELY excluded
    // from session protection so external providers like Meta can download
    // an asset without a session cookie. Without a token, or with an
    // invalid one, the route returns its own 401; excluding it here does
    // not weaken security.
    pathname.startsWith("/api/public/assets/") ||
    // Has its own signed-secret verification (see cron/worker/route.ts's
    // isValidCronSecret) — DELIBERATELY excluded from session protection so
    // an external scheduler (no session cookie) can call it. Without a
    // valid CRON_SECRET bearer token the route returns its own 401.
    pathname.startsWith("/api/cron/") ||
    pathname === "/icon" ||
    pathname === "/apple-icon"
  );
}
