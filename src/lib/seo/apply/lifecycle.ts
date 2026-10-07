import type {
  SeoChangeKind,
  SeoChangeParams,
  SeoChangeStatus,
} from "./types";

// SC-F8: değişiklik yaşam döngüsü (durum geçişleri, anahtarlar, geri çekilme,
// oran penceresi, geri alınabilirlik). Saf dosya; motor tek geçiş tablosunu
// buradan okur.

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

// Onay 7 gün geçerli; Approval.expiresAt ile SeoChange.expiresAt aynı değerdir.
export const SEO_APPLY_APPROVAL_TTL_MS = 7 * DAY;
// Onaylanıp 14 günde uygulanamayan satır EXPIRED olur.
export const SEO_APPLY_APPROVED_STALE_MS = 14 * DAY;
// Onay anında satır içi çalışan uygulamanın bütçesi.
export const SEO_APPLY_INLINE_BUDGET_MS = 20_000 as const;
export const SEO_APPLY_MAX_ATTEMPTS = 3 as const;
export const SEO_APPLY_LEASE_MS = 2 * MINUTE;
// Geri alma uygulamadan sonra 90 gün; ham içerik de o zaman boşaltılır.
export const SEO_UNDO_WINDOW_MS = 90 * DAY;
export const SEO_CHANGE_RETENTION_MS = 730 * DAY;
export const SEO_CONTENT_RAW_KEEP_MS = 90 * DAY;
// Makale metni terminal durumdan 30 gün sonra boşaltılır.
export const SEO_MARKDOWN_KEEP_MS = 30 * DAY;

// Açık (openKey dolu) durumlar: aynı konu için tek açık değişiklik.
export const OPEN_CHANGE_STATUSES: readonly SeoChangeStatus[] = [
  "PROPOSED",
  "APPROVED",
  "APPLYING",
  "APPLIED",
];

export function openKeyFor(
  status: SeoChangeStatus,
  dedupeKey: string,
): string | null {
  return OPEN_CHANGE_STATUSES.includes(status) ? dedupeKey : null;
}

// Tek geçiş tablosu. APPROVED -> APPROVED: oran penceresi dolu, bekliyor;
// APPLIED -> APPLIED: kira / yeniden deneme / kaldığı yerden devam.
const ALLOWED: Record<SeoChangeStatus, readonly SeoChangeStatus[]> = {
  PROPOSED: ["APPROVED", "REJECTED", "EXPIRED"],
  APPROVED: ["APPLYING", "APPROVED", "EXPIRED"],
  APPLYING: ["APPLIED", "VERIFIED", "FAILED", "APPROVED"],
  APPLIED: ["APPLIED", "VERIFIED", "FAILED"],
  VERIFIED: ["UNDOING"],
  FAILED: ["UNDOING"],
  UNDOING: ["UNDONE", "VERIFIED", "FAILED"],
  UNDONE: [],
  REJECTED: [],
  EXPIRED: [],
};

export function canTransitionChange(
  from: SeoChangeStatus,
  to: SeoChangeStatus,
): boolean {
  return ALLOWED[from].includes(to);
}

export function dedupeKeyFor(params: SeoChangeParams): string {
  switch (params.kind) {
    case "PUBLISH_ARTICLE":
      return `publish:${params.creativeId}:${params.versionId}`;
    case "PUBLISH_LIVE":
      return `live:${params.draftChangeId}`;
    case "TITLE_META":
      return `meta:${params.wpType}:${params.wpId}`;
    case "INTERNAL_LINKS":
      return `links:${params.wpType}:${params.wpId}`;
  }
}

// 1. deneme sonrası 2 dk, 2. deneme sonrası 10 dk, sonrası 30 dk; hız sınırı 6 saat.
export function changeBackoffMs(
  attempt: number,
  errorClass: "RATE_LIMIT" | "TRANSIENT" | "SERVER" | "OTHER",
): number {
  if (errorClass === "RATE_LIMIT") return 6 * HOUR;
  const steps = [2 * MINUTE, 10 * MINUTE, 30 * MINUTE];
  const index = Math.min(Math.max(Math.trunc(attempt), 1), steps.length) - 1;
  return steps[index] ?? 30 * MINUTE;
}

// Kayan 24 saat: tam 24 saat önceki uygulama pencerenin dışındadır. Doluysa
// (used >= limit) bir yer açılacak an, sınırı aşan en eski uygulamadan 24 saat
// sonradır (used === limit iken en eski uygulama + 24 saat).
export function rateWindow(
  appliedAts: readonly Date[],
  limit: number,
  now: Date,
): { allowed: boolean; used: number; nextAt: Date | null } {
  const inside = appliedAts
    .map((at) => at.getTime())
    .filter((time) => now.getTime() - time < DAY)
    .sort((a, b) => a - b);
  const used = inside.length;
  if (used < limit) return { allowed: true, used, nextAt: null };
  const freeing = inside[Math.max(used - limit, 0)] ?? inside[0] ?? now.getTime();
  return { allowed: false, used, nextAt: new Date(freeing + DAY) };
}

// Yazılmış (VERIFIED ya da yazısı inmiş FAILED), noop olmayan ve 90 gün içindeki
// değişiklik geri alınabilir.
export function isUndoable(
  change: {
    kind: SeoChangeKind;
    status: SeoChangeStatus;
    noop: boolean;
    appliedAt: Date | null;
  },
  now: Date,
): boolean {
  if (change.noop || !change.appliedAt) return false;
  if (change.status !== "VERIFIED" && change.status !== "FAILED") return false;
  return now.getTime() - change.appliedAt.getTime() <= SEO_UNDO_WINDOW_MS;
}
