export function isPublicPath(pathname: string): boolean {
  return (
    pathname === "/login" ||
    pathname === "/register" ||
    pathname === "/api/auth" ||
    pathname.startsWith("/api/auth/") ||
    // Kendi imzalı-token doğrulamasına sahip (bkz.
    // asset-public-link.ts/verifyAssetPublicToken) — Meta gibi dış
    // sağlayıcıların oturum çerezi olmadan bir asset'i indirebilmesi için
    // BİLEREK oturum korumasının dışında. Token olmadan/geçersizse route
    // kendi 401'ini döner, burada hariç tutulması güvenliği gevşetmiyor.
    pathname.startsWith("/api/public/assets/") ||
    pathname === "/api/debug/headers" ||
    pathname === "/icon" ||
    pathname === "/apple-icon"
  );
}
