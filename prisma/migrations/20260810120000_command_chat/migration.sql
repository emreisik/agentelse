-- Komut yüzeyi sohbet ekranına dönüştü: bir Command artık tek yönlü bir
-- "komut" değil, ekleri ve asistan yanıtı olan bir konuşma turu.
--
-- attachments: [{ assetId, filename, mimeType, size }] — Asset satırlarına
-- yumuşak referans. Gerçek FK yerine JSON: Command çok kiracılı ve
-- workspace/project alanları zaten kısıtsız (bkz. project-deletion.service).
-- replyText/replyStatus: asistanın o tura verdiği yanıt ve sonucu
-- (PLANNED | ANSWERED | APPROVAL_HANDLED | NEEDS_PROJECT | UNCLEAR | ERROR).
ALTER TABLE "Command" ADD COLUMN "attachments" JSONB;
ALTER TABLE "Command" ADD COLUMN "replyText" TEXT;
ALTER TABLE "Command" ADD COLUMN "replyStatus" TEXT;
