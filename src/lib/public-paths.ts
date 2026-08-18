export function isPublicPath(pathname: string): boolean {
  return (
    pathname === "/login" ||
    pathname === "/register" ||
    pathname === "/api/auth" ||
    pathname.startsWith("/api/auth/") ||
    // Has its own signed-token verification (see
    // asset-public-link.ts/verifyAssetPublicToken) — DELIBERATELY excluded
    // from session protection so external providers like Meta can download
    // an asset without a session cookie. Without a token, or with an
    // invalid one, the route returns its own 401; excluding it here does
    // not weaken security.
    pathname.startsWith("/api/public/assets/") ||
    pathname === "/api/debug/headers" ||
    pathname === "/icon" ||
    pathname === "/apple-icon"
  );
}
