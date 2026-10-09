// Tek seferlik dönüş / bildirim parametreleri: Stripe Checkout dönüşü (checkout, purchase,
// session_id) ve eylem bildirimi (notice). Ekranda gösterildikten sonra adres çubuğundan
// silinir ki yer imi, yeniden yükleme ve paylaşılan bağlantı aynı bildirimi tekrar
// göstermesin ve Checkout dönüşü her yüklemede yeniden işlenmesin.
export const ONE_SHOT_PARAMS = [
  "notice",
  "checkout",
  "purchase",
  "session_id",
] as const;

// Adresten tek seferlik parametreleri çıkarır; değişecek bir şey yoksa null. Yalnız yol,
// sorgu ve parça döner (aynı origin içinde history.replaceState için).
export function withoutOneShotParams(href: string): string | null {
  const url = new URL(href, "http://localhost");
  let changed = false;
  for (const key of ONE_SHOT_PARAMS) {
    if (url.searchParams.has(key)) {
      url.searchParams.delete(key);
      changed = true;
    }
  }
  return changed ? `${url.pathname}${url.search}${url.hash}` : null;
}
