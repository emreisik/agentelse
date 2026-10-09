import "server-only";

import { getEnv } from "@/lib/env";

import { createStripeHttp } from "../stripe/client";
import { getStripeConfig } from "../stripe/config";
import { createStripeGateway, type StripeGateway } from "../stripe/gateway";
import type { PaymentDeps } from "./service";

// Çalışan ortamın ödeme bağımlılıkları; ödeme kapalıysa (anahtar yok / biçim hatalı)
// null. Ağ geçidi süreç boyunca tek örnektir (ürün/kupon önbelleği orada).

let cached: { key: string; gateway: StripeGateway } | null = null;

export function getPaymentDeps(): PaymentDeps | null {
  const config = getStripeConfig();
  if (!config) return null;
  if (!cached || cached.key !== config.secretKey) {
    cached = {
      key: config.secretKey,
      gateway: createStripeGateway(
        createStripeHttp({ secretKey: config.secretKey }),
      ),
    };
  }
  return {
    gateway: cached.gateway,
    mode: config.mode,
    appUrl: getEnv().NEXT_PUBLIC_APP_URL.replace(/\/+$/, ""),
  };
}
