-- Kendi klasöründe: var olan bir enum'a değer eklemek aynı işlemde
-- kullanılamaz (docs/meta-ads-plan.md §4 migration stratejisi).
ALTER TYPE "CapabilityKey" ADD VALUE IF NOT EXISTS 'META_SAFETY_ACTION';
