import "server-only";

import { getEnv } from "@/lib/env";
import { gaFixesEnabled } from "@/lib/website-analytics/fixes/flags";

import { googleFetchJson } from "./http";
import {
  googleScopesFor,
  parseGrantedScopes,
  type GoogleService,
} from "./services";

// Google OAuth yetkilendirme kodu akışı (GA ve Search Console ortak). Ayrı
// GOOGLE_OAUTH_REDIRECT_URI yok: adres NEXT_PUBLIC_APP_URL'den türetilir ve
// Google Cloud Console'da yetkili yönlendirme adresi olarak kayıtlıdır.

const AUTHORIZE_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const REVOKE_URL = "https://oauth2.googleapis.com/revoke";
const USERINFO_URL = "https://www.googleapis.com/oauth2/v2/userinfo";

const FORM_HEADERS = { "Content-Type": "application/x-www-form-urlencoded" };

function redirectUri(): string {
  return `${getEnv().NEXT_PUBLIC_APP_URL}/api/integrations/google/callback`;
}

export function buildGoogleAuthorizeUrl(
  state: string,
  service: GoogleService,
  codeChallenge?: string,
  options?: { upgrade?: "edit"; loginHint?: string },
): string {
  const upgrade = options?.upgrade === "edit";
  // Sert koruma: GA_FIXES kapalıyken analytics.edit asla istenmez.
  if (upgrade && (service !== "analytics" || !gaFixesEnabled())) {
    throw new Error("The edit upgrade is not available");
  }
  const env = getEnv();
  const params = new URLSearchParams({
    client_id: env.GOOGLE_OAUTH_CLIENT_ID,
    redirect_uri: redirectUri(),
    response_type: "code",
    access_type: "offline",
    // consent: her bağlanışta refresh token gelsin. select_account: tarayıcıda
    // birden çok Google hesabı varsa doğru hesap seçilsin. Yükseltmede hesap
    // zaten bellidir (login_hint), seçici gösterilmez.
    prompt: upgrade ? "consent" : "consent select_account",
    // include_granted_scopes yok: her servisin token'ı yalnız kendi iznini
    // taşır, iki entegrasyon sessizce birleşmez. Yükseltme izinlerini açıkça
    // listeler, onun da buna ihtiyacı yok (eklenirse yeni GA token'ı Search
    // Console iznini de taşırdı).
    scope: googleScopesFor(service, { edit: upgrade }).join(" "),
    state,
  });
  if (upgrade && options?.loginHint) {
    params.set("login_hint", options.loginHint);
  }
  // PKCE (S256): doğrulayıcı imzalı state'te taşınır (pkce.ts deseni). State
  // oturum kullanıcısına bağlı olduğu için çalınan bir kod başka oturumda
  // kullanılamaz.
  if (codeChallenge) {
    params.set("code_challenge", codeChallenge);
    params.set("code_challenge_method", "S256");
  }
  return `${AUTHORIZE_URL}?${params.toString()}`;
}

export type GoogleTokenExchange = {
  accessToken: string;
  refreshToken: string | null;
  expiresIn: number;
  // Kullanıcının onay ekranında gerçekten verdiği izinler.
  grantedScopes: string[];
};

export async function exchangeGoogleAuthCode(
  code: string,
  codeVerifier?: string,
): Promise<GoogleTokenExchange> {
  const env = getEnv();
  const body = new URLSearchParams({
    code,
    client_id: env.GOOGLE_OAUTH_CLIENT_ID,
    client_secret: env.GOOGLE_OAUTH_CLIENT_SECRET,
    redirect_uri: redirectUri(),
    grant_type: "authorization_code",
  });
  if (codeVerifier) body.set("code_verifier", codeVerifier);

  // Yetkilendirme kodu tek kullanımlıktır: tekrar denenmez.
  const result = await googleFetchJson<{
    access_token: string;
    refresh_token?: string;
    expires_in?: number;
    scope?: string;
  }>(
    TOKEN_URL,
    { method: "POST", headers: FORM_HEADERS, body: body.toString() },
    { kind: "token", retry: false },
  );
  return {
    accessToken: result.access_token,
    refreshToken: result.refresh_token ?? null,
    // expires_in eksik gelirse NaN tarih -> RangeError zinciri oluşmasın
    // (meta-client'ta yaşandı); Google'ın standart 1 saatini varsay.
    expiresIn: result.expires_in ?? 3600,
    grantedScopes: parseGrantedScopes(result.scope),
  };
}

// invalid_grant -> refresh token iptal edilmiş ya da geçersiz; çağıran
// bağlantıyı EXPIRED yapar ve yeniden bağlanma ister (google-token.ts).
export async function refreshGoogleAccessToken(
  refreshToken: string,
): Promise<{ accessToken: string; expiresIn: number }> {
  const env = getEnv();
  const body = new URLSearchParams({
    refresh_token: refreshToken,
    client_id: env.GOOGLE_OAUTH_CLIENT_ID,
    client_secret: env.GOOGLE_OAUTH_CLIENT_SECRET,
    grant_type: "refresh_token",
  });
  const result = await googleFetchJson<{
    access_token: string;
    expires_in?: number;
  }>(
    TOKEN_URL,
    { method: "POST", headers: FORM_HEADERS, body: body.toString() },
    { kind: "token" },
  );
  return {
    accessToken: result.access_token,
    expiresIn: result.expires_in ?? 3600,
  };
}

// Google'da iptal Cloud projesi düzeyindedir: aynı Google hesabının bu
// projeye verdiği bütün izinler ve token'lar gider (GA ve Search Console
// birlikte). Yalnız google-disconnect.ts'teki kuralı geçince çağrılır.
export async function revokeGoogleToken(token: string): Promise<void> {
  await googleFetchJson<unknown>(
    REVOKE_URL,
    {
      method: "POST",
      headers: FORM_HEADERS,
      body: new URLSearchParams({ token }).toString(),
    },
    { kind: "token" },
  );
}

export type GoogleIdentity = {
  // Google hesap kimliği (userinfo `id`); e-posta değişse de aynı kalır.
  googleSub: string | null;
  email: string | null;
};

// Hiç atmaz: kimlik okunamazsa bağlantı yine kurulur, alanlar boş kalır.
export async function fetchGoogleIdentity(
  accessToken: string,
): Promise<GoogleIdentity> {
  try {
    const result = await googleFetchJson<{ id?: string; email?: string }>(
      USERINFO_URL,
      { headers: { Authorization: `Bearer ${accessToken}` } },
      { kind: "read" },
    );
    return { googleSub: result.id ?? null, email: result.email ?? null };
  } catch {
    return { googleSub: null, email: null };
  }
}
