// Abonelik satırı ↔ çalışan Stripe anahtarının modu. Saf ve izomorfik (sunucu ve ekran
// modeli aynı kuralı kullanır).

export type StripeModeName = "test" | "live";

// Satır, ÇALIŞAN anahtarın modundaki bir Stripe aboneliğine mi bağlı? Test ve canlı veri
// aynı veritabanını paylaşabilir: başka moddaki bağ bu modda "abonelik yok" sayılır
// (satın alma, plan değiştirme, iptal ve portal o aboneliği bu anahtarla göremez).
// `stripeLivemode` boşsa (eski satır) mod uyuşuyor kabul edilir.
// Satırdaki bağ/bayrak ÇALIŞAN modun mu? `stripeLivemode` boşsa (eski satır) uyuşuyor kabul.
export function rowInMode(
  row: { stripeLivemode: boolean | null },
  mode: StripeModeName,
): boolean {
  return (
    row.stripeLivemode === null || row.stripeLivemode === (mode === "live")
  );
}

// İlk ay indirimi bu modda kullanıldı / kullanılamaz mı? Yalnız ÇALIŞAN modun geçmişi
// sayılır: test anahtarıyla yapılmış bir deneme, canlıdaki ilk ay indirimini AÇMAMIŞ olmaz.
// Sunucu (satın alma) ve ekran (plan seçici) AYNI kuralı kullanır.
export function firstMonthUsed(
  row: {
    stripeSubscriptionId: string | null;
    stripeLivemode: boolean | null;
    introOffer: boolean;
  } | null,
  mode: StripeModeName,
): boolean {
  if (!row || !rowInMode(row, mode)) return false;
  return row.stripeSubscriptionId !== null || row.introOffer;
}

export function linkedForMode(
  row: {
    stripeSubscriptionId: string | null;
    stripeLivemode: boolean | null;
  } | null,
  mode: StripeModeName,
): boolean {
  if (!row?.stripeSubscriptionId) return false;
  return rowInMode(row, mode);
}
