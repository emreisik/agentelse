import "server-only";

import { getEnv } from "@/lib/env";

import { stripeModeOfKey, type StripeMode } from "./key-mode";

export { stripeModeOfKey, type StripeMode };

// Ödeme sağlayıcısı (Stripe) ayarı. Anahtar yoksa ya da biçimi tanınmıyorsa ödeme
// KAPALIDIR (fiyat ekranı salt-okunur): yarım kurulum ne bir müşteriyi Stripe'a
// yollar ne de imzasız bir webhook'u kabul eder.

export type StripeConfig = {
  secretKey: string;
  // Geçerli + (varsa) döndürülmekte olan eski webhook sırrı.
  webhookSecrets: readonly string[];
  mode: StripeMode;
};

const warned = new Set<string>();
function warnOnce(code: string, message: string): void {
  if (warned.has(code)) return;
  warned.add(code);
  console.error(`[billing] ${message}`);
}

// Testler için: tek seferlik uyarıları sıfırla.
export function resetStripeConfigWarnings(): void {
  warned.clear();
}

export function getStripeConfig(): StripeConfig | null {
  const env = getEnv();
  const secretKey = (env.STRIPE_SECRET_KEY ?? "").trim();
  const webhookSecret = (env.STRIPE_WEBHOOK_SECRET ?? "").trim();
  if (!secretKey || !webhookSecret) return null;

  const mode = stripeModeOfKey(secretKey);
  if (!mode) {
    warnOnce(
      "key-format",
      "STRIPE_SECRET_KEY is not a Stripe secret/restricted key (sk_/rk_ + test/live); payments stay closed",
    );
    return null;
  }
  // Geliştirme süreçleri canlı veritabanını paylaşır: canlı anahtarla yerelde
  // yapılan bir deneme gerçek kartı çeker ve gerçek aboneliği yazar.
  if (mode === "live" && process.env.NODE_ENV !== "production") {
    warnOnce(
      "live-key-outside-production",
      "a live Stripe key is set outside production; payments stay closed (use a test key locally)",
    );
    return null;
  }
  if (!webhookSecret.startsWith("whsec_")) {
    warnOnce(
      "webhook-secret-format",
      "STRIPE_WEBHOOK_SECRET must start with whsec_; payments stay closed",
    );
    return null;
  }

  const previous = (env.STRIPE_WEBHOOK_SECRET_PREVIOUS ?? "").trim();
  return {
    secretKey,
    webhookSecrets:
      previous && previous.startsWith("whsec_")
        ? [webhookSecret, previous]
        : [webhookSecret],
    mode,
  };
}

export function isPaymentsConfigured(): boolean {
  return getStripeConfig() !== null;
}
