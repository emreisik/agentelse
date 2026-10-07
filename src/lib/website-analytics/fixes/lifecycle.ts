import type { GoogleErrorClass } from "@/server/integrations/google/error-catalog";
import type { GaFixStatus } from "./types";

// GA-F7 yaşam döngüsü sabitleri ve geçiş tablosu. P4a, P4b ve P4c'nin tek
// başvuru kaynağı; sunucu tarafı yalnız bu tabloya göre durum değiştirir.
//
// MOTOR GEÇİŞLERİ (tek tablo)
//  Olay                                  | Nereden  | Nereye                           | Not
//  yazmak için al                        | APPROVED | APPLYING                         | CAS: leaseUntil boş/geçmiş VE nextAttemptAt
//                                        |          |                                  | boş/geçmiş; attempts+1; kira +GA_FIX_LEASE_MS.
//                                        |          |                                  | gaFixesEnabledFor ya da gaFixKindEnabled(kind)
//                                        |          |                                  | kapalıysa ALINMAZ: satır APPROVED kalır
//  yalnız doğrulama için al              | APPLIED  | APPLIED (kira dolu)              | boş kirada CAS; yazma yok
//  kapı geçmedi (onay APPROVED değil,    | APPLYING | FAILED (openKey null, failedAt,  | yazıcı ASLA çağrılmaz. Onay kapısı yalnız
//   bağlantı birincil değil/pasif,       |          |  error)                          | status === 'APPROVED'; expiresAt'e bakılmaz
//   düzenleme izni yok, mock uyuşmazlığı)|          |                                  |
//  plan noop                             | APPLYING | VERIFIED (noop=true, before=after)| yazma yok
//  plan reddi limit_reached              | APPLYING | FAILED                           |
//  yazma döndü                           | APPLYING | APPLIED (appliedAt, resourceName)| kira uzar
//  geri okuma tamam                      | APPLIED  | VERIFIED (after, verifiedAt)     | openKey null; sonra son adımlar
//  geri okuma uyuşmadı                   | APPLIED  | FAILED readback_mismatch         | appliedAt kalır, after null
//  create'te 409                         | APPLYING | VERIFIED noop                    | yeniden oku + yeniden planla
//  yazma dönmeden yeniden denenebilir    | APPLYING | APPROVED (nextAttemptAt=now+     | kira bırakılır
//   hata ve attempts < GA_FIX_MAX_ATTEMPTS|         |  fixBackoffMs)                   |
//  3. denemede aynı hata                 | APPLYING | FAILED                           |
//  geri okuma ÇAĞRISINDA hata            | APPLIED  | APPLIED (kira bırakılır, bekle)  | GA_FIX_MAX_ATTEMPTS denemeden sonra
//                                        |          |                                  | FAILED google_unavailable (appliedAt kalır);
//                                        |          |                                  | ikinci yazma asla yok; yazma dönünce attempts 1'e
//                                        |          |                                  | sıfırlanır (geri okumanın ayrı bütçesi)
//  yeniden denenemez hata                | APPLYING | FAILED                           | SCOPE_MISSING ayrıca clearGaEditGrant
//  kira doldu (uzlaştırma)               | APPLYING | APPROVED (appliedAt boşsa),      |
//                                        |          |  değilse APPLIED                 |
//  kira doldu (uzlaştırma)               | UNDOING  | VERIFIED                         |
//  geri alma                             | VERIFIED | UNDOING -> UNDONE                | hatada VERIFIED'a döner, error.undo=true
//  ret / revizyon (syncApprovalState)    | PROPOSED | REJECTED                         | openKey null, Task CANCELLED
//  onay CANCELLED/EXPIRED                | PROPOSED | EXPIRED                          |
//  öneri expiresAt'i geçti               | PROPOSED | EXPIRED                          | Approval PENDING -> EXPIRED, Task CANCELLED
//  onaylı ama 14 gün uygulanmadı         | APPROVED | EXPIRED                          | Task CANCELLED
//  Her terminal geçişte openKey = null. Tüm yazmalar beklenen durumla
//  updateMany (CAS) yapar.

// Onay bekleyen öneri 7 gün sonra kendiliğinden kapanır.
export const GA_FIX_APPROVAL_TTL_MS = 7 * 24 * 60 * 60 * 1000;
// Onaylanıp 14 günde uygulanamayan satır EXPIRED olur.
export const GA_FIX_APPROVED_STALE_MS = 14 * 24 * 60 * 60 * 1000;
// onTaskApproved uygulamayı en çok bu kadar bekler; uygulama arkada sürer.
export const GA_FIX_INLINE_BUDGET_MS = 20000 as const;
export const GA_FIX_MAX_ATTEMPTS = 3 as const;
// Uygulama/geri alma kirası: çöken işlemin satırı 2 dakika sonra serbest kalır.
export const GA_FIX_LEASE_MS = 2 * 60 * 1000;

// openKey yalnız açık durumlarda dolu olur; @@unique([linkId, openKey]) bir
// (bağlantı, tür, konu) için tek açık değişikliği garanti eder.
export const OPEN_FIX_STATUSES: readonly GaFixStatus[] = [
  "PROPOSED",
  "APPROVED",
  "APPLYING",
  "APPLIED",
];

export function openKeyFor(
  status: GaFixStatus,
  dedupeKey: string,
): string | null {
  return OPEN_FIX_STATUSES.includes(status) ? dedupeKey : null;
}

const TRANSITIONS: Record<GaFixStatus, readonly GaFixStatus[]> = {
  PROPOSED: ["APPROVED", "REJECTED", "EXPIRED"],
  APPROVED: ["APPLYING", "FAILED", "EXPIRED"],
  APPLYING: ["APPLIED", "VERIFIED", "FAILED", "APPROVED"],
  APPLIED: ["VERIFIED", "FAILED"],
  VERIFIED: ["UNDOING"],
  UNDOING: ["UNDONE", "VERIFIED"],
  FAILED: [],
  UNDONE: [],
  REJECTED: [],
  EXPIRED: [],
};

export function canTransitionFix(from: GaFixStatus, to: GaFixStatus): boolean {
  return TRANSITIONS[from].includes(to);
}

// Mock süreç yalnız mock bağlantıya, gerçek süreç yalnız gerçek bağlantıya
// dokunur: paylaşılan veritabanında mock bir süreç gerçek bir bağlantının
// anahtar olaylarını ya da saklama süresini asla ezmez.
export function mockMatchesLink(mock: boolean, linkIsMock: boolean): boolean {
  return mock === linkIsMock;
}

const BACKOFF_MS = [2 * 60 * 1000, 10 * 60 * 1000, 30 * 60 * 1000] as const;
const DAILY_QUOTA_BACKOFF_MS = 6 * 60 * 60 * 1000;

// attempt 1'den başlar: 2 dk, 10 dk, 30 dk; günlük kota 6 saat.
export function fixBackoffMs(
  attempt: number,
  errorClass: GoogleErrorClass,
): number {
  if (errorClass === "QUOTA_DAILY") return DAILY_QUOTA_BACKOFF_MS;
  const index = Math.min(Math.max(Math.floor(attempt), 1), BACKOFF_MS.length);
  return BACKOFF_MS[index - 1] ?? DAILY_QUOTA_BACKOFF_MS;
}
