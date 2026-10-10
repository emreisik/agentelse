import "server-only";

import { getEnv } from "@/lib/env";

import { getBillingConfig } from "../config";
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
// Stripe imzalama sırrı: whsec_ + en az 24 karakter. "whsec_" ya da "whsec_…" gibi yer
// tutucular kabul edilirse HMAC anahtarı herkesçe bilinir olurdu.
const WEBHOOK_SECRET_SHAPE = /^whsec_[A-Za-z0-9+/=_-]{24,}$/;

function warnOnce(code: string, message: string): void {
  if (warned.has(code)) return;
  warned.add(code);
  console.error(`[billing] ${message}`);
}

// Testler için: tek seferlik uyarıları sıfırla.
export function resetStripeConfigWarnings(): void {
  warned.clear();
}

// Anahtarın kendisi: şekil, mod ve ortam kuralları. Webhook sırrı BURADA aranmaz: abonelik
// süpürmesi ve var olan abonelerin yönetimi yalnız API anahtarına bağlıdır (webhook sırrı
// eksik/yanlış yazıldığında Stripe olayları reddedilirken güvenlik ağı da kapanmasın).
export type StripeKeyConfig = { secretKey: string; mode: StripeMode };

export function getStripeKeyConfig(): StripeKeyConfig | null {
  const env = getEnv();
  const secretKey = (env.STRIPE_SECRET_KEY ?? "").trim();
  if (!secretKey) return null;

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
  // Sınırlar UYGULANIRKEN üretimde TEST anahtarı kapalıdır: herkes test kartıyla
  // (4242 ...) ücretsiz plan alıp tam hak kazanırdı.
  if (
    mode === "test" &&
    process.env.NODE_ENV === "production" &&
    getBillingConfig().mode === "enforce"
  ) {
    warnOnce(
      "test-key-with-enforce",
      "BILLING_MODE=enforce with a Stripe TEST key in production would sell plans for test cards; payments stay closed (use the live key)",
    );
    return null;
  }

  if (mode === "test" && process.env.NODE_ENV === "production") {
    warnOnce(
      "test-key-in-production",
      "a Stripe TEST key is running in production: checkouts charge nothing; switch to the live key before taking real customers",
    );
  }
  return { secretKey, mode };
}

// Tam ödeme yapılandırması (satış + webhook): anahtar VE geçerli webhook sırrı gerekir.
export function getStripeConfig(): StripeConfig | null {
  const env = getEnv();
  const secretKey = (env.STRIPE_SECRET_KEY ?? "").trim();
  const webhookSecret = (env.STRIPE_WEBHOOK_SECRET ?? "").trim();
  if (!secretKey || !webhookSecret) {
    // En olası sahip hatası: biri girilmiş, öteki unutulmuş ya da yanlış adla yazılmış.
    if (secretKey || webhookSecret) {
      const missing = secretKey ? "STRIPE_WEBHOOK_SECRET" : "STRIPE_SECRET_KEY";
      warnOnce(
        `half-configured:${missing}`,
        `${missing} is not set; payments stay closed (set both)`,
      );
    }
    return null;
  }

  const key = getStripeKeyConfig();
  if (!key) return null;
  if (!WEBHOOK_SECRET_SHAPE.test(webhookSecret)) {
    warnOnce(
      "webhook-secret-format",
      "STRIPE_WEBHOOK_SECRET must be the full signing secret (whsec_ + at least 24 characters); payments stay closed",
    );
    return null;
  }

  const previous = (env.STRIPE_WEBHOOK_SECRET_PREVIOUS ?? "").trim();
  return {
    secretKey: key.secretKey,
    webhookSecrets:
      previous && WEBHOOK_SECRET_SHAPE.test(previous)
        ? [webhookSecret, previous]
        : [webhookSecret],
    mode: key.mode,
  };
}

export function isPaymentsConfigured(): boolean {
  return getStripeConfig() !== null;
}
