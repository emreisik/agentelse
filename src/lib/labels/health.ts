import {
  AlertTriangle,
  Ban,
  CircleSlash,
  Clock,
  CreditCard,
  KeyRound,
  Plug,
  ShieldAlert,
  Settings2,
  Timer,
  Wifi,
} from "lucide-react";

import type { EnumMeta } from "./types";

// Hata kategorileri (src/server/observability/error-classifier.ts) ve
// ProviderHealthStatus için Türkçe etiketler. Tonlar aciliyeti anlatır:
// danger = müdahale gerekir, waiting = kendiliğinden geçebilir.
export const ERROR_CATEGORY: Record<string, EnumMeta> = {
  BILLING: { label: "Bakiye / Kota", tone: "danger", icon: CreditCard },
  AUTH: { label: "Kimlik Doğrulama", tone: "danger", icon: KeyRound },
  RATE_LIMIT: { label: "Hız Sınırı", tone: "waiting", icon: Timer },
  TIMEOUT: { label: "Zaman Aşımı", tone: "waiting", icon: Clock },
  NETWORK: { label: "Ağ", tone: "waiting", icon: Wifi },
  PROVIDER_UNAVAILABLE: {
    label: "Sağlayıcı Yok",
    tone: "danger",
    icon: Plug,
  },
  CONFIGURATION: { label: "Yapılandırma", tone: "danger", icon: Settings2 },
  INVALID_RESULT: {
    label: "Geçersiz Yanıt",
    tone: "waiting",
    icon: CircleSlash,
  },
  REFUSED: { label: "Reddedildi", tone: "special", icon: ShieldAlert },
  UNKNOWN: { label: "Bilinmeyen", tone: "neutral", icon: AlertTriangle },
};

export const RECOVERY_STRATEGY: Record<string, EnumMeta> = {
  RETRY: { label: "Otomatik yeniden denenir", tone: "positive" },
  RETRY_AFTER_COOLDOWN: {
    label: "Soğuma sonrası denenir",
    tone: "waiting",
  },
  NEEDS_CONFIG: { label: "Yapılandırma gerekir", tone: "danger" },
  NEEDS_HUMAN: { label: "İnsan incelemesi gerekir", tone: "special" },
};

export const PROVIDER_HEALTH_STATUS: Record<string, EnumMeta> = {
  AVAILABLE: { label: "Sağlıklı", tone: "positive" },
  DEGRADED: { label: "Bozulmuş", tone: "waiting" },
  RATE_LIMITED: { label: "Hız Sınırlı", tone: "waiting" },
  AUTH_REQUIRED: { label: "Yetki Gerekli", tone: "danger" },
  UNAVAILABLE: { label: "Erişilemiyor", tone: "danger", icon: Ban },
  DISABLED: { label: "Devre Dışı", tone: "neutral" },
};
