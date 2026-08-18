-- AlterTable
ALTER TABLE "BrandDossier" ADD COLUMN     "country" TEXT,
ADD COLUMN     "language" TEXT;

-- AlterTable
ALTER TABLE "Project" ADD COLUMN     "country" TEXT NOT NULL DEFAULT 'TR',
ADD COLUMN     "language" TEXT NOT NULL DEFAULT 'tr';

