import "server-only";

import type { GaPropertyLink } from "@prisma/client";

import type {
  GaLane,
  GaServerErrors,
  StoredGaQuota,
} from "@/lib/website-analytics/governor";

// Bir bağlantının senkron turu boyunca taşınan durum. Kota durumu turda
// bellekte güncellenir ve her çağrıdan sonra DB'ye de yazılır.
export type GaSyncContext = {
  link: GaPropertyLink;
  accessToken: string;
  timeZone: string;
  // Mülk saatiyle bugün (YYYY-MM-DD).
  today: string;
  now: Date;
  lane: GaLane;
  // Katalogdan düşmüş raporlar (geçersiz alan vb.).
  disabled: Set<string>;
  quota: StoredGaQuota | null;
  serverErrors: GaServerErrors | null;
  rateLimitedUntil: Date | null;
};
