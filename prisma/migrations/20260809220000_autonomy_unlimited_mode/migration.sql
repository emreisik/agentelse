-- Sınırsız mod bayrağı: günlük tavanları kaldırmadan devre dışı bırakır.
ALTER TABLE "AutonomyPolicy" ADD COLUMN "unlimitedMode" BOOLEAN NOT NULL DEFAULT false;
