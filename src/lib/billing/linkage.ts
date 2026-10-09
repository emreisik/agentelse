// Abonelik satırı ↔ çalışan Stripe anahtarının modu. Saf ve izomorfik (sunucu ve ekran
// modeli aynı kuralı kullanır).

export type StripeModeName = "test" | "live";

// Satır, ÇALIŞAN anahtarın modundaki bir Stripe aboneliğine mi bağlı? Test ve canlı veri
// aynı veritabanını paylaşabilir: başka moddaki bağ bu modda "abonelik yok" sayılır
// (satın alma, plan değiştirme, iptal ve portal o aboneliği bu anahtarla göremez).
// `stripeLivemode` boşsa (eski satır) mod uyuşuyor kabul edilir.
export function linkedForMode(
  row: {
    stripeSubscriptionId: string | null;
    stripeLivemode: boolean | null;
  } | null,
  mode: StripeModeName,
): boolean {
  if (!row?.stripeSubscriptionId) return false;
  return (
    row.stripeLivemode === null || row.stripeLivemode === (mode === "live")
  );
}
