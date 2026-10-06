// Google'da iptal kararı (docs/google-analytics-plan.md §3.2 "akıllı iptal").
// Google izin kaydını OAuth istemcisine değil Cloud projesine bağlar: bir
// token'ı iptal etmek, aynı Google hesabının bu projeye verdiği bütün
// izinleri ve token'ları siler. GA ile Search Console aynı projede olduğu için
// birini koparırken Google'a iptal göndermek, aynı hesapla bağlı diğerini de
// koparır. Bu yüzden iptal yalnız aynı hesabı kullanan başka canlı bağlantı
// yoksa yapılır. Şüphede iptal edilmez: bizim token'ımız her durumda silinir.
// Saf modül: sorgu google-disconnect.ts'tedir.

export type GoogleConnectionRef = {
  id: string;
  encryptedSecret: string;
  googleSub: string | null;
  email: string | null;
};

export function shouldRevokeAtGoogle(
  target: GoogleConnectionRef,
  // Hangi workspace ya da servis olursa olsun, koparılmamış diğer Google
  // bağlantıları.
  others: readonly GoogleConnectionRef[],
): boolean {
  // Silinmiş token iptal edilemez.
  if (!target.encryptedSecret) return false;
  // Hesabı tanıyamıyorsak (eski bağlantı, kimlik okunamadı) dokunmayız.
  if (!target.googleSub && !target.email) return false;

  const email = target.email?.toLowerCase() ?? null;
  return !others.some((other) => {
    if (other.id === target.id) return false;
    // 29 Eylül ayrıştırmasından kalan GA/GSC çiftleri aynı şifreli token'ı
    // paylaşır.
    if (
      other.encryptedSecret &&
      other.encryptedSecret === target.encryptedSecret
    ) {
      return true;
    }
    if (target.googleSub && other.googleSub) {
      return other.googleSub === target.googleSub;
    }
    // Kimliği olmayan eski satırlarda e-posta yedektir.
    return Boolean(email && other.email?.toLowerCase() === email);
  });
}
