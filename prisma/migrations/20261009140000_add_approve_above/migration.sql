-- Onay eşiği (Faz 3C): sistemin başlattığı pahalı görevler insan onayı bekler.
-- Yalnız ekleme: sütun boş başlar (boş = paket varsayılanı).

-- AlterTable
ALTER TABLE "AutonomyPolicy" ADD COLUMN "approveAboveUsd" DOUBLE PRECISION;

ALTER TABLE "AutonomyPolicy"
  ADD CONSTRAINT "AutonomyPolicy_approveAboveUsd_check"
    CHECK ("approveAboveUsd" IS NULL OR ("approveAboveUsd" >= 0.1 AND "approveAboveUsd" <= 100));
