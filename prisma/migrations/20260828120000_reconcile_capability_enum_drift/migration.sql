-- Reconciliation pass (see 20260821140000_reconcile_schema_drift for the
-- same pattern): `prisma migrate dev` detected drift before the
-- add_asset_source migration could be generated — the CapabilityKey enum
-- already has these 4 variants live (added via `prisma db push` at some
-- point, per this project's recurring "db push needs a migration file"
-- issue) but no migration file ever recorded them. Values already exist in
-- the live DB; this migration only makes migration history match reality
-- and is marked applied via `prisma migrate resolve --applied`, not run.

-- AlterEnum
ALTER TYPE "CapabilityKey" ADD VALUE IF NOT EXISTS 'META_ADSET_CREATE';
ALTER TYPE "CapabilityKey" ADD VALUE IF NOT EXISTS 'META_AD_CREATE';
ALTER TYPE "CapabilityKey" ADD VALUE IF NOT EXISTS 'META_ADSET_UPDATE';
ALTER TYPE "CapabilityKey" ADD VALUE IF NOT EXISTS 'META_AD_UPDATE';
