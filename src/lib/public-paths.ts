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
    // How to delete Instagram data, and the status page Meta links a person to
    // after a deletion request (its confirmation code is signed). Meta's
    // reviewers and users open it without an account.
    pathname === "/data-deletion" ||
    // Meta's own server-to-server calls (someone removed the app / asked for
    // their data to be deleted). No session; each verifies Meta's signed_request
    // itself (see meta-data-requests.ts) and answers 400 without a valid one.
    pathname === "/api/integrations/meta/deauthorize" ||
    pathname === "/api/integrations/meta/data-deletion" ||
    // Meta Ads webhook'u (docs/meta-ads-plan.md F7): oturum yok; GET doğrulama
    // jetonunu, POST X-Hub-Signature-256 imzasını kendisi doğrular, aksi hâlde
    // 403 / 401 döner.
    pathname === "/api/webhooks/meta-ads" ||
    // Google RISC (Cross-Account Protection) push'u: oturum yok; route Google'ın
    // RS256 imzalı jetonunu kendisi doğrular, GOOGLE_RISC kapalıyken 404,
    // geçersiz jetonda 400 döner.
    pathname === "/api/webhooks/google-risc" ||
    // Stripe ödeme webhook'u (docs/billing-payments.md): oturum yok; route
    // Stripe-Signature başlığını webhook sırrıyla kendisi doğrular, geçersizse 401,
    // ödeme kapalıyken 503 döner.
    pathname === "/api/webhooks/billing" ||
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
    // Canlılık ve işçi nabzı ucu: Railway healthcheck'i ve harici monitör
    // oturumsuz çağırır; yanıt yalnız durum taşır (api/health/route.ts).
    pathname === "/api/health" ||
    // SC-F9 / GA-F8: salt-okunur rapor paylaşım sayfası ve logosu; oturum yok,
    // her biri kendi imzalı jetonunu doğrular (src/server/report-share),
    // geçersizse aynı 404. Yalnız "/r/" öneki: "/r" ve "/reports" korunur.
    pathname.startsWith("/r/") ||
    pathname === "/icon" ||
    pathname === "/apple-icon"
  );
}
