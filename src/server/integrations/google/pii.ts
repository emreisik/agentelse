// Google'dan gelen metinlerde kişisel veri (docs/google-analytics-plan.md
// §3.11 "Veri azaltımı"): sayfa yolu, sayfa başlığı ve arama terimi
// saklanmadan ve AI sağlayıcısına gitmeden önce buradan geçer. GA4
// `pagePath` ve `landingPage`'e sorgu dizesini koymaz; yine de gelirse atılır.
// Saf fonksiyonlar (Search Console da kullanır).

const MAX_LENGTH = 500;

const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
// Uluslararası biçimli telefon (+ ile başlar). Yalnız rakamdan oluşan uzun
// kimlikler (ürün numarası gibi) maskelenmez: sayfaları birbirine katardı.
const PHONE = /\+\d[\d\s().-]{7,}\d/g;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// Küçük harfli, tireli okunur adres parçası ("best-running-shoes-2026").
const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)+$/;

function decode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

// Oturum, sıfırlama ya da davet anahtarına benzeyen yol parçası: UUID ya da
// en az 24 karakterlik, harf ve en az 3 rakam içeren, slug olmayan dizge.
function looksLikeToken(segment: string): boolean {
  if (UUID.test(segment)) return true;
  if (segment.length < 24 || !/^[A-Za-z0-9_-]+$/.test(segment)) return false;
  if (SLUG.test(segment)) return false;
  return segment.replace(/\D/g, "").length >= 3 && /[A-Za-z]/.test(segment);
}

function maskText(value: string): string {
  return value.replace(EMAIL, "[email]").replace(PHONE, "[phone]");
}

// Sayfa yolu: sorgu dizesi ve parça atılır, kodlama çözülür, kişisel veri
// maskelenir.
export function maskGooglePath(value: string): string {
  const path = decode(value.split(/[?#]/)[0] ?? "");
  return maskText(path)
    .split("/")
    .map((segment) => (looksLikeToken(segment) ? "[id]" : segment))
    .join("/")
    .slice(0, MAX_LENGTH);
}

// Serbest metin (sayfa başlığı, arama terimi).
export function maskGoogleText(value: string): string {
  return maskText(value.replace(/\s+/g, " ").trim()).slice(0, MAX_LENGTH);
}

// Adreste (sorgu dizesi dahil) kişisel veri var mı (ölçüm sağlığı kontrolü
// MH12 için).
export function containsGooglePii(value: string): boolean {
  const decoded = decode(value);
  if (new RegExp(EMAIL.source).test(decoded)) return true;
  if (new RegExp(PHONE.source).test(decoded)) return true;
  return (decoded.split(/[?#]/)[0] ?? "").split("/").some(looksLikeToken);
}
