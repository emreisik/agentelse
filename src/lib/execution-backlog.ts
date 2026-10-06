import type { CapabilityKey } from "@prisma/client";

// Birikim kapısının saf kuralları (docs/meta-ads-plan.md F0a). Sunucu tarafı
// uygulaması src/server/execution/backlog-gate.ts'tedir; birikim raporu
// (prisma/worker-backlog-report.ts) de aynı kuralları buradan okur.

export const STALE_APPROVAL_MS = 24 * 60 * 60_000;
export const STALE_TASK_MS = 72 * 60 * 60_000;
export const STALE_AFTER_OUTAGE_REASON = "Stale after worker outage";
export const STALE_AFTER_OUTAGE_CODE = "STALE_AFTER_OUTAGE";

// Para harcatabilen ya da harcamayı değiştiren Meta yazmaları. Okuma
// (META_ADS_ANALYSIS) bayat olsa da zararsızdır, kapıya girmez.
const META_SPEND_WRITES: ReadonlySet<string> = new Set<CapabilityKey>([
  "META_LAUNCH",
  "META_CAMPAIGN_CREATE",
  "META_CAMPAIGN_UPDATE",
  "META_ADSET_CREATE",
  "META_ADSET_UPDATE",
  "META_AD_CREATE",
  "META_AD_UPDATE",
]);

// Geliştirme ortamında canlı işçiye bırakılan bütün Meta yetenekleri (okuma
// dahil: yerel okuma da canlı uygulamanın kotasını harcar).
export const META_WORKER_CAPABILITIES: readonly CapabilityKey[] = [
  "META_ADS_ANALYSIS",
  "META_SAFETY_ACTION",
  "META_LAUNCH",
  "META_CAMPAIGN_CREATE",
  "META_CAMPAIGN_UPDATE",
  "META_ADSET_CREATE",
  "META_ADSET_UPDATE",
  "META_AD_CREATE",
  "META_AD_UPDATE",
];

export function isMetaSpendWrite(capability: CapabilityKey | string): boolean {
  return META_SPEND_WRITES.has(capability);
}

export type StaleWriteFacts = {
  capability: CapabilityKey | string;
  taskCreatedAt: Date;
  // Görevin en son APPROVED onayının karar anı; onaysız görevde null.
  approvedAt: Date | null;
  now: Date;
};

// Bayatsa nedenini döndürür, değilse null.
export function staleWriteReason(facts: StaleWriteFacts): string | null {
  if (!isMetaSpendWrite(facts.capability)) return null;
  const now = facts.now.getTime();
  if (
    facts.approvedAt &&
    now - facts.approvedAt.getTime() > STALE_APPROVAL_MS
  ) {
    return "approval older than 24 hours";
  }
  if (now - facts.taskCreatedAt.getTime() > STALE_TASK_MS) {
    return "task older than 72 hours";
  }
  return null;
}
