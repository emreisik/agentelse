-- AlterTable
ALTER TABLE "TelegramUserBinding" ALTER COLUMN "telegramUserId" DROP NOT NULL;

-- CreateIndex
CREATE INDEX "TelegramUserBinding_pairingCode_idx" ON "TelegramUserBinding"("pairingCode");
